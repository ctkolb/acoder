import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { SKIP } from './helpers/container-env.mjs';
import { assertStagingGone, assertStopOrder, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);
const L = 3;

// The common assertions of a call-limit stop: the stub endpoint's own count is exactly L (at most L when `atMost`: owner decision for the
// flood, where the STOP of A6.5 may abort admitted parallel requests before they reach upstream, A6.3), the record shows calls_forwarded L,
// budget calls.
function assertCalls({ record, result, fx, runLeft, endpointCount }, { atMost = false } = {}) {
  assert.ok(record !== null && record.agent_started === true, 'the agent ran');
  assert.deepEqual([record.exit_reason, record.budget_kind, result.exit_code], ['budget', 'calls', 3], JSON.stringify(record.conditions));
  if (atMost) assert.ok(endpointCount() <= L, `the stub endpoint counted at most L requests (${endpointCount()})`);
  else assert.equal(endpointCount(), L, 'the stub endpoint counted exactly L requests');
  assert.equal(record.usage.calls_forwarded, L);
  assert.equal(record.egress_totals.forwarded, L);
  assert.equal(record.limits.calls, L);
  assert.deepEqual(runLeft, { containers: [], volumes: [], networks: [] });
  assertStagingGone({ fx, record });
}

// S4-AC13 (DoD 5) dod5-calls, scenario never: requests one after the other; the surplus is refused with acoder_budget_calls.
t('dod5-calls: an agent that requests forever gets exactly L calls through; the rest are refused with acoder_budget_calls (budget, calls)', async () => {
  await withContainerRun({ scenario: 'never', wallSeconds: 60, limits: { calls: L } }, async run => {
    assertCalls(run);
    assert.ok(run.record.egress_totals.refused_by_reason.acoder_budget_calls >= 1, 'a surplus request was refused with acoder_budget_calls');
    assert.ok(run.record.egress_log.some(entry => entry.phase === 'agent' && entry.reason === 'acoder_budget_calls' && entry.status === 429));
  });
});

// S4-AC13 dod5-calls, scenario flood (SPEC-08 repeated): many parallel requests straight to the request socket, no agent output.
t('dod5-calls: a flood of parallel requests straight to the request socket gets exactly L calls through (budget, calls)', async () => {
  await withContainerRun({ scenario: 'flood', wallSeconds: 60, limits: { calls: L } }, async run => {
    assertCalls(run, { atMost: true });
    const refused = run.record.egress_totals.refused_by_reason;
    assert.ok((refused.acoder_budget_calls ?? 0) + (refused.acoder_in_flight ?? 0) >= 1, 'surplus requests were refused');
  });
});

// S4-AC13: the abort after the L-th admission BEFORE any refusal or launcher STOP is still budget calls (the latch does not wait for a
// refusal); the stub stays alive after its abort until the runtime signals it.
t('dod5-calls: a stream aborted after the L-th admission and before any refusal still ends budget calls, with tokens_lower_bound', async () => {
  await withContainerRun({
    scenario: 'script', wallSeconds: 60, limits: { calls: L }, answers: { sequence: ['ok', 'ok', 'hold'] },
    steps: [{ do: 'request' }, { do: 'request' }, { do: 'open', id: 's' }, { do: 'wait-head', id: 's' }, { do: 'abort', id: 's', afterMs: 300 }, { do: 'forever' }],
  }, async run => {
    assertCalls(run);
    assert.ok(run.record.conditions.includes('tokens_lower_bound'));
    assert.ok(!run.record.conditions.includes('usage_unreported'), 'a post-latch abort is not usage_unreported');
    assert.deepEqual(run.record.egress_totals.refused_agent, 0, 'nothing was refused before the stop');
    const limit = run.timeline.findIndex(entry => entry.kind === 'limit');
    const stop = run.timeline.findIndex(entry => entry.kind === 'control' && entry.line === 'STOP');
    assert.ok(limit >= 0 && limit < stop, 'the sidecar reported the calls limit before the launcher wrote STOP');
    assertStopOrder(run.timeline);
  });
});
