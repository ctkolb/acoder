// Path, home, credential, mailbox and reserved-target rules (A2.3, A2.4, A2.6, A2.7). Every violation is a Refusal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Refusal, safe } from './refusal.mjs';

export const RESERVED_TARGETS = ['/acoder', '/work', '/agent', '/tmp', '/proc', '/sys', '/dev', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/run', '/var/run'];
const SINGLE_CREDENTIALS = ['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', '.claude', '.codex', '.password-store', '.terraform.d', '.oci', '.pki', 'keychains'];
const SEQUENCE_CREDENTIALS = ['.config/gcloud', '.config/gh', '.config/git', '.config/op', '.config/opencode', '.config/containers', '.local/share/opencode', '.local/share/containers'].map(name => name.split('/'));
const FILE_CREDENTIALS = ['.netrc', '.git-credentials', '.npmrc', '.pypirc', '.pgpass'];
const TAG = /^[A-Za-z0-9._-]+$/;
export const TICKET_ENTRY_LIMIT = 200000;

export const within = (child, parent) => child === parent || child.startsWith(parent === '/' ? '/' : `${parent}/`);
const inside = (child, parent) => child !== parent && within(child, parent);
const related = (a, b) => within(a, b) || within(b, a);

export const isReservedTarget = (target, extra = []) => target === '/' || [...RESERVED_TARGETS, ...extra].some(reserved => within(target, reserved));

// A2.6 rule 4, without regard to letter case: a credential name as a component, or as consecutive components
// (the list names `.config/gcloud` and also `.local/share/opencode`).
export function credentialMatch(components) {
  const lower = components.map(part => part.toLowerCase());
  for (const [index, part] of lower.entries()) {
    if (SINGLE_CREDENTIALS.includes(part) || FILE_CREDENTIALS.includes(part)) return components[index];
    for (const sequence of SEQUENCE_CREDENTIALS) {
      const start = index - sequence.length + 1;
      if (start >= 0 && sequence.every((name, offset) => lower[start + offset] === name)) return components.slice(start, index + 1).join('/');
    }
  }
  return null;
}

// A2.6 rules 1, 2 and 4 on strings. `home` is the real path of the account home directory.
export function homeRuleViolation(source, home) {
  if (source === home) return { rule: 1, message: 'is the home directory' };
  if (within(home, source)) return { rule: 2, message: 'contains the home directory' };
  const credential = credentialMatch(source.split('/').filter(Boolean));
  if (credential !== null) return { rule: 4, message: `has the credential name ${safe(credential)} in its path` };
  return null;
}

export function checkHomeRule(source, home, label) {
  const violation = homeRuleViolation(source, home);
  if (violation !== null) throw new Refusal(`${label} ${violation.message} (home rule ${violation.rule})`);
}

// "Home" is the real path of the account's home directory; $HOME, when set, must resolve to the same place.
export function resolveHome(env, deps = {}) {
  const real = value => { try { return fs.realpathSync(value); } catch { return value; } };
  const home = real(deps.home ?? os.userInfo().homedir);
  if (env.HOME !== undefined && env.HOME !== '' && real(env.HOME) !== home) throw new Refusal('$HOME does not resolve to the account home directory');
  return home;
}

export function checkNoGitEntry(directory, label) {
  if (fs.readdirSync(directory).some(name => name.toLowerCase() === '.git')) throw new Refusal(`${label} has a .git entry (home rule 5)`);
}

// A2.4.1 and A2.4.4: absolute, free of mount-syntax characters and equal to its own real path.
export function checkInputPath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Refusal(`${label} must be an absolute path`);
  if (/[,"\\\u0000-\u001f\u007f]/u.test(value)) throw new Refusal(`${label} contains a comma, a double quote, a backslash or a control character`);
  let real;
  try { real = fs.realpathSync(value); } catch { throw new Refusal(`${label} does not exist: ${safe(value)}`); }
  if (real !== value) throw new Refusal(`${label} must equal its real path (no .., no ., no symbolic link, no trailing slash): ${safe(value)}`);
  return value;
}

function checkKind(value, label, kind) {
  const info = fs.lstatSync(value);
  if (kind === 'file' ? !info.isFile() : !info.isDirectory()) throw new Refusal(`${label} must be ${kind === 'file' ? 'a regular file' : 'a directory'}`);
}

// A2.4.2: the file name gives the tag; A2.3.1: the three writable paths come from the tag only.
export function writablePaths(ticket) {
  const match = /^ticket-(.+)\.md$/.exec(path.basename(ticket));
  if (match === null) throw new Refusal('--ticket must be named ticket-<tag>.md');
  const tag = match[1];
  if (tag.length > 120 || !TAG.test(tag)) throw new Refusal('the ticket tag must match [A-Za-z0-9._-]+ and have at most 120 characters');
  const stage = path.dirname(ticket);
  return {
    tag, stage, scratch: path.join(stage, `scratch-${tag}`), reportMd: path.join(stage, `report-${tag}.md`), reportJson: path.join(stage, `report-${tag}.json`),
    runRecord: path.join(stage, `run-${tag}.json`), startedRecord: path.join(stage, `run-${tag}.started.json`),
  };
}

// A2.4.6 (SPEC-10, SPEC-21).
export function checkOverlap({ mailbox, exports, manifests, scratch, reportMd, reportJson, staging }) {
  for (const { role, dir } of exports) {
    if (within(mailbox, dir)) throw new Refusal(`export ${role} equals or contains the mailbox`);
    for (const [name, other] of [['the scratch path', scratch], ['a report path', reportMd], ['a report path', reportJson]]) {
      if (related(dir, other)) throw new Refusal(`export ${role} equals, contains or lies inside ${name}`);
    }
    for (const second of exports) {
      if (second.role !== role && related(dir, second.dir)) throw new Refusal(`export ${role} equals, contains or lies inside export ${second.role}`);
    }
    if (related(staging, dir)) throw new Refusal(`the staging directory equals, contains or lies inside export ${role}`);
  }
  for (const { role, file } of manifests) {
    if (exports.some(entry => within(file, entry.dir))) throw new Refusal(`the manifest of ${role} lies inside an export`);
    if (within(file, scratch)) throw new Refusal(`the manifest of ${role} lies inside the scratch path`);
    if (!inside(file, mailbox)) throw new Refusal(`the manifest of ${role} lies outside the mailbox`);
  }
  if (related(staging, mailbox)) throw new Refusal('the staging directory equals, contains or lies inside the mailbox');
}

// A2.3.3: refused before any effect.
export function checkWritableAbsent(writable) {
  for (const file of [writable.scratch, writable.reportMd, writable.reportJson, writable.runRecord, writable.startedRecord]) {
    if (fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined) throw new Refusal(`${safe(file)} already exists`);
  }
}

// A2.7.1
export function checkOwnMailbox(mailbox) {
  let ledger;
  try {
    const directory = fs.lstatSync(path.join(mailbox, 'orchestrator'), { throwIfNoEntry: false });
    ledger = directory?.isDirectory() ? fs.lstatSync(path.join(mailbox, 'orchestrator', 'tickets.json'), { throwIfNoEntry: false }) : undefined;
  } catch { throw new Refusal(`cannot read ${safe(path.join(mailbox, 'orchestrator'))} while checking the run mailbox`); }
  if (!ledger?.isFile()) throw new Refusal(`${safe(mailbox)} is not a run mailbox (no orchestrator/tickets.json)`);
}

// A2.7.2: another directory named `orchestrator` that holds `tickets.json`, at any depth, never following links.
export function findNestedMailbox(root, { ownRoot = false, prefix = '' } = {}) {
  const stack = [''];
  let seen = 0;
  while (stack.length > 0) {
    const relative = stack.pop();
    const directory = relative === '' ? root : path.join(root, relative);
    let names;
    try { names = fs.readdirSync(directory, { withFileTypes: true }); } catch { throw new Refusal(`cannot read ${safe(path.join(prefix, relative))} while searching for another mailbox`); }
    for (const entry of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      seen += 1;
      if (seen > TICKET_ENTRY_LIMIT) throw new Refusal(`more than ${TICKET_ENTRY_LIMIT} entries under ${safe(prefix || root)}`);
      if (!entry.isDirectory()) continue;
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.name === 'orchestrator' && !(ownRoot && relative === '')) {
        let inside = false;
        try { inside = fs.readdirSync(path.join(root, child)).includes('tickets.json'); } catch { throw new Refusal(`cannot read ${safe(path.posix.join(prefix, child))} while searching for another mailbox`); }
        if (inside) return path.posix.join(prefix, child);
      }
      stack.push(child);
    }
  }
  return null;
}

// Every path rule that needs no copy of the inputs. Returns what the next step needs.
export function checkLaunchPaths(options, env, deps = {}) {
  const home = resolveHome(env, deps);
  const checkSource = (value, label, kind) => {
    checkInputPath(value, label);
    checkKind(value, label, kind);
    checkHomeRule(value, home, label);
    return value;
  };
  checkSource(options.ticket, '--ticket', 'file');
  checkSource(options.mailbox, '--mailbox', 'directory');
  for (const { role, dir } of options.exports) checkSource(dir, `--export ${role}`, 'directory');
  for (const [role, file] of Object.entries(options.manifests)) checkSource(file, `--manifest ${role}`, 'file');
  const skill = options.reviewerSkill ?? fs.realpathSync(new URL('../../skills/acoder-reviewer', import.meta.url));
  const stagingParent = options.stagingDir ?? fs.realpathSync(os.tmpdir());
  checkSource(skill, '--reviewer-skill', 'directory');
  checkSource(stagingParent, '--staging-dir', 'directory');
  if (options.extraCaCert !== null) checkSource(options.extraCaCert, '--extra-ca-cert', 'file');
  if (options.config !== null) checkSource(options.config, '--config', 'file');
  for (const [label, value] of [['--mailbox', options.mailbox], ...options.exports.map(({ role, dir }) => [`--export ${role}`, dir])]) {
    if (isReservedTarget(value, deps.extraReserved)) throw new Refusal(`${label} is a reserved container target or inside one`);
  }
  checkOwnMailbox(options.mailbox);
  if (path.dirname(path.dirname(options.ticket)) !== options.mailbox) throw new Refusal('--ticket must lie exactly two levels below --mailbox (<mailbox>/<stage>/ticket-<tag>.md)');
  const writable = writablePaths(options.ticket);
  checkOverlap({
    mailbox: options.mailbox, exports: options.exports, manifests: Object.entries(options.manifests).map(([role, file]) => ({ role, file })),
    scratch: writable.scratch, reportMd: writable.reportMd, reportJson: writable.reportJson, staging: stagingParent,
  });
  checkWritableAbsent(writable);
  const nested = findNestedMailbox(options.mailbox, { ownRoot: true });
  if (nested !== null) throw new Refusal(`the mailbox path contains another mailbox at ${safe(nested)}`);
  for (const { role, dir } of options.exports) {
    if (within(dir, options.mailbox)) continue;
    const found = findNestedMailbox(dir, { prefix: `export-${role}` });
    if (found !== null) throw new Refusal(`the mailbox path contains another mailbox at ${safe(found)}`);
  }
  for (const [label, directory] of [['--mailbox', options.mailbox], ...options.exports.map(({ role, dir }) => [`--export ${role}`, dir]), ['--reviewer-skill', skill]]) checkNoGitEntry(directory, label);
  return { home, writable, skill, stagingParent };
}
