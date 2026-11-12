// Safe copy of the mailbox, the exports and the payload sources (A2.5; SPEC-01, SPEC-10, SPEC-27). The copier walks with
// `lstat`, never follows a link, opens files with no-follow, and writes new files, so a copy never shares an inode with the source.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { credentialMatch, within } from './paths.mjs';
import { Refusal, safe } from './refusal.mjs';

export const ENTRY_LIMIT = 200000;
const MARKER = '.acoder-staging';
const CHUNK = 65536;
const OPEN_SOURCE = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

// A2.5.1: the staging directory (mode 0700) with a marker; cleanup deletes only a directory whose marker matches.
export function createStaging(parent) {
  const dir = fs.mkdtempSync(path.join(parent, 'acoder-staging-'));
  const runId = randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dir, MARKER), `${runId}\n`, { flag: 'wx', mode: 0o600 });
  return { dir, runId };
}

function makeWritable(directory) {
  const info = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!info?.isDirectory()) return;
  fs.chmodSync(directory, 0o700);
  for (const name of fs.readdirSync(directory)) makeWritable(path.join(directory, name));
}

export function removeStaging(dir, runId) {
  const marker = fs.lstatSync(path.join(dir, MARKER), { throwIfNoEntry: false });
  if (!fs.lstatSync(dir).isDirectory() || !marker?.isFile() || fs.readFileSync(path.join(dir, MARKER), 'utf8').trim() !== runId) {
    throw new Error('refusing to delete a directory that is not this run\'s staging directory');
  }
  makeWritable(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

const describe = info => {
  if (info.isFIFO()) return 'a FIFO';
  if (info.isSocket()) return 'a socket';
  if (info.isBlockDevice()) return 'a block device';
  if (info.isCharacterDevice()) return 'a character device';
  return 'a special file';
};

// What a tree may not contain whatever its kind (A2.5.2): `.git` in any letter case, a credential name, a special file.
export function entryProblem(relative, info) {
  const parts = relative.split('/');
  if (parts.at(-1).toLowerCase() === '.git') return 'a .git entry';
  const credential = credentialMatch(parts.slice(-3));
  if (credential !== null) return `the credential name ${safe(credential)}`;
  if (info.isDirectory() || info.isFile() || info.isSymbolicLink()) return null;
  return describe(info);
}

// A symbolic link is allowed only when its target is relative and resolves, link by link, without leaving the root (A2.5.2, A7.4).
export function linkStaysInside(root, linkDirectory, target) {
  if (target === '' || path.isAbsolute(target) || target.includes('\0')) return false;
  const current = linkDirectory === '' ? [] : linkDirectory.split('/');
  const pending = target.split('/').reverse();
  let follows = 40;
  while (pending.length > 0) {
    const part = pending.pop();
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (current.length === 0) return false;
      current.pop();
      continue;
    }
    let info;
    try { info = fs.lstatSync(path.join(root, ...current, part)); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') { current.push(part); continue; }
      return false;
    }
    if (info.isSymbolicLink()) {
      follows -= 1;
      const next = fs.readlinkSync(path.join(root, ...current, part));
      if (follows < 0 || next === '' || path.isAbsolute(next)) return false;
      pending.push(...next.split('/').reverse());
      continue;
    }
    current.push(part);
  }
  return true;
}

const refuse = (context, problem, relative) => new Refusal(`${problem} at ${safe(relative)} in ${context.label} is not allowed`);

function countEntry(context) {
  context.counters.entries += 1;
  if (context.counters.entries > context.limits.entries) throw new Refusal(`${context.label} brings the snapshot over ${context.limits.entries} entries`);
}

function copyFile(live, copy, info, relative, context, mode) {
  const input = fs.openSync(live, OPEN_SOURCE);
  try {
    const opened = fs.fstatSync(input);
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new Refusal(`${safe(relative)} in ${context.label} changed while it was copied`);
    const output = fs.openSync(copy, 'wx', 0o600);
    try {
      const buffer = Buffer.allocUnsafe(CHUNK);
      for (;;) {
        const read = fs.readSync(input, buffer, 0, CHUNK, null);
        if (read === 0) break;
        context.counters.bytes += read;
        if (context.counters.bytes > context.limits.bytes) throw new Refusal(`the snapshot is larger than --snapshot-max-bytes (${context.limits.bytes} bytes)`);
        fs.writeSync(output, buffer, 0, read);
      }
      fs.fchmodSync(output, mode);
    } finally { fs.closeSync(output); }
  } finally { fs.closeSync(input); }
}

function walk(sourceDir, targetDir, relative, context, exportRoot) {
  for (const name of fs.readdirSync(sourceDir).sort()) {
    const live = path.join(sourceDir, name);
    if (context.excludes?.has(live)) continue;
    const shown = relative === '' ? name : `${relative}/${name}`;
    countEntry(context);
    const info = fs.lstatSync(live);
    const problem = entryProblem(shown, info);
    if (problem !== null) throw refuse(context, problem, shown);
    const copy = path.join(targetDir, name);
    if (info.isDirectory()) {
      const inner = context.exportRoots?.has(live) ? { root: live } : exportRoot;
      fs.mkdirSync(copy, { mode: 0o700 });
      walk(live, copy, shown, context, inner);
      context.modes.push([copy, inner === null ? 0o555 : info.mode & 0o777]);
    } else if (info.isFile()) {
      copyFile(live, copy, info, shown, context, exportRoot === null ? 0o444 : info.mode & 0o777);
    } else {
      if (exportRoot === null) throw refuse(context, 'a symbolic link', shown);
      const target = fs.readlinkSync(live);
      if (!linkStaysInside(exportRoot.root, path.relative(exportRoot.root, sourceDir), target)) throw refuse(context, 'a symbolic link that leaves the export', shown);
      fs.symlinkSync(target, copy);
    }
  }
}

export function applyModes(modes) {
  for (const [target, mode] of [...modes].sort((a, b) => b[0].length - a[0].length)) fs.chmodSync(target, mode);
}

// context: { kind: 'mailbox' | 'export' | 'payload', label, limits: { bytes, entries }, counters: { bytes, entries },
//            excludes?: Set of live paths, exportRoots?: Set of live export roots inside the mailbox, modes?, deferModes? }
export function copyTree(source, target, context) {
  const info = fs.lstatSync(source);
  if (!info.isDirectory()) throw new Refusal(`${context.label} is not a directory`);
  context.modes ??= [];
  fs.mkdirSync(target, { mode: 0o700 });
  const isExport = context.kind === 'export';
  walk(source, target, '', context, isExport ? { root: source } : null);
  context.modes.push([target, isExport ? info.mode & 0o777 : 0o555]);
  if (!context.deferModes) applyModes(context.modes);
}

function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

// --exclude (A1.5): it must exist and must not contain the ticket, the ledger, a manifest or an export, or lie inside an export.
export function resolveExcludes({ mailbox, excludes, ticket, ledger, manifests, exports }) {
  const resolved = new Set();
  for (const relative of excludes) {
    const absolute = path.join(mailbox, relative);
    if (!exists(absolute)) throw new Refusal(`--exclude ${safe(relative)} does not exist in the mailbox`);
    const protectedFiles = [ticket, ledger, ...manifests];
    if (protectedFiles.some(file => within(file, absolute)) || exports.some(dir => within(dir, absolute) || within(absolute, dir))) {
      throw new Refusal(`--exclude ${safe(relative)} must not contain or lie inside the ticket, the ledger, a manifest or an export`);
    }
    resolved.add(absolute);
  }
  return resolved;
}

// A2.5.2 to A2.5.7 and A2.3.4: copies of the mailbox, of each export outside it and of the reviewer skill, and the nested
// mount points for the three writable paths. Returns where everything is.
export function takeSnapshot({ staging, mailbox, exports, excludes, writable, skill, limits }) {
  const counters = { bytes: 0, entries: 0 };
  const modes = [];
  const common = { limits: { bytes: limits.bytes, entries: ENTRY_LIMIT }, counters, modes, deferModes: true };
  const mailboxCopy = path.join(staging.dir, 'mailbox');
  copyTree(mailbox, mailboxCopy, {
    ...common, kind: 'mailbox', label: 'the mailbox', excludes,
    exportRoots: new Set(exports.filter(entry => within(entry.dir, mailbox)).map(entry => entry.dir)),
  });
  const copies = {};
  for (const { role, dir } of exports) {
    if (within(dir, mailbox)) { copies[role] = path.join(mailboxCopy, path.relative(mailbox, dir)); continue; }
    copies[role] = path.join(staging.dir, `export-${role}`);
    copyTree(dir, copies[role], { ...common, kind: 'export', label: `export ${role}` });
  }
  const stageCopy = path.join(mailboxCopy, path.relative(mailbox, writable.stage));
  fs.mkdirSync(path.join(stageCopy, path.basename(writable.scratch)), { mode: 0o700 });
  modes.push([path.join(stageCopy, path.basename(writable.scratch)), 0o555]);
  for (const report of [writable.reportMd, writable.reportJson]) fs.writeFileSync(path.join(stageCopy, path.basename(report)), '', { flag: 'wx', mode: 0o444 });
  const skillCopy = path.join(staging.dir, 'agent-payload', 'skill');
  fs.mkdirSync(path.dirname(skillCopy), { mode: 0o700 });
  copyTree(skill, skillCopy, { ...common, kind: 'payload', label: 'the reviewer skill folder' });
  modes.push([path.dirname(skillCopy), 0o555]);
  applyModes(modes);
  return { mailbox: mailboxCopy, exports: copies, skill: skillCopy, bytes: counters.bytes, entries: counters.entries };
}
