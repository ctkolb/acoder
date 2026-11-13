// Fixtures for the launcher tests. Every fixture is a fresh directory under a realpath'ed temporary base (outside the
// reserved container targets), created at test time and removed afterwards. No test reads or writes the home directory,
// the repository root (except the launcher's own files) or a real mailbox, and none starts a container.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapters } from '../../adapters/index.mjs';
import { providers } from '../../providers/index.mjs';
import * as stub from './stub-adapter.mjs';

// The result of a call, or a failed assertion (never a bare Error) when it throws: tests of modules under test call them through this.
export const must = fn => { try { return fn(); } catch (error) { if (error?.code === 'ERR_ASSERTION') throw error; assert.fail(`threw: ${String(error?.message ?? error)}`); } };
export const mustAsync = async fn => { try { return await fn(); } catch (error) { if (error?.code === 'ERR_ASSERTION') throw error; assert.fail(`threw: ${String(error?.message ?? error)}`); } };
export const attempt = fn => { try { return fn(); } catch (error) { return { thrown: String(error.message) }; } };
// The message a call throws, or null when it does not throw (a refusal test then fails on its assertion, not on a TypeError).
export const thrownOf = fn => { try { fn(); return null; } catch (error) { return String(error.message); } };
// One JSON document, or a failed assertion (not a SyntaxError) when the output is something else.
export const parseJson = text => { try { return JSON.parse(text); } catch { assert.fail(`not one JSON document: ${String(text).slice(0, 120)}`); } };
// Removes a prepared run's staging directory; a failure is an assertion failure.
export const release = result => { try { result?.cleanup?.(); } catch (error) { assert.fail(`cleanup failed: ${error.message}`); } };
export const sha = data => createHash('sha256').update(data).digest('hex');
export const BIN = new URL('../../bin/acoder.mjs', import.meta.url).pathname;
export const LAUNCHER = new URL('../..', import.meta.url).pathname;

// `/tmp` is a reserved container target (A2.4.5), so a mailbox cannot live there: use the temporary directory when it is
// elsewhere (macOS) and `/var/tmp` otherwise (Linux).
export function fixtureBase() {
  for (const candidate of [os.tmpdir(), '/var/tmp']) {
    try {
      const real = fs.realpathSync(candidate);
      if (real !== '/tmp' && !real.startsWith('/tmp/')) return real;
    } catch { /* try the next candidate */ }
  }
  throw new Error('no fixture base outside the reserved container targets');
}

export function forceRemove(dir) {
  const open = directory => {
    let st;
    try { st = fs.lstatSync(directory); } catch { return; }
    if (!st.isDirectory()) return;
    fs.chmodSync(directory, 0o700);
    for (const name of fs.readdirSync(directory)) open(path.join(directory, name));
  };
  open(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Recursive listing with modes, link counts, link targets and content hashes: the "before and after" comparison of the
// refusal tests (no effect means the listing is equal).
export function listing(dir) {
  const out = [];
  const walk = (directory, relative) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const shown = relative ? `${relative}/${name}` : name;
      const st = fs.lstatSync(full);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isDirectory()) { out.push(`${shown}/ d ${mode}`); walk(full, shown); }
      else if (st.isSymbolicLink()) out.push(`${shown} l ${fs.readlinkSync(full)}`);
      else if (st.isFile()) out.push(`${shown} f ${mode} ${st.nlink} ${sha(fs.readFileSync(full))}`);
      else out.push(`${shown} other`);
    }
  };
  walk(dir, '');
  return out;
}

// Runs `fn` while `directory` is writable, then restores its mode.
export function withWritable(directory, fn) {
  const mode = fs.lstatSync(directory).mode & 0o777;
  fs.chmodSync(directory, 0o755);
  try { return fn(); } finally { fs.chmodSync(directory, mode); }
}

export function buildExportTree(dir) {
  const put = (rel, text, mode) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    fs.chmodSync(file, mode);
  };
  put('src/a.py', 'print(1)\n', 0o444);
  put('bin/run', '#!/bin/sh\n', 0o555);
  put('docs/readme.txt', 'docs\n', 0o444);
  fs.symlinkSync('src/a.py', path.join(dir, 'link'));
  for (const sub of ['src', 'bin', 'docs']) fs.chmodSync(path.join(dir, sub), 0o555);
  fs.chmodSync(dir, 0o555);
}

// The test's own oracle for a manifest of format 2 (it does not use the launcher's writer).
export function buildManifestText(dir, commit = 'a'.repeat(40), transform = value => value) {
  const entries = [];
  const walk = (directory, relative) => {
    for (const name of fs.readdirSync(directory)) {
      const full = path.join(directory, name);
      const shown = relative ? `${relative}/${name}` : name;
      const st = fs.lstatSync(full);
      const octal = (st.mode & 0o777).toString(8).padStart(4, '0');
      if (st.isDirectory()) { entries.push({ path: shown, type: 'dir', mode: octal, source_mode: '040000' }); walk(full, shown); }
      else if (st.isSymbolicLink()) entries.push({ path: shown, type: 'symlink', target: fs.readlinkSync(full), source_mode: '120000' });
      else entries.push({ path: shown, type: 'file', mode: octal, source_mode: octal === '0555' ? '100755' : '100644', sha256: sha(fs.readFileSync(full)) });
    }
  };
  walk(dir, '');
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = { format: 'acoder-export-manifest/2', source_commit: commit, source_commit_provenance: 'asserted', root_mode: '0555', entries };
  return `${JSON.stringify(transform(manifest), null, 2)}\n`;
}

const FLAG_ONLY = new Set(['--dry-run', '--no-export']);

// options: exports [{role, place: 'outside' | 'inside'}], mailboxName, tag, noExport, transform(role, manifest)
export function makeFixture(options = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fixtureBase(), 'acoder-t-')));
  const tag = options.tag ?? 'fx-S2-r1';
  const run = path.join(base, options.mailboxName ?? 'run');
  const stage = path.join(run, 'S2');
  const staging = path.join(base, 'stage-tmp');
  const writable = { stage, scratch: path.join(stage, `scratch-${tag}`), reportMd: path.join(stage, `report-${tag}.md`), reportJson: path.join(stage, `report-${tag}.json`) };
  for (const dir of [path.join(run, 'orchestrator'), stage, path.join(run, 'S1'), staging, path.join(base, 'skill', 'references')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(base, 'skill', 'SKILL.md'), 'reviewer skill\n');
  fs.writeFileSync(path.join(base, 'skill', 'references', 'role.md'), 'role\n');
  fs.writeFileSync(path.join(run, 'S1', 'note.md'), 'a note\n');
  const ticketPath = path.join(stage, `ticket-${tag}.md`);
  const ticketText = `TICKET ${tag}\nTo: REVIEWER      Mode: REVIEW\nWrite only here:\n${writable.scratch}\n${writable.reportMd}\n${writable.reportJson}\n`;
  fs.writeFileSync(ticketPath, ticketText);
  const ledger = { tickets: [
    { tag, role: 'REVIEWER', state: 'pending', ticket: ticketPath },
    { tag: 'other-tag', role: 'BUILDER', state: 'completed' },
  ] };
  fs.writeFileSync(path.join(run, 'orchestrator', 'tickets.json'), `${JSON.stringify(ledger, null, 2)}\n`);

  const exportList = [];
  for (const { role, place = 'outside' } of options.noExport ? [] : (options.exports ?? [{ role: 'code' }])) {
    const dir = place === 'inside' ? path.join(stage, `export-${role}`) : path.join(base, 'exp', role);
    fs.mkdirSync(dir, { recursive: true });
    buildExportTree(dir);
    const manifest = path.join(stage, `manifest-${role}.json`);
    const text = buildManifestText(dir, 'a'.repeat(40), options.transform ? value => options.transform(role, value) : undefined);
    fs.writeFileSync(manifest, text);
    exportList.push({ role, dir, manifest, manifestSha: sha(text), place });
  }

  const key = randomBytes(24).toString('base64url');
  const fx = {
    base, tag, run, mailbox: run, stage, staging, ticket: ticketPath, ticketText, ticketSha: sha(ticketText), writable,
    exports: exportList, key, skill: path.join(base, 'skill'), ledger: path.join(run, 'orchestrator', 'tickets.json'),
    env: { ACODER_MODEL_API_KEY: key },
    export: role => exportList.find(entry => entry.role === role),
    cleanup: () => forceRemove(base),
  };
  fx.tokens = () => {
    const tokens = [
      ['--ticket', ticketPath], ['--ticket-sha256', fx.ticketSha], ['--mailbox', run],
      ...(exportList.length === 0 ? [['--no-export']] : exportList.flatMap(e => [['--export', `${e.role}=${e.dir}`], ['--manifest', `${e.role}=${e.manifest}`], ['--manifest-sha256', `${e.role}=${e.manifestSha}`]])),
      ['--image', `sha256:${'b'.repeat(64)}`], ['--model-endpoint', 'https://models.example.org/v1'],
      ['--budget-minutes', '5'], ['--budget-calls', '10'], ['--budget-tokens', '1000'],
      ['--reviewer-skill', fx.skill], ['--staging-dir', staging], ['--dry-run'],
    ];
    return tokens;
  };
  // set: replace the value of the first occurrence of a flag; drop: remove every occurrence; add: append [flag, value?] pairs.
  fx.argv = ({ set = {}, drop = [], add = [] } = {}) => {
    const done = new Set();
    const tokens = fx.tokens().filter(([flag]) => !drop.includes(flag)).map(([flag, value]) => {
      if (flag in set && !done.has(flag)) { done.add(flag); return FLAG_ONLY.has(flag) ? [flag] : [flag, set[flag]]; }
      return value === undefined ? [flag] : [flag, value];
    });
    return [...'review run'.split(' '), ...tokens.flat(), ...add.flat()];
  };
  fx.run = async ({ env, deps, ...rest } = {}) => runMain(fx.argv(rest), { env: env ?? fx.env, deps });
  return fx;
}

export async function withFixture(options, fn) {
  const fx = makeFixture(options);
  try { return await fn(fx); } finally { fx.cleanup(); }
}

export async function runMain(argv, { env = {}, deps = {} } = {}) {
  const { main } = await import('../../lib/cli.mjs');
  const out = [];
  const err = [];
  const code = await main(argv, env, {
    adapters: { ...adapters, stub }, providers, launchEnabled: false, ...deps,
    stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) },
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

export const lastLine = text => text.trimEnd().split('\n').at(-1);

// A refusal: exit code 2, one line on standard error, the refused last line, and no effect on anything under the base.
export async function expectRefusal(fx, options, pattern) {
  const before = listing(fx.base);
  const result = await fx.run(options);
  assert.equal(result.code, 2, `expected a refusal, got ${result.code}: ${result.stdout} ${result.stderr}`);
  const lines = result.stderr.trimEnd().split('\n');
  assert.equal(lines.length, 1, `one line on standard error: ${JSON.stringify(result.stderr)}`);
  assert.match(lines[0], /^refused: /);
  if (pattern) assert.match(lines[0], pattern);
  assert.match(lastLine(result.stdout), /^ACODER LAUNCH (-|[A-Za-z0-9._-]+) refused -$/);
  assert.ok(!result.stderr.includes(fx.key) && !result.stdout.includes(fx.key), 'the key is in no message');
  assert.deepEqual(listing(fx.base), before, 'a refusal has no effect');
  return result;
}
