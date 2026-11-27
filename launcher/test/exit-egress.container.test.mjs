import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { docker, SKIP } from './helpers/container-env.mjs';
import { assertStagingGone, isAgent, isSidecar, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);
const PHASE_EVENT = '    emit({ event: \'phase\', phase });';

// S4-AC14 (A3.7) egress_sidecar_exited: the test kills the sidecar while the agent runs; the launcher stops the agent at once (within 10 s).
t('exit reason egress_sidecar_exited: the sidecar is killed while the agent runs; the agent is stopped within 10 s', async () => {
  const killed = {};
  await withContainerRun({
    scenario: 'sleep', wallSeconds: 60,
    hooks: { beforeRelease: ({ names }) => { setTimeout(async () => { killed.at = Date.now(); killed.result = await docker(['kill', names.egress]); }, 6000); } },
  }, async ({ record, result, fx, timeline, runLeft }) => {
    assert.equal(killed.result?.code, 0, 'the test killed the sidecar');
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    assert.deepEqual([record.exit_reason, record.error_detail, result.exit_code], ['error', 'egress_sidecar_exited', 1], JSON.stringify(record.conditions));
    const agentExit = timeline.find(entry => entry.kind === 'exit' && entry.to === 'agent');
    assert.ok(agentExit.t - killed.at <= 10000, `the agent was stopped within 10 s (${agentExit.t - killed.at} ms)`);
    assert.ok(!timeline.some(entry => entry.kind === 'control' && entry.line === 'STOP'), 'no STOP to a sidecar that is gone');
    assert.deepEqual(runLeft, { containers: [], volumes: [], networks: [] });
    assertStagingGone({ fx, record });
  });
});

// S4-AC14 egress_protocol_error: a sidecar double prints an invalid event line after the release; the run ends error with that detail, the
// sidecar is killed before any signal to the agent container.
// The bogus line comes 8 s after the phase switch, so after the release (five seconds after PHASE agent): a protocol event before the
// release refuses it (F-42-02), which is the phase tests' concern, not this one.
t('exit reason egress_protocol_error: an invalid sidecar event line after the release ends the run; the sidecar is stopped before the agent', async () => {
  await withContainerRun({
    scenario: 'sleep', wallSeconds: 60, sidecar: [[PHASE_EVENT, `${PHASE_EVENT}\n    setTimeout(() => print({ event: 'bogus' }), 8000);`]],
  }, async ({ record, result, fx, timeline, runLeft }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    assert.deepEqual([record.exit_reason, record.error_detail, result.exit_code], ['error', 'egress_protocol_error', 1], JSON.stringify(record.conditions));
    const calls = timeline.filter(entry => entry.kind === 'call' && ['kill', 'stop'].includes(entry.args[0]));
    const sidecarKill = calls.findIndex(entry => isSidecar(entry.args.at(-1)));
    const agentSignal = calls.findIndex(entry => isAgent(entry.args.at(-1)));
    assert.ok(sidecarKill >= 0 && agentSignal > sidecarKill, `the sidecar is killed before the agent is signalled: ${JSON.stringify(calls.map(entry => entry.args))}`);
    assert.deepEqual(runLeft, { containers: [], volumes: [], networks: [] });
    assertStagingGone({ fx, record });
  });
});
