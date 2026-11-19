import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { egressLogOf, scratchFacts } from '../lib/run.mjs';
import { makeFakeRuntime } from './helpers/fake-runtime.mjs';
import { listing, runMain, withFixture } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own.
const t = (name, fn) => nodeTest(name, { timeout: 60000 }, fn);
const RUN = '20261116T101500Z-a1b2c3';
const OTHER = '20261116T090000Z-d4e5f6';

// An in-memory runtime behind the runtime seam: labelled containers, volumes and networks. The discovery listings (`--filter label=acoder.run`)
// print `<name>\t<run label>` lines; a listing scoped to one run (`--filter label=acoder.run=<run>`) prints that run's names only, as the
// runtime does with `--format {{.Names}}` / `{{.Name}}`. A removal deletes and exits 0, except: a name in `stuck` stays and its removal exits
// 1; a name in `failsButGone` is deleted but its removal exits 1. `scoped(kind, args, stdout)` may replace a scoped listing's answer
// ({code, stdout}); `discovery(kind, stdout)` may replace a discovery listing's output. Every call is recorded.
function memoryRuntime(resources, { stuck = [], failsButGone = [], scoped = null, discovery = null } = {}) {
  const calls = [];
  const lines = (kind, args) => {
    const filter = args[args.indexOf('--filter') + 1];
    if (filter === 'label=acoder.run') return resources.filter(entry => entry.kind === kind).map(entry => `${entry.name}\t${entry.run}`).join('\n');
    return resources.filter(entry => entry.kind === kind && filter === `label=acoder.run=${entry.run}`).map(entry => entry.name).join('\n');
  };
  const listed = (kind, args) => {
    const stdout = lines(kind, args);
    if (scoped !== null && args[args.indexOf('--filter') + 1] !== 'label=acoder.run') return { code: 0, stdout, stderr: '', ...scoped(kind, args, stdout) };
    if (discovery !== null && args[args.indexOf('--filter') + 1] === 'label=acoder.run') return { code: 0, stdout: discovery(kind, stdout), stderr: '' };
    return { code: 0, stdout, stderr: '' };
  };
  const drop = name => {
    if (!stuck.includes(name)) { const at = resources.findIndex(entry => entry.name === name); if (at >= 0) resources.splice(at, 1); }
    return { code: stuck.includes(name) || failsButGone.includes(name) ? 1 : 0, stdout: '', stderr: '' };
  };
  const fake = {
    name: 'docker',
    answers: async () => ({ name: 'docker', client_version: '29.0.0', server_version: '29.0.1' }),
    call: async args => {
      calls.push(args);
      if (args[0] === 'ps') return listed('container', args);
      if (args[0] === 'volume' && args[1] === 'ls') return listed('volume', args);
      if (args[0] === 'network' && args[1] === 'ls') return listed('network', args);
      if (args[0] === 'rm') return drop(args.at(-1));
      if (['volume', 'network'].includes(args[0]) && args[1] === 'rm') return drop(args.at(-1));
      return { code: 1, stdout: '', stderr: 'unexpected call' };
    },
  };
  return { calls, resources, seam: () => fake };
}

const runResources = runId => [
  { kind: 'container', name: `acoder-agent-${runId}`, run: runId }, { kind: 'container', name: `acoder-sidecar-${runId}`, run: runId },
  { kind: 'volume', name: `acoder-egress-${runId}`, run: runId }, { kind: 'network', name: `acoder-ext-${runId}`, run: runId },
];

// A staging directory as the launcher makes one (A2.5.1): a marker file holding the staging id; read-only content inside.
function staging(fx, marker = true) {
  const dir = fs.mkdtempSync(path.join(fx.staging, 'acoder-staging-'));
  if (marker) fs.writeFileSync(path.join(dir, '.acoder-staging'), `${'7'.repeat(32)}\n`);
  fs.mkdirSync(path.join(dir, 'mailbox'));
  fs.writeFileSync(path.join(dir, 'mailbox', 'copy.md'), 'copy\n');
  fs.chmodSync(path.join(dir, 'mailbox'), 0o555);
  return dir;
}

function startedFile(fx, runId, stagingDir, over = {}) {
  const file = path.join(fx.stage, `run-${fx.tag}.started.json`);
  fs.writeFileSync(file, `${JSON.stringify({
    format: 'acoder-run-started/1', run_id: runId, tag: fx.tag, ticket_sha256: fx.ticketSha, time: '2026-11-16T10:15:05.000Z',
    resources: { agent: `acoder-agent-${runId}`, egress: `acoder-sidecar-${runId}`, volume: `acoder-egress-${runId}`, network: `acoder-ext-${runId}`, staging: stagingDir }, ...over,
  }, null, 2)}\n`);
  return file;
}

async function cleanup(fx, runtime, args = ['--mailbox', fx.mailbox, '--ticket', fx.ticket]) {
  const fake = makeFakeRuntime();
  try { return await runMain(['review', 'cleanup', ...args], { env: fake.env(), deps: { runtime: runtime.seam } }); } finally { fake.cleanup(); }
}
// The crashed file of A6.9; its absence is an assertion failure, not a read error.
function crashedOf(fx) {
  const file = path.join(fx.stage, `run-${fx.tag}.crashed.json`);
  assert.ok(fs.existsSync(file), 'the crashed file was written');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
const creating = calls => calls.filter(args => ['create', 'run', 'start'].includes(args[0]) || args[1] === 'create');

// A6.9 / A1.4: `acoder review cleanup --mailbox <dir> --ticket <file>`; a usage error is exit 2 with one line and no effect.
t('review cleanup: a missing, unknown, repeated or relative flag, a ticket outside the mailbox or not named ticket-<tag>.md is a usage error with no effect', () => withFixture({}, async fx => {
  const bad = [
    [], ['--mailbox', fx.mailbox], ['--ticket', fx.ticket], ['--mailbox', fx.mailbox, '--ticket', fx.ticket, '--force'],
    ['--mailbox', fx.mailbox, '--mailbox', fx.mailbox, '--ticket', fx.ticket], ['--mailbox', 'relative/dir', '--ticket', fx.ticket],
    ['--mailbox', fx.mailbox, '--ticket', path.join(fx.base, 'elsewhere', `ticket-${fx.tag}.md`)], ['--mailbox', fx.mailbox, '--ticket', path.join(fx.stage, 'notes.md')],
    ['--mailbox', fx.mailbox, '--ticket'],
  ];
  for (const args of bad) {
    const runtime = memoryRuntime(runResources(RUN));
    const before = listing(fx.base);
    const result = await cleanup(fx, runtime, args);
    assert.equal(result.code, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /^refused: [^\n]+\n$/);
    assert.deepEqual(listing(fx.base), before, 'no effect');
    assert.deepEqual(runtime.calls, [], 'no runtime call');
  }
}));

// With a started file: the labelled containers, volume and network of that run, and the staging directory named there (only with its
// marker); the crashed file; the started file stays; nothing is created or started; other runs' resources are untouched.
t('review cleanup: with a started file it removes that run\'s labelled resources and staging, writes the crashed file and keeps the started file', () => withFixture({}, async fx => {
  const dir = staging(fx);
  const started = startedFile(fx, RUN, dir);
  const before = fs.readFileSync(started, 'utf8');
  const runtime = memoryRuntime([...runResources(RUN), ...runResources(OTHER)]);
  const result = await cleanup(fx, runtime);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(runtime.resources.map(entry => entry.run), [OTHER, OTHER, OTHER, OTHER], 'only the run of the started file is removed');
  assert.equal(fs.existsSync(dir), false, 'the staging directory is removed');
  const crashed = crashedOf(fx);
  assert.deepEqual(Object.keys(crashed), ['format', 'run_id', 'tag', 'started', 'removed', 'time']);
  assert.deepEqual([crashed.format, crashed.run_id, crashed.tag, crashed.started], ['acoder-run-crashed/1', RUN, fx.tag, true]);
  assert.deepEqual(crashed.removed, [`acoder-agent-${RUN}`, `acoder-sidecar-${RUN}`, `acoder-egress-${RUN}`, `acoder-ext-${RUN}`, dir]);
  assert.match(crashed.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(fs.readFileSync(started, 'utf8'), before, 'the started file stays: the ticket remains unlaunchable');
  for (const name of crashed.removed) assert.ok(result.stdout.includes(`removed: ${name}\n`), `${name} is printed`);
  assert.deepEqual(creating(runtime.calls), [], 'cleanup never creates or starts anything');
}));

t('review cleanup: a staging directory without its marker and a resource that stays are not claimed: exit 1 and the leftovers are printed', () => withFixture({}, async fx => {
  const dir = staging(fx, false);
  startedFile(fx, RUN, dir);
  const runtime = memoryRuntime(runResources(RUN), { stuck: [`acoder-ext-${RUN}`] });
  const result = await cleanup(fx, runtime);
  assert.equal(result.code, 1);
  assert.ok(fs.existsSync(path.join(dir, 'mailbox', 'copy.md')), 'a directory without the marker is never deleted');
  assert.match(result.stderr, new RegExp(`leftover: ${dir}\\n`));
  assert.match(result.stderr, new RegExp(`leftover: acoder-ext-${RUN}\\n`));
  assert.deepEqual(crashedOf(fx).removed, [`acoder-agent-${RUN}`, `acoder-sidecar-${RUN}`, `acoder-egress-${RUN}`]);
}));

// Without a started file it finds the attempt's run ids from its not-started files (the labels hold only the run id), removes those labelled
// resources, and prints the owner action for what it cannot discover: the staging directory, scratch and the empty reports.
t('review cleanup: without a started file it removes the attempt\'s labelled resources and prints the owner action for staging, scratch and reports', () => withFixture({}, async fx => {
  fs.mkdirSync(fx.writable.scratch);
  fs.writeFileSync(fx.writable.reportMd, '');
  fs.writeFileSync(fx.writable.reportJson, '');
  fs.writeFileSync(path.join(fx.stage, `run-${fx.tag}.notstarted-${RUN}.log`), 'log\n');
  const runtime = memoryRuntime([...runResources(RUN), ...runResources(OTHER)]);
  const result = await cleanup(fx, runtime);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(runtime.resources.map(entry => entry.run), [OTHER, OTHER, OTHER, OTHER]);
  for (const file of [fx.writable.scratch, fx.writable.reportMd, fx.writable.reportJson]) {
    assert.ok(result.stdout.includes(`owner action: inspect and remove ${file}\n`), `${file} is named`);
    assert.ok(fs.existsSync(file), 'cleanup does not delete what it cannot attribute');
  }
  assert.match(result.stdout, /owner action: the staging directory cannot be located without a started file; inspect the staging parent for acoder-staging-\* directories\n/);
  const crashed = crashedOf(fx);
  assert.deepEqual([crashed.started, crashed.run_id, crashed.removed], [false, RUN, [`acoder-agent-${RUN}`, `acoder-sidecar-${RUN}`, `acoder-egress-${RUN}`, `acoder-ext-${RUN}`]]);
}));

t('review cleanup: an existing crashed file, or a started file of another ticket, is refused with no effect', () => withFixture({}, async fx => {
  fs.writeFileSync(path.join(fx.stage, `run-${fx.tag}.crashed.json`), '{}\n');
  let runtime = memoryRuntime(runResources(RUN));
  let before = listing(fx.base);
  let result = await cleanup(fx, runtime);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^refused: .*crashed\.json already exists\n$/);
  assert.deepEqual(listing(fx.base), before);
  assert.equal(runtime.resources.length, 4);
  fs.rmSync(path.join(fx.stage, `run-${fx.tag}.crashed.json`));
  startedFile(fx, RUN, staging(fx), { tag: 'another-tag' });
  runtime = memoryRuntime(runResources(RUN));
  before = listing(fx.base);
  result = await cleanup(fx, runtime);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^refused: the started file .* is not a started file of this ticket\n$/);
  assert.deepEqual(listing(fx.base), before);
  assert.equal(runtime.resources.length, 4);
}));

// A9: scratch_git_entries counts case-insensitive Git entries; scratch_symlinks_outside counts links whose target is absolute or leaves
// scratch; nothing is followed; a bound makes the count a lower bound (complete false).
t('record facts: Git entries in any letter case at any depth, links leaving scratch, and the bound that makes the count incomplete', () => withFixture({}, async fx => {
  const scratch = path.join(fx.base, 'scratch-facts');
  fs.mkdirSync(path.join(scratch, 'a', 'b'), { recursive: true });
  fs.mkdirSync(path.join(scratch, '.git'));
  fs.writeFileSync(path.join(scratch, 'a', '.GIT'), '');
  fs.mkdirSync(path.join(scratch, 'a', 'b', '.Git'));
  fs.writeFileSync(path.join(scratch, 'a', 'b', 'not.git'), '');
  fs.symlinkSync('/etc/hosts', path.join(scratch, 'absolute'));
  fs.symlinkSync('../../outside', path.join(scratch, 'a', 'escape'));
  fs.symlinkSync('b/not.git', path.join(scratch, 'a', 'inside'));
  fs.symlinkSync(fx.base, path.join(scratch, 'a', 'b', 'dirlink'));
  assert.deepEqual(scratchFacts(scratch), { git_entries: 3, symlinks_outside: 3, complete: true });
  assert.deepEqual(scratchFacts(scratch, { maxEntries: 4 }).complete, false);
  assert.deepEqual(scratchFacts(scratch, { maxDepth: 1 }).complete, false);
  assert.deepEqual(scratchFacts(path.join(fx.base, 'missing')), { git_entries: 0, symlinks_outside: 0, complete: false });
}));

// A9: more than 10000 egress log entries are truncated to the first 10000 and egress_log_truncated is true; the event and probe fields of
// the sidecar's request events are not part of the record's entries.
t('record facts: the egress log keeps at most 10000 entries and says when it was truncated', () => {
  const entry = seq => ({ event: 'request', seq, phase: 'agent', probe: null, decision: 'refused', reason: 'acoder_budget_calls' });
  const short = egressLogOf([entry(1), entry(2)]);
  assert.deepEqual(short, { log: [{ seq: 1, phase: 'agent', decision: 'refused', reason: 'acoder_budget_calls' }, { seq: 2, phase: 'agent', decision: 'refused', reason: 'acoder_budget_calls' }], truncated: false });
  assert.equal(egressLogOf(Array.from({ length: 10000 }, (u, i) => entry(i))).truncated, false);
  const long = egressLogOf(Array.from({ length: 10001 }, (u, i) => entry(i)));
  assert.deepEqual([long.log.length, long.truncated, long.log.at(-1).seq], [10000, true, 9999]);
});

// F-40-02 (R39-02; A6.7, A6.9): crash cleanup verifies a removal as the run path does. Exit 0 of the removal means gone; after a failed
// removal ONE listing scoped to the kind and to label=acoder.run=<run> decides: the name counts as gone only when that listing succeeded,
// printed only name-shaped lines and lacks the name. Otherwise the name is a leftover (exit 1) and is not in crashed.removed.
const AGENT = `acoder-agent-${RUN}`;
const scopedCalls = calls => calls.filter(args => args.includes(`label=acoder.run=${RUN}`));
async function crashCleanup(fx, options) {
  fs.writeFileSync(path.join(fx.stage, `run-${fx.tag}.notstarted-${RUN}.log`), 'log\n');
  const runtime = memoryRuntime([{ kind: 'container', name: AGENT, run: RUN }], options);
  const result = await cleanup(fx, runtime);
  return { result, runtime, crashed: crashedOf(fx) };
}

t('review cleanup (F-40-02): a removal that exits 0 is gone without a verification listing', () => withFixture({}, async fx => {
  const { result, runtime, crashed } = await crashCleanup(fx, {});
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(crashed.removed, [AGENT]);
  assert.ok(result.stdout.includes(`removed: ${AGENT}\n`));
  assert.deepEqual(scopedCalls(runtime.calls), [], 'no verification listing after a successful removal');
}));

t('review cleanup (F-40-02): a failed removal that a scoped listing confirms gone counts as removed', () => withFixture({}, async fx => {
  const { result, runtime, crashed } = await crashCleanup(fx, { failsButGone: [AGENT] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(crashed.removed, [AGENT]);
  assert.deepEqual(scopedCalls(runtime.calls), [['ps', '--all', '--filter', `label=acoder.run=${RUN}`, '--format', '{{.Names}}']], 'one listing, scoped to the kind and the run label');
  assert.equal(runtime.calls.filter(args => args[0] === 'rm').length, 1, 'the removal is not retried');
}));

t('review cleanup (F-40-02): a failed removal that the scoped listing still shows is a leftover', () => withFixture({}, async fx => {
  const { result, runtime, crashed } = await crashCleanup(fx, { stuck: [AGENT] });
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes(`leftover: ${AGENT}\n`));
  assert.ok(!result.stdout.includes(`removed: ${AGENT}`));
  assert.deepEqual(crashed.removed, []);
  assert.equal(scopedCalls(runtime.calls).length, 1);
}));

t('review cleanup (F-40-02): a failed removal whose verification listing fails is a leftover, not removed', () => withFixture({}, async fx => {
  const { result, crashed } = await crashCleanup(fx, { failsButGone: [AGENT], scoped: () => ({ code: 1, stdout: '', stderr: 'daemon gone' }) });
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes(`leftover: ${AGENT}\n`));
  assert.deepEqual(crashed.removed, []);
}));

t('review cleanup (F-40-02): a failed removal whose verification listing holds a malformed line is a leftover, not removed', () => withFixture({}, async fx => {
  const { result, crashed } = await crashCleanup(fx, { failsButGone: [AGENT], scoped: (kind, args, stdout) => ({ stdout: `${stdout}WARNING: incomplete listing\n` }) });
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes(`leftover: ${AGENT}\n`));
  assert.ok(!result.stdout.includes(`removed: ${AGENT}`));
  assert.deepEqual(crashed.removed, []);
}));

t('review cleanup (F-40-02): an unscoped verification would see another run\'s resource; the scoped one decides for this run only', () => withFixture({}, async fx => {
  fs.writeFileSync(path.join(fx.stage, `run-${fx.tag}.notstarted-${RUN}.log`), 'log\n');
  const other = { kind: 'container', name: `acoder-agent-${OTHER}`, run: OTHER };
  const runtime = memoryRuntime([{ kind: 'container', name: AGENT, run: RUN }, other], { failsButGone: [AGENT] });
  const result = await cleanup(fx, runtime);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(crashedOf(fx).removed, [AGENT]);
  assert.deepEqual(runtime.resources, [other], 'the other run is untouched');
  assert.ok(runtime.calls.filter(args => args[0] === 'ps').every(args => args.includes('label=acoder.run') || args.includes(`label=acoder.run=${RUN}`)));
  assert.equal(scopedCalls(runtime.calls).length, 1);
}));

// F-42-01 (R41-01; A6.7, A6.9): a discovery listing that succeeds but holds a line the listing format cannot have produced (a warning, a
// name without its run label, any other text) is unreliable: exit 1 with the count of such lines and not their text, nothing removed, no
// crashed record, so `review cleanup` can run again once the listing is clean. Each case also proves the retry: a clean second run removes
// the run's resources and writes the crashed record.
const UNRELIABLE = {
  'a WARNING line among valid lines': (kind, stdout) => kind === 'container' ? `WARNING: incomplete listing\n${stdout}` : stdout,
  'a name without its run label': (kind, stdout) => kind === 'volume' ? `${stdout}\nacoder-egress-${OTHER}` : stdout,
  'a name with an empty run label': (kind, stdout) => kind === 'network' ? `${stdout}\nacoder-ext-${OTHER}\t` : stdout,
  'a malformed line only': kind => kind === 'container' ? 'WARNING: incomplete listing\n' : '',
};
for (const [name, discovery] of Object.entries(UNRELIABLE)) {
  for (const withStarted of [true, false]) {
    t(`review cleanup (F-42-01): ${name} makes the discovery unreliable (${withStarted ? 'started file' : 'attempt log'}): exit 1, nothing removed, no crashed record, and a retry works`, () => withFixture({}, async fx => {
      const dir = staging(fx);
      if (withStarted) startedFile(fx, RUN, dir);
      else fs.writeFileSync(path.join(fx.stage, `run-${fx.tag}.notstarted-${RUN}.log`), 'log\n');
      const resources = runResources(RUN);
      const runtime = memoryRuntime(resources, { discovery });
      const before = listing(fx.base);
      const result = await cleanup(fx, runtime);
      assert.equal(result.code, 1, `${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /^error: the runtime listing of labelled resources is unreliable: 1 unparseable line; nothing was removed[^\n]*\n$/);
      assert.equal(result.stderr.includes('WARNING') || result.stderr.includes(OTHER), false, 'the line itself is not printed');
      assert.equal(result.stdout, '', 'nothing is reported removed');
      assert.deepEqual(runtime.calls.filter(args => args.includes('rm')), [], 'no removal');
      assert.equal(runtime.resources.length, 4, 'every resource stays');
      assert.equal(fs.existsSync(dir), true, 'the staging directory stays');
      assert.equal(fs.existsSync(path.join(fx.stage, `run-${fx.tag}.crashed.json`)), false, 'no crashed record');
      assert.deepEqual(listing(fx.base), before, 'no file changed');
      const again = await cleanup(fx, memoryRuntime(resources));
      assert.equal(again.code, 0, again.stderr);
      assert.deepEqual(resources, [], 'the retry removes the run\'s resources');
      assert.deepEqual(crashedOf(fx).removed.slice(0, 4), runResources(RUN).map(entry => entry.name));
    }));
  }
}

t('review cleanup (F-42-01): an unreliable line in a second listing is counted with the first one, and a well-formed foreign label is not', () => withFixture({}, async fx => {
  fs.writeFileSync(path.join(fx.stage, `run-${fx.tag}.notstarted-${RUN}.log`), 'log\n');
  const runtime = memoryRuntime([...runResources(RUN), { kind: 'volume', name: 'acoder-test-volume', run: 't0123456789ab' }], {
    discovery: (kind, stdout) => kind === 'container' ? `${stdout}\nlisting truncated` : kind === 'network' ? `${stdout}\n  \nname\twith\tthree` : stdout,
  });
  const result = await cleanup(fx, runtime);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^error: the runtime listing of labelled resources is unreliable: 2 unparseable lines; nothing was removed/);
  assert.equal(runtime.resources.length, 5);
  assert.equal(fs.existsSync(path.join(fx.stage, `run-${fx.tag}.crashed.json`)), false);
}));

t('review cleanup (F-42-01): a well-formed listing with another label value and blank lines stays reliable; the foreign resource is untouched', () => withFixture({}, async fx => {
  fs.writeFileSync(path.join(fx.stage, `run-${fx.tag}.notstarted-${RUN}.log`), 'log\n');
  const foreign = { kind: 'container', name: 'acoder-test-ctr', run: 't0123456789ab' };
  const runtime = memoryRuntime([...runResources(RUN), foreign], { discovery: (kind, stdout) => `\n${stdout}\n\n` });
  const result = await cleanup(fx, runtime);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(runtime.resources, [foreign]);
  assert.deepEqual(crashedOf(fx).removed, runResources(RUN).map(entry => entry.name));
}));
