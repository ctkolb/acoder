// SHA-256, the export manifest (format 2) and the verification of an export against it (A7).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { within } from './paths.mjs';
import { Refusal, safe } from './refusal.mjs';
import { ENTRY_LIMIT, entryProblem, linkStaysInside } from './snapshot.mjs';

const OPEN_SOURCE = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const FORMAT = 'acoder-export-manifest/2';
const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PAIRS = { file: [['100644', '0444'], ['100755', '0555']], dir: [['040000', '0555']] };
const KIND_TEXT = {
  extra: 'not in the manifest', missing: 'missing from the export', type: 'different type', mode: 'different mode', root_mode: 'different root mode',
  sha256: 'different sha256', link_target: 'different link target', link_escape: 'link leaves the export',
};
const MAX_SHOWN = 20;

export const modeText = info => (info.mode & 0o777).toString(8).padStart(4, '0');

export function sha256File(file) {
  const input = fs.openSync(file, OPEN_SOURCE);
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(65536);
    for (;;) {
      const read = fs.readSync(input, buffer, 0, buffer.length, null);
      if (read === 0) return hash.digest('hex');
      hash.update(buffer.subarray(0, read));
    }
  } finally { fs.closeSync(input); }
}

// Reads a small regular file without following a link.
export function readSmallFile(file, label, maxBytes) {
  const input = fs.openSync(file, OPEN_SOURCE);
  try {
    const info = fs.fstatSync(input);
    if (!info.isFile()) throw new Refusal(`${label} is not a regular file`);
    if (info.size > maxBytes) throw new Refusal(`${label} is larger than ${maxBytes} bytes`);
    const buffer = Buffer.alloc(info.size);
    let filled = 0;
    while (filled < info.size) {
      const read = fs.readSync(input, buffer, filled, info.size - filled, null);
      if (read === 0) break;
      filled += read;
    }
    return buffer.toString('utf8', 0, filled);
  } finally { fs.closeSync(input); }
}

const has = (object, keys) => Object.keys(object).sort().join() === [...keys].sort().join();

function checkEntry(entry, index) {
  const fail = why => new Refusal(`manifest entry ${index + 1} ${why}`);
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw fail('is not an object');
  const shapes = { file: ['path', 'type', 'mode', 'source_mode', 'sha256'], dir: ['path', 'type', 'mode', 'source_mode'], symlink: ['path', 'type', 'target', 'source_mode'] };
  if (!Object.hasOwn(shapes, entry.type)) throw fail('has an unknown type');
  if (!has(entry, shapes[entry.type])) throw fail(`must have exactly the fields ${shapes[entry.type].join(', ')}`);
  if (typeof entry.path !== 'string' || entry.path.startsWith('/') || /[\u0000-\u001f\u007f\\]/u.test(entry.path) || entry.path.split('/').some(part => part === '' || part === '.' || part === '..')) throw fail('has a path that is not relative with / separators');
  if (entry.type === 'symlink') {
    if (typeof entry.target !== 'string' || entry.target === '' || entry.source_mode !== '120000') throw fail('is a link without a valid target or with another source_mode');
    return;
  }
  if (!PAIRS[entry.type].some(([source, mode]) => entry.source_mode === source && entry.mode === mode)) throw fail(`has a mode pair ${safe(entry.source_mode)}/${safe(entry.mode)} that is not accepted`);
  if (entry.type === 'file' && !HEX64.test(entry.sha256)) throw fail('has a sha256 that is not 64 lower-case hex characters');
}

// A7.2: the manifest, strictly. Returns the parsed object.
export function parseManifest(text) {
  let manifest;
  try { manifest = JSON.parse(text); } catch { throw new Refusal('the manifest is not valid JSON'); }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Refusal('the manifest is not a JSON object');
  if (!has(manifest, ['format', 'source_commit', 'source_commit_provenance', 'root_mode', 'entries'])) throw new Refusal('the manifest must have exactly the fields format, source_commit, source_commit_provenance, root_mode, entries');
  if (manifest.format !== FORMAT) throw new Refusal(`the manifest format must be ${FORMAT}`);
  if (typeof manifest.source_commit !== 'string' || !COMMIT.test(manifest.source_commit)) throw new Refusal('the manifest source_commit must be 40 or 64 lower-case hex characters');
  if (manifest.source_commit_provenance !== 'asserted') throw new Refusal('the manifest source_commit_provenance must be "asserted"');
  if (manifest.root_mode !== '0555') throw new Refusal('the manifest root_mode must be "0555"');
  if (!Array.isArray(manifest.entries)) throw new Refusal('the manifest entries must be a list');
  manifest.entries.forEach(checkEntry);
  for (let index = 1; index < manifest.entries.length; index += 1) {
    if (!(manifest.entries[index - 1].path < manifest.entries[index].path)) throw new Refusal(`manifest entry ${index + 1} is not in strictly ascending path order (unique, sorted by code unit)`);
  }
  return manifest;
}

const typeOf = info => (info.isDirectory() ? 'dir' : info.isFile() ? 'file' : info.isSymbolicLink() ? 'symlink' : 'other');

// A7.4 on a copy: lstat only, no link followed. Returns [{ kind, path }] sorted by path.
export function verifyExport(root, manifest) {
  const expected = new Map(manifest.entries.map(entry => [entry.path, entry]));
  const seen = new Set();
  const found = [];
  if (modeText(fs.lstatSync(root)) !== manifest.root_mode) found.push({ kind: 'root_mode', path: '.' });
  const walk = (directory, relative) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const live = path.join(directory, name);
      const shown = relative === '' ? name : `${relative}/${name}`;
      const entry = expected.get(shown);
      const info = fs.lstatSync(live);
      if (entry === undefined) { found.push({ kind: 'extra', path: shown }); continue; }
      seen.add(shown);
      const type = typeOf(info);
      if (type !== entry.type) { found.push({ kind: 'type', path: shown }); continue; }
      if (type === 'dir') {
        if (modeText(info) !== entry.mode) found.push({ kind: 'mode', path: shown });
        walk(live, shown);
      } else if (type === 'file') {
        if (modeText(info) !== entry.mode) found.push({ kind: 'mode', path: shown });
        if (sha256File(live) !== entry.sha256) found.push({ kind: 'sha256', path: shown });
      } else {
        const target = fs.readlinkSync(live);
        if (target !== entry.target) found.push({ kind: 'link_target', path: shown });
        if (!linkStaysInside(root, path.relative(root, directory), target)) found.push({ kind: 'link_escape', path: shown });
      }
    }
  };
  walk(root, '');
  for (const entry of manifest.entries) if (!seen.has(entry.path)) found.push({ kind: 'missing', path: entry.path });
  return found.sort((a, b) => (a.path === b.path ? (a.kind < b.kind ? -1 : 1) : a.path < b.path ? -1 : 1));
}

// A7.5: the role, the kinds of mismatch and at most 20 differing paths, on one line.
export function mismatchMessage(role, mismatches) {
  const shown = mismatches.slice(0, MAX_SHOWN);
  const groups = Object.keys(KIND_TEXT).map(kind => [kind, shown.filter(item => item.kind === kind)]).filter(([, items]) => items.length > 0);
  const text = groups.map(([kind, items]) => `${KIND_TEXT[kind]}: ${items.map(item => safe(item.path)).join(', ')}`).join('; ');
  return `export ${role} does not match its manifest (${mismatches.length} differing paths${mismatches.length > MAX_SHOWN ? `, first ${MAX_SHOWN} shown` : ''}): ${text}`;
}

// The hash of a tree: path, type, permission bits and content hash or link target, for every entry and the root.
export function treeHash(root) {
  const lines = [`.\0dir\0${modeText(fs.lstatSync(root))}\0`];
  const walk = (directory, relative) => {
    for (const name of fs.readdirSync(directory)) {
      const live = path.join(directory, name);
      const shown = relative === '' ? name : `${relative}/${name}`;
      const info = fs.lstatSync(live);
      const type = typeOf(info);
      const detail = type === 'file' ? sha256File(live) : type === 'symlink' ? fs.readlinkSync(live) : '';
      lines.push(`${shown}\0${type}\0${type === 'symlink' ? '' : modeText(info)}\0${detail}`);
      if (type === 'dir') walk(live, shown);
    }
  };
  walk(root, '');
  return createHash('sha256').update(`${lines.sort().join('\n')}\n`).digest('hex');
}

const notReadOnly = what => new Refusal(`the export is not in read-only form: ${what}`);

// A7.6: `acoder export manifest`. The caller asserts the commit; no Git command is run.
export function writeManifest({ exportDir, sourceCommit, out }) {
  if (!COMMIT.test(sourceCommit)) throw new Refusal('--source-commit must be 40 or 64 lower-case hex characters');
  const rootInfo = fs.lstatSync(exportDir, { throwIfNoEntry: false });
  if (!rootInfo?.isDirectory() || fs.realpathSync(exportDir) !== exportDir) throw new Refusal('--export must be a directory that equals its real path');
  if (within(out, exportDir)) throw new Refusal('--out lies inside the export');
  const parent = path.dirname(out);
  if (!fs.lstatSync(parent, { throwIfNoEntry: false })?.isDirectory() || fs.realpathSync(parent) !== parent) throw new Refusal('the directory of --out must exist and equal its real path');
  if (fs.lstatSync(out, { throwIfNoEntry: false }) !== undefined) throw new Refusal('--out already exists');
  if (modeText(rootInfo) !== '0555') throw notReadOnly(`the root directory has mode ${modeText(rootInfo)}`);
  const entries = [];
  const walk = (directory, relative) => {
    for (const name of fs.readdirSync(directory)) {
      const live = path.join(directory, name);
      const shown = relative === '' ? name : `${relative}/${name}`;
      if (entries.length >= ENTRY_LIMIT) throw new Refusal(`the export has more than ${ENTRY_LIMIT} entries`);
      const info = fs.lstatSync(live);
      const problem = entryProblem(shown, info);
      if (problem !== null) throw new Refusal(`${problem} at ${safe(shown)} in the export is not allowed`);
      const type = typeOf(info);
      if (type === 'symlink') {
        const target = fs.readlinkSync(live);
        if (!linkStaysInside(exportDir, path.relative(exportDir, directory), target)) throw new Refusal(`the symbolic link ${safe(shown)} leaves the export`);
        entries.push({ path: shown, type, target, source_mode: '120000' });
        continue;
      }
      const mode = modeText(info);
      const pair = PAIRS[type].find(([, accepted]) => accepted === mode);
      if (pair === undefined) throw notReadOnly(`${safe(shown)} has mode ${mode}`);
      if (type === 'dir') { entries.push({ path: shown, type, mode, source_mode: pair[0] }); walk(live, shown); }
      else entries.push({ path: shown, type, mode, source_mode: pair[0], sha256: sha256File(live) });
    }
  };
  walk(exportDir, '');
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  const text = `${JSON.stringify({ format: FORMAT, source_commit: sourceCommit, source_commit_provenance: 'asserted', root_mode: '0555', entries }, null, 2)}\n`;
  fs.writeFileSync(out, text, { flag: 'wx', mode: 0o644 });
  return createHash('sha256').update(text).digest('hex');
}
