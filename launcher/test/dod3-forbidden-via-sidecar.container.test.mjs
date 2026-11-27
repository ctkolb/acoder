import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import nodeTest from 'node:test';
import { SKIP } from './helpers/container-env.mjs';
import { assertStagingGone, probeResults, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// S4-AC9 (R5-12) dod3-forbidden-via-sidecar: in phase agent, a POST through the relay with Host forbidden.stub.test and an allowed path, then
// the allowed Host with a forbidden path: both get the fixed refusal codes and neither the forbidden server's nor the endpoint's counter moves.
t('dod3-forbidden-via-sidecar: in phase agent a forbidden host and a forbidden path are refused with their fixed codes; no live server sees a request', async () => {
  const nonce = randomBytes(16).toString('hex');
  await withContainerRun({
    scenario: 'script', forbidden: true,
    steps: [{ do: 'probe', nonce, actions: [
      { label: 'host', op: 'http', host: 'forbidden.stub.test' },
      { label: 'path', op: 'http', suffix: '/files' },
    ] }, { do: 'exit', code: 0 }],
  }, async ({ record, fx, endpointCount, forbiddenCount }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    const results = probeResults(record, nonce);
    assert.deepEqual([results.host.status, JSON.parse(results.host.body)], [403, { error: { code: 'acoder_host_not_allowed' } }]);
    assert.deepEqual([results.path.status, JSON.parse(results.path.body)], [403, { error: { code: 'acoder_path_not_allowed' } }]);
    assert.equal(endpointCount(), 0, 'the stub endpoint received nothing');
    assert.equal(forbiddenCount(), 0, 'the forbidden server received nothing');
    const agentPhase = record.egress_log.filter(entry => entry.phase === 'agent');
    assert.deepEqual(agentPhase.map(entry => [entry.decision, entry.reason, entry.status]), [['refused', 'acoder_host_not_allowed', 403], ['refused', 'acoder_path_not_allowed', 403]]);
    assert.equal(record.egress_totals.forwarded, 0);
    assertStagingGone({ fx, record });
  });
});
