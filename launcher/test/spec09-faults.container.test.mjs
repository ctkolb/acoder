import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { listLabelled, SKIP } from './helpers/container-env.mjs';
import { assertStagingGone, isAgent, isSidecar, runInContext, withContainerEnv, withContainerRun } from './helpers/container-run.mjs';
import { lastLine, runMain } from './helpers/fixtures.mjs';
import { startLauncher } from './helpers/launcher-process.mjs';
import { lateDeadline } from './helpers/supervisor-wrappers.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 300000) => nodeTest(name, { timeout, skip: SKIP }, fn);
const STOP_SUMMARY = '    printPending();\n    emit(summary());\n    exit(0);';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// True once no container labelled with the run id exists (checked every 500 ms), false after ms.
async function containersGone(runId, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(500)) if ((await listLabelled(`label=acoder.run=${runId}`)).containers.length === 0) return true;
  return false;
}
const notStartedFiles = fx => fs.readdirSync(fx.stage).filter(name => name.startsWith(`run-${fx.tag}.notstarted-`)).sort();

// The artifacts of a not-started attempt (A6.6): the not-started record and log, no started file, the empty reports and scratch removed.
function assertNotStartedArtifacts(fx, recordPath) {
  const names = notStartedFiles(fx);
  assert.equal(names.length, 2, `a not-started record and log: ${names}`);
  assert.ok(names.includes(path.basename(recordPath)));
  assert.ok(names.some(name => name.endsWith('.log')));
  assert.equal(fs.existsSync(fx.writable.startedRecord), false, 'no started file');
  for (const file of [fx.writable.scratch, fx.writable.reportMd, fx.writable.reportJson]) assert.equal(fs.existsSync(file), false, `${path.basename(file)} removed`);
}

// SPEC-09 spec09-faults: a gate rejection leaves the not-started artifacts and exit code 1; a second launch after it works.
t('spec09-faults: a gate rejection is not started (exit 1, not-started record and log); a second launch of the same ticket then works', async () => {
  const extraEnv = plan => { const at = plan.agent.create.indexOf('--env'); plan.agent.create.splice(at, 0, '--env', 'ACODER_EXTRA=1'); return plan; };
  await withContainerEnv({ scenario: 'good-1' }, async context => {
    const first = await runInContext({ planTransform: extraEnv }, context);
    assert.deepEqual([first.result.outcome, first.result.exit_code, first.record.error_detail], ['not-started', 1, 'gate_failed']);
    assertNotStartedArtifacts(context.fx, first.result.record);
    const second = await runInContext({}, context);
    assert.deepEqual([second.result.outcome, second.result.exit_code], ['done', 0], JSON.stringify(second.record?.conditions));
    assert.deepEqual(second.runLeft, { containers: [], volumes: [], networks: [] });
  });
});

// SPEC-09: an interrupt before the release (during the gate) is a not-started attempt with error_detail interrupted; retry is allowed.
t('spec09-faults: SIGINT during the gate ends not-started (interrupted), leaves no started file and no resource; a second launch works', async () => {
  await withContainerEnv({ scenario: 'good-1' }, async context => {
    const { fx } = context;
    const launcher = startLauncher(context);
    assert.ok(await launcher.until(() => launcher.timeline().some(entry => entry.kind === 'control' && entry.line === 'CLOCK'), 150000), 'the gate began');
    process.kill(launcher.child.pid, 'SIGINT');
    const done = await launcher.done;
    assert.equal(done.code, 1, done.stderr);
    const [, outcome, recordPath] = lastLine(done.stdout).split(' ').slice(1);
    assert.equal(outcome, 'not-started');
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    assert.deepEqual([record.agent_started, record.error_detail, record.exit_reason], [false, 'interrupted', null]);
    assert.ok(!launcher.timeline().some(entry => entry.kind === 'control' && entry.line.startsWith('RELEASE ')), 'nothing was released');
    assertNotStartedArtifacts(fx, recordPath);
    assert.deepEqual(await listLabelled(`label=acoder.run=${record.run_id}`), { containers: [], volumes: [], networks: [] });
    const second = await runInContext({}, context);
    assert.deepEqual([second.result.outcome, second.result.exit_code], ['done', 0], JSON.stringify(second.record?.conditions));
  });
});

// SPEC-09: the sidecar withholds the STOP summary; after the 10 s acknowledgement bound the record has egress_protocol_error (no clean
// budget result), the sidecar is killed before any signal to the agent, and the cleanup still runs.
t('spec09-faults: a withheld STOP summary gives egress_protocol_error after 10 s; the sidecar is killed before the agent is signalled; cleanup runs', async () => {
  await withContainerRun({ ...lateDeadline, scenario: 'sleep', wallSeconds: 4, sidecar: [[STOP_SUMMARY, '    printPending();']] }, async ({ record, result, fx, timeline, runLeft }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    assert.deepEqual([record.exit_reason, record.error_detail, result.exit_code], ['error', 'egress_protocol_error', 1], JSON.stringify(record.conditions));
    const stop = timeline.find(entry => entry.kind === 'control' && entry.line === 'STOP');
    const calls = timeline.filter(entry => entry.kind === 'call' && ['kill', 'stop'].includes(entry.args[0]));
    const sidecarKill = calls.find(entry => isSidecar(entry.args.at(-1)));
    const agentSignal = calls.find(entry => isAgent(entry.args.at(-1)));
    assert.ok(sidecarKill.t - stop.t >= 10000 - 100 && sidecarKill.t - stop.t <= 12000, `the acknowledgement bound is 10 s (${sidecarKill.t - stop.t} ms)`);
    assert.ok(agentSignal.t >= sidecarKill.t, 'the sidecar was killed before the agent was signalled');
    assert.deepEqual(runLeft, { containers: [], volumes: [], networks: [] });
    assertStagingGone({ fx, record });
  });
});

// SPEC-09 and A6.9: the launcher killed BEFORE the started file; `acoder review cleanup` without a started file removes the labelled
// resources of the attempt it can name, writes the crashed file (started false) and prints the owner action for the staging, scratch and
// empty report paths it cannot discover or delete.
t('spec09-faults: the launcher killed during the gate; review cleanup without a started file prints the owner action and writes the crashed file', async () => {
  await withContainerEnv({ scenario: 'good-1' }, async context => {
    const { fx } = context;
    const launcher = startLauncher(context);
    assert.ok(await launcher.until(() => launcher.timeline().some(entry => entry.kind === 'control' && entry.line === 'CLOCK'), 150000), 'the gate began');
    process.kill(launcher.child.pid, 'SIGKILL');
    await launcher.done;
    const runId = /^run-ct-S4-r1\.notstarted-(.+)\.log$/.exec(notStartedFiles(fx).find(name => name.endsWith('.log')))[1];
    assert.ok(await containersGone(runId, 30000), 'both containers ended by themselves');
    assert.equal(fs.existsSync(fx.writable.startedRecord), false);
    const cleanup = await runMain(['review', 'cleanup', '--mailbox', fx.mailbox, '--ticket', fx.ticket], { env: { PATH: process.env.PATH } });
    assert.equal(cleanup.code, 0, cleanup.stderr);
    for (const file of [fx.writable.scratch, fx.writable.reportMd, fx.writable.reportJson]) assert.ok(cleanup.stdout.includes(`owner action: inspect and remove ${file}`), `${file} named: ${cleanup.stdout}`);
    assert.match(cleanup.stdout, /owner action: the staging directory cannot be located without a started file/);
    const crashed = JSON.parse(fs.readFileSync(path.join(fx.stage, `run-${fx.tag}.crashed.json`), 'utf8'));
    assert.deepEqual([crashed.format, crashed.tag, crashed.started, crashed.run_id], ['acoder-run-crashed/1', fx.tag, false, runId]);
    assert.ok(crashed.removed.includes(`acoder-egress-${runId}`), `the volume was removed: ${crashed.removed}`);
    assert.deepEqual(await listLabelled(`label=acoder.run=${runId}`), { containers: [], volumes: [], networks: [] });
  });
});
