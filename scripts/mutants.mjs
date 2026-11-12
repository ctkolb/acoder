#!/usr/bin/env node
// Mutation runner for suites run with `node --test`; see "Mutation runner" in docs/tooling.md.
// Test output is read from the structured events of this file's own `node --test` reporter (the default export),
// so no result depends on the console format of one Node version.
import { spawn } from 'node:child_process';
import { closeSync, openSync, rmSync } from 'node:fs';
import { cp, lstat, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const FORMAT = 'acoder-mutants-result/1';
const DEFAULT_TIMEOUT_SECONDS = 120;
const FLAGS = {
  '--mutants': 'mutants', '--out': 'out', '--root': 'root',
  '--timeout-seconds': 'timeoutSeconds', '--after-each-script': 'afterEachScript',
};
const FIELDS = ['anchor', 'expect', 'file', 'modules', 'name', 'replacement', 'why'];
const GLOB_CHARACTERS = /[*?[\]{}()!]/;

class UsageError extends Error {}

export function parseArguments(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = FLAGS[argv[i]];
    if (key === undefined) throw new UsageError(`unknown argument ${JSON.stringify(argv[i])}`);
    if (argv[i + 1] === undefined || argv[i + 1] in FLAGS) throw new UsageError(`${argv[i]} needs a value`);
    if (key in values) throw new UsageError(`${argv[i]} was given twice`);
    values[key] = argv[i + 1];
  }
  for (const required of ['mutants', 'out']) {
    if (!(required in values)) throw new UsageError(`missing --${required}`);
  }
  const seconds = values.timeoutSeconds ?? String(DEFAULT_TIMEOUT_SECONDS);
  if (!/^[1-9]\d*$/.test(seconds)) throw new UsageError('--timeout-seconds must be a positive whole number');
  const script = values.afterEachScript ?? null;
  if (script !== null && !/^[\w@:.\/][\w@:.\/-]*$/.test(script)) throw new UsageError('--after-each-script must be an npm script name');
  return {
    mutants: path.resolve(values.mutants), out: path.resolve(values.out), root: path.resolve(values.root ?? '.'),
    timeoutSeconds: Number(seconds), afterEachScript: script,
  };
}

function relativePath(value, what) {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) throw new UsageError(`${what} must be a non-empty relative path`);
  if (path.isAbsolute(value) || value.split('/').includes('..')) throw new UsageError(`${what} must stay inside the root: ${JSON.stringify(value)}`);
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized.endsWith('/')) throw new UsageError(`${what} must name a file: ${JSON.stringify(value)}`);
  return normalized;
}

export function validateMutants(text) {
  let list;
  try { list = JSON.parse(text); } catch { throw new UsageError('the mutants file is not valid JSON'); }
  if (!Array.isArray(list) || list.length === 0) throw new UsageError('the mutants file must be a non-empty JSON list');
  const names = new Set();
  return list.map((entry, index) => {
    const label = `mutant ${index + 1}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new UsageError(`${label} is not an object`);
    if (Object.keys(entry).sort().join() !== FIELDS.join()) throw new UsageError(`${label} must have exactly the fields ${FIELDS.join(', ')}`);
    const { name, anchor, replacement, expect, why } = entry;
    if (typeof name !== 'string' || name === '' || name === CONTROL_NAME) throw new UsageError(`${label} needs a unique non-empty name other than ${CONTROL_NAME}`);
    if (names.has(name)) throw new UsageError(`duplicate mutant name ${JSON.stringify(name)}`);
    names.add(name);
    if (typeof anchor !== 'string' || anchor === '') throw new UsageError(`${label}: anchor must be a non-empty string`);
    if (typeof replacement !== 'string' || typeof why !== 'string') throw new UsageError(`${label}: replacement and why must be strings`);
    if (expect !== 'KILLED' && expect !== 'EQUIVALENT') throw new UsageError(`${label}: expect must be KILLED or EQUIVALENT`);
    if (!Array.isArray(entry.modules) || entry.modules.length === 0) throw new UsageError(`${label}: modules must be a non-empty list`);
    const modules = entry.modules.map(module => {
      const normalized = relativePath(module, `${label}: module`);
      if (GLOB_CHARACTERS.test(normalized) || normalized.startsWith('-')) throw new UsageError(`${label}: module ${JSON.stringify(module)} must be a plain file path`);
      return normalized;
    });
    if (new Set(modules).size !== modules.length) throw new UsageError(`${label}: modules lists a file twice`);
    return { name, file: relativePath(entry.file, `${label}: file`), anchor, replacement, modules, expect, why };
  });
}

export const CONTROL_NAME = 'neutral-control';

// ---- Test events -------------------------------------------------------------------------------------------------

// A `node --test` reporter: one JSON line per finished test. Wrapper failures ("1 subtest failed") are kept but flagged.
export default async function* reporter(source) {
  const started = [];
  for await (const { type, data } of source) {
    if (type === 'test:start') {
      started.length = data.nesting;
      started[data.nesting] = data.name;
      continue;
    }
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    const error = data.details?.error;
    const file = data.file ?? null;
    const message = String(error?.cause?.message ?? error?.message ?? '');
    yield `${JSON.stringify({
      type: type === 'test:pass' ? 'pass' : 'fail',
      name: data.name, path: [...started.slice(0, data.nesting), data.name], nesting: data.nesting, file,
      fileLevel: file !== null && data.nesting === 0 && [file, path.basename(file), path.relative(process.cwd(), file)].includes(data.name),
      suite: data.details?.type === 'suite', skip: Boolean(data.skip), todo: Boolean(data.todo),
      failureType: error?.failureType ?? null,
      // The error crosses a process boundary as plain data, so `instanceof` is not available: an assertion failure is an
      // AssertionError by name AND by code. Either alone is a writable property that any thrown Error can carry.
      assertion: error?.cause?.name === 'AssertionError' && error?.cause?.code === 'ERR_ASSERTION',
      message: message.slice(0, 1000),
    })}\n`;
  }
}

const emptyCounts = () => ({ tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0 });

// Turns reporter events into counts. A wrapper (suite, or a test whose subtests failed) is not a test; the synthetic
// pass the runner reports for a file without tests is not a test; a todo test counts as skipped.
export function summarizeEvents(events, root = null) {
  const summary = { ...emptyCounts(), failing_tests: [], assertion_failures: 0, other_failures: 0, first_failure: null, files: {} };
  const label = event => [event.file === null ? '' : root === null ? event.file : path.relative(root, event.file), ...(event.path ?? [event.name])].filter(Boolean).join(' > ');
  for (const event of events) {
    const wrapper = event.type === 'fail' && (event.failureType === 'subtestsFailed' || (event.suite && event.failureType === 'cancelledByParent'));
    if (wrapper || (event.type === 'pass' && (event.suite || event.fileLevel))) continue;
    const file = event.file === null ? '' : root === null ? event.file : path.relative(root, event.file);
    const counts = summary.files[file] ??= emptyCounts();
    const state = event.skip || event.todo ? 'skipped' : event.type === 'pass' ? 'pass' : event.failureType === 'cancelledByParent' ? 'cancelled' : 'fail';
    for (const target of [summary, counts]) { target.tests++; target[state]++; }
    if (state !== 'fail') continue;
    summary.failing_tests.push(label(event));
    summary[event.assertion ? 'assertion_failures' : 'other_failures']++;
    summary.first_failure ??= `${label(event)}: ${(event.message ?? '').split('\n').find(line => line.trim()) ?? event.failureType ?? 'failed'}`.slice(0, 400);
  }
  summary.failing_tests.sort();
  return summary;
}

// ---- Processes and copies -----------------------------------------------------------------------------------------

const live = new Set();
const sessions = new Set();

function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is already gone */ }
}

// Runs a command in its own process group with output sent to a file; the group is killed at the time limit and
// after the command exits, so nothing a test started outlives its run.
function launch(command, args, { cwd, env, log, timeoutSeconds }) {
  return new Promise(resolve => {
    const fd = openSync(log, 'w');
    let timedOut = false;
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
    live.add(child);
    const timer = setTimeout(() => { timedOut = true; killGroup(child); }, timeoutSeconds * 1000);
    const finish = (code, signal, error = null) => {
      clearTimeout(timer);
      killGroup(child);
      live.delete(child);
      closeSync(fd);
      resolve({ code, signal, timedOut, error });
    };
    child.on('error', error => finish(null, null, error));
    child.on('exit', (code, signal) => finish(code, signal));
  });
}

async function copyRoot(root, destination) {
  const modules = path.join(root, 'node_modules');
  await cp(root, destination, {
    recursive: true, verbatimSymlinks: true,
    filter: source => path.basename(source) !== '.git' && source !== modules,
  });
  if (await lstat(modules).then(() => true, () => false)) await symlink(await realpath(modules), path.join(destination, 'node_modules'), 'dir');
}

// The --after-each-script hook runs in the root after every test run, also after a time-out, under the same time limit.
async function afterEach(context, name, label) {
  const script = context.afterEachScript;
  if (script === null) return null;
  const outcome = await launch('npm', ['run', '--silent', script], {
    cwd: context.root, env: { ...process.env, MUTANT_NAME: name }, log: path.join(context.session, `${label}.hook.log`), timeoutSeconds: context.timeoutSeconds,
  });
  if (outcome.error) return `could not start npm: ${outcome.error.message}`;
  if (outcome.timedOut) return `npm run ${script} exceeded ${context.timeoutSeconds} seconds`;
  return outcome.code === 0 ? null : `npm run ${script} exited with ${outcome.code ?? outcome.signal}`;
}

// One `node --test` run of `modules` in `directory` (module paths never start with `-`, see validateMutants); counts come from the reporter events, never from the console.
async function testRun(context, { directory, modules, name, label }) {
  const events = path.join(context.session, `${label}.events`);
  const outcome = await launch(process.execPath, [
    '--test', `--test-reporter=${import.meta.filename}`, `--test-reporter-destination=${events}`, ...modules,
  ], { cwd: directory, env: { ...process.env, MUTANT_NAME: name }, log: path.join(context.session, `${label}.log`), timeoutSeconds: context.timeoutSeconds });
  const hook = await afterEach(context, name, label);
  const lines = (await readFile(events, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  let parsed;
  try { parsed = lines.map(line => JSON.parse(line)); } catch { parsed = null; }
  const summary = summarizeEvents(parsed ?? [], await realpath(directory));
  return { exit_code: outcome.code ?? -1, timedOut: outcome.timedOut, hook, error: outcome.error?.message ?? (parsed === null ? 'unreadable test events' : null), summary };
}

// ---- Baseline ---------------------------------------------------------------------------------------------------

async function baselineRuns(context, modules) {
  const runs = [];
  for (const number of [1, 2]) {
    const directory = path.join(context.session, `baseline-${number}`);
    await copyRoot(context.root, directory);
    try { runs.push(await testRun(context, { directory, modules, name: `baseline-${number}`, label: `baseline-${number}` })); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  return runs;
}

const sameCounts = (a, b) => Object.keys(emptyCounts()).every(key => a[key] === b[key]);

// A module has a usable baseline only when both clean runs ran it, agree on its counts, and it ran at least one test
// with no failure, skip or cancellation. A timed-out or crashed run, or a non-zero exit with no failing test, taints all.
function baselineModules(modules, runs) {
  const tainted = runs.some(run => run.timedOut || run.error || run.hook || (run.exit_code !== 0 && run.summary.fail + run.summary.cancelled === 0));
  return new Map(modules.map(module => {
    const [a, b] = runs.map(run => run.summary.files[module]);
    const clean = !tainted && a && b && a.tests > 0 && a.fail + a.skipped + a.cancelled === 0 && sameCounts(a, b);
    return [module, clean ? a : null];
  }));
}

// ---- Main ----------------------------------------------------------------------------------------------------------

const failedPrerequisite = explanation => ({ invalid: explanation });

// The text of a file of the root, or why it cannot be used. The root is only read, never written, and the path must
// reach a regular file without passing through a symbolic link, so a copy cannot lead back to the root.
async function sourceText(root, file) {
  let current = root;
  const segments = file.split('/');
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (info === null) return failedPrerequisite(`${file} does not exist`);
    if (info.isSymbolicLink()) return failedPrerequisite(`${file} passes through a symbolic link`);
    if (index === segments.length - 1 ? !info.isFile() : !info.isDirectory()) return failedPrerequisite(`${file} is not a regular file inside the root`);
  }
  const buffer = await readFile(current);
  const text = buffer.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buffer) ? { text } : failedPrerequisite(`${file} is not UTF-8 text`);
}

// Refuses a module that is, or passes through, a symbolic link: the copy keeps links as they are, so such a module could
// run a file outside the copy before anything is checked. Nothing has been created or run when this throws; a module
// that does not exist is left to its baseline, where it is INVALID.
async function refuseLinkedModules(root, mutants) {
  for (const module of new Set(mutants.flatMap(mutant => mutant.modules))) {
    let current = root;
    for (const segment of module.split('/')) {
      current = path.join(current, segment);
      const info = await lstat(current).catch(() => null);
      if (info === null) break;
      if (info.isSymbolicLink()) throw new UsageError(`module ${JSON.stringify(module)} passes through a symbolic link`);
    }
  }
}

async function mutatedText(root, mutant) {
  const source = await sourceText(root, mutant.file);
  if (source.invalid) return source;
  const { text } = source;
  let occurrences = 0;
  for (let at = text.indexOf(mutant.anchor); at !== -1; at = text.indexOf(mutant.anchor, at + 1)) occurrences++;
  if (occurrences !== 1) return failedPrerequisite(`the anchor occurs ${occurrences} times in ${mutant.file}`);
  if (mutant.replacement === mutant.anchor) return failedPrerequisite('the replacement equals the anchor');
  const start = text.indexOf(mutant.anchor);
  return { text: text.slice(0, start) + mutant.replacement + text.slice(start + mutant.anchor.length) };
}

// One run of a mutant in its own fresh copy of the root.
async function mutantRun(context, mutant, text, label) {
  const directory = path.join(context.session, label);
  await copyRoot(context.root, directory);
  try {
    const target = path.join(directory, mutant.file);
    const { mode } = await stat(target);
    await rm(target);
    await writeFile(target, text, { mode: mode & 0o777 });
    return await testRun(context, { directory, modules: mutant.modules, name: mutant.name, label });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const sumCounts = (usable, modules) => modules.reduce((total, module) => {
  for (const key of Object.keys(total)) total[key] += usable.get(module)[key];
  return total;
}, emptyCounts());

// Judges one run against the summed counts of the clean baseline of the same modules. A failing test that is not an
// assertion failure (a load error, a thrown error, a timeout) is never evidence of a kill. The baseline modules have no
// failing test in either clean run, so a failing test here is never one that already failed there.
function judge(run, expected, timeoutSeconds) {
  const { summary } = run;
  if (run.hook) return { kind: 'invalid', detail: `hook: ${run.hook}`, explanation: run.hook };
  if (run.timedOut) return { kind: 'invalid', detail: 'timeout', explanation: `the run exceeded ${timeoutSeconds} seconds` };
  const setup = explanation => ({ kind: 'invalid', detail: 'setup', explanation });
  if (run.error) return setup(run.error);
  if (summary.other_failures > 0) return setup(summary.first_failure ?? 'a test failed without an assertion failure');
  if (summary.skipped > 0 || summary.cancelled > 0) return setup(`${summary.skipped} skipped and ${summary.cancelled} cancelled tests`);
  if (summary.tests !== expected.tests) return setup(`${summary.tests} tests ran; the baseline ran ${expected.tests}`);
  if (run.exit_code === 0 && summary.fail === 0) return { kind: 'survived' };
  if (summary.assertion_failures > 0 && run.exit_code !== 0) return { kind: 'failed', failing: summary.failing_tests };
  return setup(`exit code ${run.exit_code} without a failing test`);
}

const runRecord = ({ exit_code, summary }) => ({
  exit_code, tests: summary.tests, pass: summary.pass, fail: summary.fail, skipped: summary.skipped, cancelled: summary.cancelled,
  failing_tests: summary.failing_tests, assertion_failures: summary.assertion_failures,
});

// Runs a mutant twice (a second time only while the first run is valid) and judges each run on its own.
async function runTwice(context, mutant, text, expected, label) {
  const runs = [], verdicts = [];
  for (const number of [1, 2]) {
    const run = await mutantRun(context, mutant, text, `${label}-${number}`);
    runs.push(run);
    verdicts.push(judge(run, expected, context.timeoutSeconds));
    if (verdicts.at(-1).kind === 'invalid') break;
  }
  return { runs, verdicts };
}

// KILLED needs the same assertion failures in both runs; any disagreement or invalid run is INVALID, never a kill.
function settle(verdicts) {
  const [first, second] = verdicts;
  const last = verdicts.at(-1);
  if (last.kind === 'invalid') return { outcome: 'INVALID', detail: last.detail, explanation: last.explanation };
  if (first.kind !== second.kind || (first.kind === 'failed' && first.failing.join('\n') !== second.failing.join('\n'))) {
    return { outcome: 'INVALID', detail: 'unstable', explanation: 'two runs of the same mutant disagree' };
  }
  return { outcome: first.kind === 'survived' ? 'SURVIVED' : 'KILLED', detail: null, explanation: null };
}

async function evaluate(context, mutant, usable, index) {
  const prepared = await mutatedText(context.root, mutant);
  if (prepared.invalid) return invalidResult(mutant, 'anchor', prepared.invalid);
  const { runs, verdicts } = await runTwice(context, mutant, prepared.text, sumCounts(usable, mutant.modules), `mutant-${index}`);
  const { outcome, detail, explanation } = settle(verdicts);
  const equivalent = outcome === 'SURVIVED' && mutant.expect === 'EQUIVALENT' && mutant.why.trim() !== '';
  const { summary } = runs[0];
  return {
    name: mutant.name, file: mutant.file, expect: mutant.expect, result: equivalent ? 'EQUIVALENT' : outcome, detail, tests: summary.tests,
    assertion_failures: summary.assertion_failures, failing_tests: summary.failing_tests, reruns: runs.length - 1,
    first_failure: explanation ?? (outcome === 'KILLED' ? summary.first_failure : null), runs: runs.map(runRecord),
  };
}

const HASH_COMMENTS = /\.(?:sh|bash|py|rb|ya?ml|toml|conf|ini)$/;

// The neutral control appends one comment line to the first mutated file and must survive on every usable module.
// It is not a mutant: it has no entry in the result list. Returns null when there is nothing to run it on.
async function runControl(context, mutants, usable, modules) {
  const controlModules = modules.filter(module => usable.get(module) !== null);
  if (controlModules.length === 0) return null;
  for (const { file } of mutants) {
    const source = await sourceText(context.root, file);
    if (source.invalid) continue;
    const comment = HASH_COMMENTS.test(file) ? '# acoder-mutants neutral control' : '// acoder-mutants neutral control';
    const text = `${source.text}${source.text.endsWith('\n') ? '' : '\n'}${comment}\n`;
    const { verdicts } = await runTwice(context, { name: CONTROL_NAME, file, modules: controlModules }, text, sumCounts(usable, controlModules), 'control');
    return settle(verdicts).outcome;
  }
  return null;
}

// The session holds copies of the root, so it must not be inside the root: copying a directory into itself fails.
async function refuseTemporaryDirectoryInRoot(root) {
  const temporary = await realpath(os.tmpdir()).catch(() => path.resolve(os.tmpdir()));
  const relative = path.relative(await realpath(root), temporary);
  if (relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative)) {
    throw new UsageError(`--root contains the temporary directory ${temporary}; set TMPDIR to a directory outside the root`);
  }
}

export async function run(options, mutants) {
  await refuseTemporaryDirectoryInRoot(options.root);
  const session = await mkdtemp(path.join(os.tmpdir(), 'acoder-mutants-'));
  sessions.add(session);
  try {
    const context = { root: options.root, session, timeoutSeconds: options.timeoutSeconds, afterEachScript: options.afterEachScript };
    const modules = [...new Set(mutants.flatMap(mutant => mutant.modules))];
    const runs = await baselineRuns(context, modules);
    const usable = baselineModules(modules, runs);
    const control = await runControl(context, mutants, usable, modules);
    const results = [];
    for (const [index, mutant] of mutants.entries()) {
      if (control !== null && control !== 'SURVIVED') {
        results.push(invalidResult(mutant, 'control', `the neutral control did not survive (${control})`));
        continue;
      }
      const prepared = mutant.modules.some(module => usable.get(module) === null) ? null : true;
      results.push(prepared === null ? invalidResult(mutant, 'baseline', 'a baseline of its modules is not valid') : await evaluate(context, mutant, usable, index));
    }
    return await finish(options, runs, modules, control ?? 'INVALID', results);
  } finally {
    sessions.delete(session);
    await rm(session, { recursive: true, force: true });
  }
}

function invalidResult(mutant, detail, explanation) {
  return {
    name: mutant.name, file: mutant.file, expect: mutant.expect, result: 'INVALID', detail, tests: 0, assertion_failures: 0,
    failing_tests: [], reruns: 0, first_failure: explanation, runs: [],
  };
}

async function finish(options, runs, modules, control, mutants) {
  const count = result => mutants.filter(mutant => mutant.result === result).length;
  const summary = {
    killed: count('KILLED'), survived: count('SURVIVED'), equivalent: count('EQUIVALENT'), invalid: count('INVALID'),
    unexpected: mutants.filter(mutant => mutant.result !== 'INVALID' && mutant.result !== mutant.expect).length,
  };
  const result = {
    format: FORMAT, root: options.root,
    baseline: runs.map(({ exit_code, summary: { tests, pass, fail, skipped, cancelled } }) => ({ modules, tests, pass, fail, skipped, cancelled, exit_code })),
    control: { result: control }, mutants, summary,
  };
  await writeFile(options.out, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' }).catch(error => {
    throw new UsageError(`cannot create ${options.out}: ${error.code ?? error.message}`);
  });
  for (const mutant of mutants) process.stdout.write(`${mutant.result.padEnd(10)} ${mutant.name}${mutant.detail ? ` (${mutant.detail})` : ''}\n`);
  process.stdout.write(`killed ${summary.killed}, survived ${summary.survived}, equivalent ${summary.equivalent}, invalid ${summary.invalid}, unexpected ${summary.unexpected}; result in ${options.out}\n`);
  return summary.invalid === 0 && summary.unexpected === 0 ? 0 : 1;
}

async function main(argv) {
  const options = parseArguments(argv);
  const rootInfo = await stat(options.root).catch(() => null);
  if (!rootInfo?.isDirectory()) throw new UsageError(`--root is not a directory: ${options.root}`);
  const text = await readFile(options.mutants, 'utf8').catch(error => { throw new UsageError(`cannot read the mutants file: ${error.code ?? error.message}`); });
  const mutants = validateMutants(text);
  if (await lstat(options.out).then(() => true, () => false)) throw new UsageError(`the result file already exists: ${options.out}`);
  if (!(await stat(path.dirname(options.out)).catch(() => null))?.isDirectory()) throw new UsageError(`the directory of --out does not exist: ${path.dirname(options.out)}`);
  await refuseLinkedModules(options.root, mutants);
  return run(options, mutants);
}

function interrupted(signal) {
  for (const child of live) killGroup(child);
  for (const session of sessions) rmSync(session, { recursive: true, force: true });
  process.exit(128 + os.constants.signals[signal]);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => interrupted(signal));
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`mutants: ${error instanceof UsageError ? '' : 'internal error: '}${String(error.message).replace(/\s+/g, ' ')}\n`);
    process.exitCode = 2;
  });
}
