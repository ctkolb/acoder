import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseArguments, summarizeEvents } from './mutants.mjs';

const runnerPath = fileURLToPath(new URL('./mutants.mjs', import.meta.url));
const sha = text => createHash('sha256').update(text).digest('hex');
const attempt = fn => { try { return fn(); } catch (error) { return { thrown: String(error.message) }; } };

// The synthetic package every self-test builds in a temporary directory. `observe` records what each test run saw.
const calc = `import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
export const add = (a, b) => a + b;
export const mul = (a, b) => a * b;
export const work = () => 1;
export const later = () => Promise.resolve(1);
export const CASES = 2;
export const SKIP = false;
`;
const files = {
  'package.json': JSON.stringify({
    name: 'synthetic', private: true, type: 'module',
    scripts: { hook: 'node hook.mjs' },
  }),
  'hook.mjs': `import { appendFileSync, readFileSync } from 'node:fs';
const name = process.env.MUTANT_NAME;
const log = process.env.HOOKS + '/hooks.log';
appendFileSync(log, name + ' ' + process.cwd() + '\\n');
const count = readFileSync(log, 'utf8').split('\\n').filter(line => line.startsWith(name + ' ')).length;
if (name === process.env.FAIL_HOOK && count === Number(process.env.FAIL_HOOK_AT)) process.exit(3);
`,
  'src/calc.mjs': calc,
  'test/observe.mjs': `import { appendFileSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
export function observe() {
  if (!process.env.OBS) return;
  let modules = null;
  try { modules = lstatSync('node_modules').isSymbolicLink() ? realpathSync('node_modules') : 'directory'; } catch {}
  appendFileSync(process.env.OBS + '/obs.jsonl', JSON.stringify({
    name: process.env.MUTANT_NAME, probe: process.env.ACODER_PROBE ?? null,
    source: readFileSync('src/calc.mjs', 'utf8'), entries: readdirSync('.').sort(), modules,
  }) + '\\n');
}
`,
  'test/calc.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { add, work, later, CASES, SKIP } from '../src/calc.mjs';
import { observe } from './observe.mjs';
observe();
test('add adds', () => assert.equal(add(2, 3), 5));
test('add is commutative', () => assert.equal(add(1, 2), add(2, 1)));
test('work returns one', () => assert.equal(work(), 1));
test('later resolves', { skip: SKIP }, async () => assert.equal(await later(), 1));
for (let i = 0; i < CASES; i++) test('case ' + i, () => assert.ok(true));
`,
  'test/empty.test.mjs': '// no tests here\n',
  'test/skip.test.mjs': `import test from 'node:test';
test('only skipped', { skip: 'never runs' }, () => {});
`,
  'test/count.test.mjs': `import test from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
const seen = process.env.FLAKE + '/count-seen';
const again = existsSync(seen);
if (!again) writeFileSync(seen, '1');
test('count base', () => {});
if (again) test('count extra', () => {});
`,
  'test/other.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
test('unrelated', () => {
  const flag = process.env.FLAKE + '/unrelated-' + process.env.MUTANT_NAME;
  if (process.env.FLAKE_UNRELATED === process.env.MUTANT_NAME && !existsSync(flag)) {
    writeFileSync(flag, '1');
    assert.fail('flaky assertion');
  }
});
`,
};

const CALC = 'test/calc.test.mjs';
const mutant = (name, patch = {}) => ({
  name, file: 'src/calc.mjs', anchor: 'a + b', replacement: 'a - b', modules: [CALC], expect: 'KILLED', why: 'add is asserted', ...patch,
});
const survivor = (name, patch = {}) => mutant(name, { anchor: 'a * b', replacement: 'a + b', why: 'mul has no test', ...patch });
const flaky = (kind, name = 'flaky') => mutant(name, {
  anchor: 'work = () => 1;', expect: 'EQUIVALENT', why: 'behaves like the original',
  replacement: `work = () => {
  const mark = process.env.FLAKE + '/' + process.env.MUTANT_NAME;
  const second = existsSync(mark);
  if (!second) writeFileSync(mark, '1');
  ${{ timeout: 'if (second) for (;;) {}', setup: "if (second) throw new Error('boom');", assertion: 'if (!second) return 2;' }[kind]}
  return 1;
};`,
});

async function fixture(t, { mutants = [], extra = {} } = {}) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'acoder-mutants-test-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const fx = {
    work, root: path.join(work, 'pkg'), tmp: path.join(work, 'tmp'), obs: path.join(work, 'obs'),
    flake: path.join(work, 'flake'), hooks: path.join(work, 'hooks'), out: path.join(work, 'result.json'),
    mutantsFile: path.join(work, 'mutants.json'), pids: path.join(work, 'pids'),
  };
  for (const dir of ['tmp', 'obs', 'flake', 'hooks']) await mkdir(fx[dir]);
  const all = { ...files, 'test/pristine.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
test('source is pristine', () => {
  assert.equal(createHash('sha256').update(readFileSync('src/calc.mjs')).digest('hex'), '${sha(calc)}');
});
`, ...extra };
  for (const [name, text] of Object.entries(all)) {
    await mkdir(path.dirname(path.join(fx.root, name)), { recursive: true });
    await writeFile(path.join(fx.root, name), text);
  }
  await mkdir(path.join(fx.root, 'node_modules/dep'), { recursive: true });
  await writeFile(path.join(fx.root, 'node_modules/dep/index.mjs'), 'export default 1;\n');
  await mkdir(path.join(fx.root, '.git'));
  await writeFile(path.join(fx.root, '.git/HEAD'), 'ref: refs/heads/none\n');
  await writeFile(fx.mutantsFile, JSON.stringify(mutants));
  fx.setMutants = list => writeFile(fx.mutantsFile, typeof list === 'string' ? list : JSON.stringify(list));
  return fx;
}

const standard = fx => ['--mutants', fx.mutantsFile, '--out', fx.out, '--root', fx.root];

function execute(fx, args = standard(fx), { env = {}, cwd = fx.work } = {}) {
  const inherited = { ...process.env };
  delete inherited.NODE_TEST_CONTEXT; // A nested `node --test` must not believe it is a child of this one.
  return spawnSync(process.execPath, [runnerPath, ...args], {
    cwd, encoding: 'utf8', timeout: 100_000,
    env: { ...inherited, TMPDIR: fx.tmp, OBS: fx.obs, FLAKE: fx.flake, HOOKS: fx.hooks, PIDS: fx.pids, ...env },
  });
}

async function resultOf(fx, run) {
  assert.ok(existsSync(fx.out), `no result file; exit ${run.status}; stderr: ${run.stderr}`);
  return JSON.parse(await readFile(fx.out, 'utf8'));
}

const byName = (result, name) => result.mutants.find(m => m.name === name);

async function snapshot(dir) {
  const rows = [];
  async function visit(current) {
    for (const entry of (await readdir(current)).sort()) {
      const file = path.join(current, entry);
      const info = await lstat(file);
      const label = path.relative(dir, file);
      if (info.isSymbolicLink()) rows.push(`${label} link ${await readlink(file)}`);
      else if (info.isDirectory()) { rows.push(`${label} dir ${info.mode}`); await visit(file); }
      else rows.push(`${label} file ${info.mode} ${info.mtimeMs} ${sha(await readFile(file))}`);
    }
  }
  await visit(dir);
  return rows;
}

async function observations(fx) {
  const text = await readFile(path.join(fx.obs, 'obs.jsonl'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function assertRefused(fx, run, before, after) {
  assert.equal(run.status, 2, `expected exit code 2; stderr: ${run.stderr}`);
  assert.equal(run.stderr.endsWith('\n') && run.stderr.trim().split('\n').length, 1, `one line on stderr, got: ${JSON.stringify(run.stderr)}`);
  assert.deepEqual(after, before, 'the root changed');
}

test('mutants: command line errors are exit code 2 with one line and no other effect', { timeout: 60_000 }, async t => {
  const fx = await fixture(t, { mutants: [mutant('kill')] });
  const before = await snapshot(fx.root);
  await writeFile(path.join(fx.work, 'existing.json'), 'precious bytes');
  const out = ['--out', fx.out];
  const cases = {
    'no arguments': [],
    'unknown flag': [...standard(fx), '--bogus', '1'],
    'positional argument': [...standard(fx), 'extra'],
    'missing --mutants': [...out, '--root', fx.root],
    'missing --out': ['--mutants', fx.mutantsFile, '--root', fx.root],
    'flag without a value': ['--mutants', fx.mutantsFile, '--out'],
    'repeated flag': [...standard(fx), '--out', path.join(fx.work, 'other.json')],
    'zero time limit': [...standard(fx), '--timeout-seconds', '0'],
    'negative time limit': [...standard(fx), '--timeout-seconds', '-5'],
    'non-numeric time limit': [...standard(fx), '--timeout-seconds', 'soon'],
    'fractional time limit': [...standard(fx), '--timeout-seconds', '1.5'],
    'unreadable mutants file': ['--mutants', path.join(fx.work, 'absent.json'), ...out, '--root', fx.root],
    'mutants file is a directory': ['--mutants', fx.tmp, ...out, '--root', fx.root],
    'root is missing': ['--mutants', fx.mutantsFile, ...out, '--root', path.join(fx.work, 'absent')],
    'out parent is missing': ['--mutants', fx.mutantsFile, '--out', path.join(fx.work, 'absent/result.json'), '--root', fx.root],
    'existing out file': ['--mutants', fx.mutantsFile, '--out', path.join(fx.work, 'existing.json'), '--root', fx.root],
  };
  for (const [label, args] of Object.entries(cases)) {
    const run = execute(fx, args);
    assertRefused(fx, run, before, await snapshot(fx.root));
    assert.deepEqual(await readdir(fx.tmp), [], `${label}: temporary copies were left behind`);
    assert.equal(existsSync(fx.out), false, `${label}: wrote the result file`);
  }
  assert.equal(await readFile(path.join(fx.work, 'existing.json'), 'utf8'), 'precious bytes');
});

test('mutants: the root and the time limit take their documented defaults', () => {
  const parsed = attempt(() => parseArguments(['--mutants', 'm.json', '--out', 'o.json']));
  assert.equal(parsed.root, process.cwd());
  assert.equal(parsed.timeoutSeconds, 120);
  assert.equal(parsed.afterEachScript ?? null, null);
  const named = attempt(() => parseArguments(['--mutants', 'm.json', '--out', 'o.json', '--timeout-seconds', '7', '--after-each-script', 'clean']));
  assert.equal(named.timeoutSeconds, 7);
  assert.equal(named.afterEachScript, 'clean');
});

test('mutants: the mutants file shape is validated before anything runs', { timeout: 60_000 }, async t => {
  const fx = await fixture(t);
  const before = await snapshot(fx.root);
  const good = mutant('good');
  const without = field => { const copy = { ...good }; delete copy[field]; return copy; };
  const shapes = {
    'invalid JSON': '{not json',
    'not a list': { name: 'x' },
    'empty list': [],
    'entry is not an object': ['kill'],
    'entry is null': [null],
    'extra field': [{ ...good, extra: 1 }],
    ...Object.fromEntries(['name', 'file', 'anchor', 'replacement', 'modules', 'expect', 'why'].map(f => [`missing ${f}`, [without(f)]])),
    'duplicate names': [good, mutant('good', { replacement: 'a * b' })],
    'name of the neutral control': [mutant('neutral-control')],
    'empty name': [{ ...good, name: '' }],
    'name is not a string': [{ ...good, name: 7 }],
    'absolute file': [{ ...good, file: path.join(fx.root, 'src/calc.mjs') }],
    'file with ..': [{ ...good, file: 'src/../../outside.mjs' }],
    'file is empty': [{ ...good, file: '' }],
    'empty anchor': [{ ...good, anchor: '' }],
    'replacement is not a string': [{ ...good, replacement: 3 }],
    'modules not a list': [{ ...good, modules: CALC }],
    'modules empty': [{ ...good, modules: [] }],
    'module is not a string': [{ ...good, modules: [3] }],
    'absolute module': [{ ...good, modules: [path.join(fx.root, CALC)] }],
    'module with ..': [{ ...good, modules: ['../x.test.mjs'] }],
    'module that looks like a flag': [{ ...good, modules: ['--eval'] }],
    'module with glob characters': [{ ...good, modules: ['test/*.test.mjs'] }],
    'duplicate module': [{ ...good, modules: [CALC, CALC] }],
    'expect is neither KILLED nor EQUIVALENT': [{ ...good, expect: 'SURVIVED' }],
    'why is not a string': [{ ...good, why: null }],
  };
  for (const [label, shape] of Object.entries(shapes)) {
    await fx.setMutants(shape);
    const run = execute(fx);
    assert.equal(run.status, 2, `${label}: expected exit code 2, got ${run.status}; stderr: ${run.stderr}`);
    assert.equal(run.stderr.trim().split('\n').length, 1, `${label}: one line on stderr, got ${JSON.stringify(run.stderr)}`);
    assert.equal(existsSync(fx.out), false, `${label}: wrote the result file`);
    assert.deepEqual(await readdir(fx.tmp), [], `${label}: temporary copies were left behind`);
  }
  assert.deepEqual(await snapshot(fx.root), before);
});

test('mutants: a zero-test and a skip-only module are INVALID', { timeout: 100_000 }, async t => {
  const fx = await fixture(t, { mutants: [
    mutant('zero', { modules: ['test/empty.test.mjs'] }),
    mutant('skip-only', { modules: ['test/skip.test.mjs'] }),
    mutant('one-bad-module', { modules: [CALC, 'test/empty.test.mjs'] }),
    mutant('missing-module', { modules: ['test/absent.test.mjs'] }),
    mutant('fine'),
  ] });
  const run = execute(fx);
  const result = await resultOf(fx, run);
  for (const name of ['zero', 'skip-only', 'one-bad-module', 'missing-module']) {
    const found = byName(result, name);
    assert.equal(found.result, 'INVALID', name);
    assert.equal(found.detail, 'baseline', name);
    assert.deepEqual(found.runs, [], `${name} must not run a test`);
  }
  assert.equal(byName(result, 'fine').result, 'KILLED');
  assert.equal(result.baseline.length, 2);
  assert.equal(run.status, 1);
});

test('mutants: a hanging test is INVALID by timeout', { timeout: 100_000 }, async t => {
  const fx = await fixture(t, { mutants: [mutant('hang', {
    anchor: 'work = () => 1;',
    replacement: `work = () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.env.PIDS, process.pid + ' ' + child.pid);
  for (;;) {}
};`,
  })] });
  const run = execute(fx, [...standard(fx), '--timeout-seconds', '8']);
  const result = await resultOf(fx, run);
  const found = byName(result, 'hang');
  assert.equal(found.result, 'INVALID');
  assert.equal(found.detail, 'timeout');
  assert.equal(found.reruns, 0);
  assert.equal(found.runs.length, 1);
  assert.equal(run.status, 1);
  const pids = (await readFile(fx.pids, 'utf8')).split(' ').map(Number);
  assert.equal(pids.length, 2);
  for (const pid of pids) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && attempt(() => process.kill(pid, 0)) === true) await new Promise(r => setTimeout(r, 50));
    assert.equal(attempt(() => process.kill(pid, 0)).thrown?.includes('ESRCH'), true, `process ${pid} of the hanging run is still alive`);
  }
  assert.deepEqual(await readdir(fx.tmp), [], 'the copy was not removed after the timeout');
});

test('mutants: known assertion kill', { timeout: 100_000 }, async t => {
  const fx = await fixture(t, { mutants: [mutant('add-minus')] });
  const run = execute(fx);
  const result = await resultOf(fx, run);
  const found = byName(result, 'add-minus');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(found.result, 'KILLED');
  assert.equal(found.detail, null);
  assert.ok(found.assertion_failures >= 1);
  assert.ok(found.failing_tests.some(name => name.includes('add adds')), JSON.stringify(found.failing_tests));
  assert.equal(found.runs.length, 2);
  assert.equal(found.reruns, 1);
  assert.deepEqual(found.runs[0].failing_tests, found.runs[1].failing_tests);
  assert.equal(typeof found.first_failure, 'string');
  const [first, second] = result.baseline;
  for (const baseline of [first, second]) {
    assert.deepEqual([baseline.exit_code, baseline.fail, baseline.skipped, baseline.cancelled], [0, 0, 0, 0]);
    assert.equal(baseline.tests, baseline.pass);
    assert.ok(baseline.tests >= 5);
  }
  assert.deepEqual(first, second);
  assert.equal(found.tests, first.tests, 'a kill runs the same number of tests as the baseline');
});

test('mutants: survivor is rerun and reported', { timeout: 100_000 }, async t => {
  const fx = await fixture(t, { mutants: [survivor('mul-plus')] });
  const run = execute(fx);
  const result = await resultOf(fx, run);
  const found = byName(result, 'mul-plus');
  assert.equal(found.result, 'SURVIVED');
  assert.equal(found.reruns, 1);
  assert.equal(found.runs.length, 2);
  assert.deepEqual(found.runs.map(r => r.exit_code), [0, 0]);
  assert.deepEqual(found.failing_tests, []);
  assert.equal(found.assertion_failures, 0);
  assert.equal(result.summary.survived, 1);
  assert.equal(result.summary.unexpected, 1, 'a survivor that was expected to be killed is unexpected');
  assert.equal(run.status, 1);
});

test('mutants: missing and duplicate anchors are INVALID', { timeout: 100_000 }, async t => {
  const fx = await fixture(t, { mutants: [
    mutant('absent-anchor', { anchor: 'no such text' }),
    mutant('duplicate-anchor', { anchor: 'export const' }),
    mutant('missing-file', { file: 'src/absent.mjs' }),
    mutant('no-op', { replacement: 'a + b' }),
    mutant('through-link', { file: 'src/link.mjs' }),
    mutant('real-kill'),
  ] });
  const outside = path.join(fx.work, 'outside.mjs');
  await writeFile(outside, 'export const add = (a, b) => a + b;\n');
  await symlink(outside, path.join(fx.root, 'src/link.mjs'));
  const run = execute(fx);
  const result = await resultOf(fx, run);
  for (const name of ['absent-anchor', 'duplicate-anchor', 'missing-file', 'no-op', 'through-link']) {
    assert.equal(byName(result, name).result, 'INVALID', name);
    assert.equal(byName(result, name).detail, 'anchor', name);
    assert.deepEqual(byName(result, name).runs, [], `${name} must not run a test`);
  }
  assert.equal(await readFile(outside, 'utf8'), 'export const add = (a, b) => a + b;\n', 'a mutation reached outside the copy');
  assert.equal(byName(result, 'real-kill').result, 'KILLED');
  assert.equal(run.status, 1);
});

test('mutants: a load error is INVALID, not KILLED', { timeout: 100_000 }, async t => {
  const fx = await fixture(t, { mutants: [
    mutant('syntax-error', { replacement: 'a +* b' }),
    mutant('missing-import', { anchor: 'export const CASES = 2;', replacement: "import 'node:no-such-module';\nexport const CASES = 2;" }),
    mutant('throws-at-load', { anchor: 'export const CASES = 2;', replacement: "throw new Error('load');\nexport const CASES = 2;" }),
    mutant('throws-in-test', { anchor: 'work = () => 1;', replacement: "work = () => { throw new TypeError('not an assertion'); };" }),
  ] });
  const run = execute(fx);
  const result = await resultOf(fx, run);
  for (const name of ['syntax-error', 'missing-import', 'throws-at-load', 'throws-in-test']) {
    assert.equal(byName(result, name).result, 'INVALID', name);
    assert.equal(byName(result, name).detail, 'setup', name);
    assert.equal(byName(result, name).assertion_failures, 0, name);
  }
  assert.equal(run.status, 1);
});

test('mutants: fewer tests, more tests and skipped tests than the baseline are INVALID', { timeout: 100_000 }, async t => {
  const fx = await fixture(t, { mutants: [
    mutant('fewer', { anchor: 'CASES = 2;', replacement: 'CASES = 1;' }),
    mutant('more', { anchor: 'CASES = 2;', replacement: 'CASES = 3;' }),
    mutant('skipped', { anchor: 'SKIP = false;', replacement: 'SKIP = true;' }),
    mutant('exits-early', { anchor: 'work = () => 1;', replacement: 'work = () => process.exit(0);' }),
  ] });
  const run = execute(fx);
  const result = await resultOf(fx, run);
  for (const name of ['fewer', 'more', 'skipped', 'exits-early']) {
    assert.equal(byName(result, name).result, 'INVALID', name);
    assert.equal(byName(result, name).detail, 'setup', name);
  }
  assert.equal(run.status, 1);
});

test('mutants: cancelled tests are counted and are not assertion failures', () => {
  const event = (name, extra) => ({ type: 'fail', name, nesting: 0, file: '/r/a.test.mjs', fileLevel: false, suite: false, skip: false, todo: false, ...extra });
  const summary = attempt(() => summarizeEvents([
    event('passes', { type: 'pass' }),
    event('cancelled', { failureType: 'cancelledByParent', assertion: false, message: 'Promise resolution is still pending' }),
    event('asserts', { failureType: 'testCodeFailure', assertion: true, message: 'x' }),
    event('skipped', { type: 'pass', skip: true }),
    event('suite wrapper', { suite: true, failureType: 'subtestsFailed', assertion: false }),
  ]));
  assert.deepEqual([summary.tests, summary.pass, summary.fail, summary.skipped, summary.cancelled], [4, 1, 1, 1, 1]);
  assert.equal(summary.assertion_failures, 1);
  assert.deepEqual(summary.failing_tests.length, 1);
});

test('mutants: the root is unchanged', { timeout: 100_000 }, async t => {
  const fx = await fixture(t, { mutants: [
    mutant('kill'), survivor('survive'),
    mutant('bad-anchor', { anchor: 'nothing like it' }),
    mutant('bad-load', { replacement: 'a +* b' }),
  ] });
  await mkdir(path.join(fx.root, 'sub/dir'), { recursive: true });
  await writeFile(path.join(fx.root, 'sub/dir/data.txt'), 'data\n');
  const before = await snapshot(fx.root);
  const run = execute(fx);
  const result = await resultOf(fx, run);
  assert.deepEqual(result.mutants.map(m => m.result), ['KILLED', 'SURVIVED', 'INVALID', 'INVALID']);
  assert.deepEqual(await snapshot(fx.root), before);
  assert.deepEqual(await readdir(fx.tmp), [], 'disposable copies were not removed');
  const seen = await observations(fx);
  assert.ok(seen.length >= 6);
  for (const entry of seen) {
    assert.equal(entry.entries.includes('.git'), false, 'the copy must exclude .git');
    assert.equal(entry.modules, await realpathOf(path.join(fx.root, 'node_modules')), 'the copy links node_modules to the root');
  }
});

async function realpathOf(file) {
  const { realpath } = await import('node:fs/promises');
  return realpath(file);
}

test('mutants: neutral control survives', { timeout: 100_000, todo: 'cut point 3' }, async t => {
  const fx = await fixture(t, { mutants: [mutant('kill')] });
  const run = execute(fx);
  const result = await resultOf(fx, run);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(result.control, { result: 'SURVIVED' });
  assert.deepEqual(result.mutants.map(m => m.name), ['kill'], 'the control is not listed among the mutants');
  const control = (await observations(fx)).filter(entry => entry.name === 'neutral-control');
  assert.equal(control.length, 2, 'the control runs twice');
  for (const entry of control) {
    assert.ok(entry.source.startsWith(calc), 'the control keeps the original text');
    const added = entry.source.slice(calc.length);
    assert.match(added, /^\/\/.*\n?$/, 'the control appends exactly one comment line');
  }
});

test('mutants: a broken control invalidates the run', { timeout: 100_000, todo: 'cut point 3' }, async t => {
  const fx = await fixture(t, { mutants: [
    mutant('kill', { modules: [CALC, 'test/pristine.test.mjs'] }),
    survivor('survive', { modules: [CALC, 'test/pristine.test.mjs'] }),
  ] });
  const run = execute(fx);
  const result = await resultOf(fx, run);
  assert.notEqual(result.control.result, 'SURVIVED');
  for (const found of result.mutants) {
    assert.equal(found.result, 'INVALID', found.name);
    assert.equal(found.detail, 'control', found.name);
  }
  assert.equal(result.summary.killed + result.summary.survived + result.summary.equivalent, 0);
  assert.equal(run.status, 1);
});

test('mutants: an expected EQUIVALENT that is killed is unexpected', { timeout: 100_000, todo: 'cut point 3' }, async t => {
  const fx = await fixture(t, { mutants: [
    mutant('claimed-equivalent', { expect: 'EQUIVALENT', why: 'believed harmless' }),
    survivor('real-equivalent', { expect: 'EQUIVALENT', why: 'mul has no caller' }),
    survivor('no-reason', { expect: 'EQUIVALENT', why: '  ' }),
  ] });
  const run = execute(fx);
  const result = await resultOf(fx, run);
  assert.equal(byName(result, 'claimed-equivalent').result, 'KILLED');
  assert.equal(byName(result, 'real-equivalent').result, 'EQUIVALENT');
  assert.equal(byName(result, 'no-reason').result, 'SURVIVED', 'EQUIVALENT needs a reason');
  assert.deepEqual(result.summary, { killed: 1, survived: 1, equivalent: 1, invalid: 0, unexpected: 2 });
  assert.equal(run.status, 1);
});

function assertSchema(result, fx) {
  const keys = value => Object.keys(value).sort();
  assert.deepEqual(keys(result), ['baseline', 'control', 'format', 'mutants', 'root', 'summary']);
  assert.equal(result.format, 'acoder-mutants-result/1');
  assert.equal(result.root, fx.root);
  assert.equal(result.baseline.length, 2);
  const counts = ['tests', 'pass', 'fail', 'skipped', 'cancelled'];
  for (const baseline of result.baseline) {
    assert.deepEqual(keys(baseline), ['cancelled', 'exit_code', 'fail', 'modules', 'pass', 'skipped', 'tests']);
    assert.ok(Array.isArray(baseline.modules) && baseline.modules.every(m => typeof m === 'string'));
    for (const field of [...counts, 'exit_code']) assert.equal(Number.isInteger(baseline[field]), true, field);
  }
  assert.deepEqual(keys(result.control), ['result']);
  assert.deepEqual(keys(result.summary), ['equivalent', 'invalid', 'killed', 'survived', 'unexpected']);
  for (const value of Object.values(result.summary)) assert.equal(Number.isInteger(value), true);
  for (const found of result.mutants) {
    assert.deepEqual(keys(found), ['assertion_failures', 'detail', 'expect', 'failing_tests', 'file', 'first_failure', 'name', 'reruns', 'result', 'runs', 'tests']);
    assert.ok(['KILLED', 'SURVIVED', 'EQUIVALENT', 'INVALID'].includes(found.result));
    assert.ok(found.detail === null || typeof found.detail === 'string');
    assert.ok(found.first_failure === null || typeof found.first_failure === 'string');
    assert.ok(found.failing_tests.every(name => typeof name === 'string'));
    for (const field of ['tests', 'assertion_failures', 'reruns']) assert.equal(Number.isInteger(found[field]), true, field);
    for (const entry of found.runs) {
      assert.deepEqual(keys(entry), ['assertion_failures', 'cancelled', 'exit_code', 'fail', 'failing_tests', 'pass', 'skipped', 'tests']);
      for (const field of [...counts, 'exit_code', 'assertion_failures']) assert.equal(Number.isInteger(entry[field]), true, field);
    }
  }
}

test('mutants: the result file matches the schema and the exit code rule', { timeout: 120_000, todo: 'cut point 3' }, async t => {
  const fx = await fixture(t, { mutants: [
    mutant('kill'),
    survivor('equivalent', { expect: 'EQUIVALENT', why: 'mul has no caller' }),
  ] });
  const run = execute(fx);
  const result = await resultOf(fx, run);
  assertSchema(result, fx);
  assert.deepEqual(result.summary, { killed: 1, survived: 0, equivalent: 1, invalid: 0, unexpected: 0 });
  assert.equal(run.status, 0, 'everything equals its expectation');
  assert.equal(execute(fx).status, 2, 'a second run refuses the existing result file');

  await rm(fx.out);
  await fx.setMutants([mutant('kill'), mutant('bad-anchor', { anchor: 'nothing like it' })]);
  const withInvalid = execute(fx);
  assert.equal(withInvalid.status, 1, 'an INVALID result fails the run');
  assert.equal((await resultOf(fx, withInvalid)).summary.invalid, 1);

  await rm(fx.out);
  await fx.setMutants([mutant('kill'), survivor('unexpected-survivor')]);
  const unexpected = execute(fx);
  assert.equal(unexpected.status, 1, 'an unexpected result fails the run');
  assert.deepEqual((await resultOf(fx, unexpected)).summary, { killed: 1, survived: 1, equivalent: 0, invalid: 0, unexpected: 1 });
});

test('mutants: the caller environment and MUTANT_NAME reach every test run', { timeout: 100_000, todo: 'cut point 3' }, async t => {
  const fx = await fixture(t, { mutants: [mutant('kill'), survivor('survive')] });
  const run = execute(fx, standard(fx), { env: { ACODER_PROBE: 'probe-value' } });
  await resultOf(fx, run);
  const seen = await observations(fx);
  assert.deepEqual(seen.map(entry => entry.name).sort(), [
    'baseline-1', 'baseline-2', 'kill', 'kill', 'neutral-control', 'neutral-control', 'survive', 'survive',
  ]);
  assert.ok(seen.every(entry => entry.probe === 'probe-value'));
});

test('mutants: --after-each-script runs after every test run, in the root, with MUTANT_NAME', { timeout: 100_000, todo: 'cut point 3' }, async t => {
  const fx = await fixture(t, { mutants: [mutant('kill'), mutant('bad-anchor', { anchor: 'nothing like it' })] });
  const run = execute(fx, [...standard(fx), '--after-each-script', 'hook']);
  const result = await resultOf(fx, run);
  assert.equal(run.status, 1);
  const log = (await readFile(path.join(fx.hooks, 'hooks.log'), 'utf8')).trim().split('\n');
  const root = await realpathOf(fx.root);
  assert.deepEqual(log.map(line => line.split(' ')[0]).sort(), [
    'baseline-1', 'baseline-2', 'kill', 'kill', 'neutral-control', 'neutral-control',
  ]);
  for (const line of log) assert.equal(line.slice(line.indexOf(' ') + 1), root);
  assert.equal(byName(result, 'kill').result, 'KILLED');

  for (const [at, expectedRuns] of [[1, 1], [2, 2]]) {
    await rm(fx.out);
    await fx.setMutants([survivor('failing-hook', { expect: 'EQUIVALENT', why: 'mul has no caller' })]);
    const failing = execute(fx, [...standard(fx), '--after-each-script', 'hook'], { env: { FAIL_HOOK: 'failing-hook', FAIL_HOOK_AT: String(at) } });
    const found = byName(await resultOf(fx, failing), 'failing-hook');
    assert.equal(found.result, 'INVALID');
    assert.match(found.detail, /^hook/);
    assert.equal(found.runs.length, expectedRuns);
    assert.equal(failing.status, 1);
    await writeFile(path.join(fx.hooks, 'hooks.log'), '');
  }
});

test('mutants-flaky: an unrelated assertion that fails once is INVALID, not KILLED', { timeout: 100_000 }, async t => {
  const fx = await fixture(t, { mutants: [
    mutant('killed-but-flaky', { modules: [CALC, 'test/other.test.mjs'] }),
    flaky('assertion', 'fails-once'),
    mutant('steady-kill', { modules: [CALC, 'test/other.test.mjs'] }),
  ] });
  const run = execute(fx, standard(fx), { env: { FLAKE_UNRELATED: 'killed-but-flaky' } });
  const result = await resultOf(fx, run);
  const found = byName(result, 'killed-but-flaky');
  assert.equal(found.result, 'INVALID');
  assert.equal(found.detail, 'unstable');
  assert.equal(found.runs.length, 2);
  assert.notDeepEqual(found.runs[0].failing_tests, found.runs[1].failing_tests);
  assert.equal(byName(result, 'fails-once').result, 'INVALID', 'a pass followed by a failure is unstable');
  assert.equal(byName(result, 'fails-once').detail, 'unstable');
  assert.equal(byName(result, 'steady-kill').result, 'KILLED');
  assert.equal(run.status, 1);
});

test('mutants-flaky: baseline runs that disagree in counts make dependent mutants INVALID', { timeout: 100_000 }, async t => {
  const fx = await fixture(t, { mutants: [
    mutant('depends-on-count', { modules: [CALC, 'test/count.test.mjs'] }),
    mutant('independent'),
  ] });
  const run = execute(fx);
  const result = await resultOf(fx, run);
  assert.equal(byName(result, 'depends-on-count').result, 'INVALID');
  assert.equal(byName(result, 'depends-on-count').detail, 'baseline');
  assert.equal(byName(result, 'independent').result, 'KILLED');
  assert.notEqual(result.baseline[0].tests, result.baseline[1].tests, 'both baseline runs are recorded');
});

test('mutants-flaky: a timeout, a setup failure and a hook failure in the second run are INVALID', { timeout: 120_000, todo: 'cut point 3' }, async t => {
  const fx = await fixture(t, { mutants: [
    flaky('timeout', 'second-timeout'),
    flaky('setup', 'second-setup'),
    survivor('second-hook', { expect: 'EQUIVALENT', why: 'mul has no caller' }),
  ] });
  const run = execute(fx, [...standard(fx), '--timeout-seconds', '8', '--after-each-script', 'hook'], { env: { FAIL_HOOK: 'second-hook', FAIL_HOOK_AT: '2' } });
  const result = await resultOf(fx, run);
  const expected = { 'second-timeout': 'timeout', 'second-setup': 'setup', 'second-hook': 'hook' };
  for (const [name, detail] of Object.entries(expected)) {
    const found = byName(result, name);
    assert.equal(found.result, 'INVALID', name);
    assert.ok(found.detail.startsWith(detail), `${name}: ${found.detail}`);
    assert.equal(found.runs.length, 2, `${name} was run twice and both runs are recorded`);
  }
  assert.equal(run.status, 1);
});
