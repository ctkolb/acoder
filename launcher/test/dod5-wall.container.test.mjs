import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodeTest from 'node:test';
import { SKIP } from './helpers/container-env.mjs';
import { assertStagingGone, assertStopOrder, withContainerRun } from './helpers/container-run.mjs';
import { lateDeadline } from './helpers/supervisor-wrappers.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// S4-AC13 (DoD 5) dod5-wall: a stub agent that never finishes is stopped at the wall-clock limit plus at most 20 s: budget, wall_clock.
t('dod5-wall: an agent that requests forever is stopped at the wall-clock limit plus at most 20 s (budget, wall_clock)', async () => {
  await withContainerRun({ scenario: 'never', wallSeconds: 4, limits: { calls: 1000000, tokens: 1000000000 } }, async ({ record, result, fx, runLeft, endpointCount }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    assert.deepEqual([record.exit_reason, record.budget_kind, result.outcome, result.exit_code], ['budget', 'wall_clock', 'budget', 3], JSON.stringify(record.conditions));
    const ran = (Date.parse(record.times.ended) - Date.parse(record.times.released)) / 1000;
    assert.ok(ran >= 4 && ran <= 4 + 20 + 15, `stopped at the limit plus the stop sequence and cleanup (${ran} s)`);
    const lead = Date.parse(record.times.released) - Date.parse(record.times.launched);
    assert.ok(lead >= 5000 - 50, `times.released is the release instant, at least the 5 s lead after the launch (${lead} ms)`);
    assert.ok(!record.conditions.includes('usage_unreported'));
    assert.ok(endpointCount() >= 1, 'the agent made requests');
    // A call counts at admission: one admitted as the stop came may be aborted before the endpoint counted it (the race of spec08-abort).
    const forwarded = record.egress_log.filter(entry => entry.decision === 'forwarded');
    assert.equal(record.usage.calls_forwarded, forwarded.length, 'the record counts every forwarded admission');
    const completed = forwarded.filter(entry => entry.complete).length;
    assert.ok(endpointCount() >= completed && endpointCount() <= forwarded.length, `the endpoint got every completed call and no more than were forwarded (${completed} <= ${endpointCount()} <= ${forwarded.length})`);
    assert.deepEqual(runLeft, { containers: [], volumes: [], networks: [] });
    assertStagingGone({ fx, record });
  });
});

// S4-AC13: the wall test repeated with a pre-usage stream OPEN at the stop, and a stub that stays alive after the socket abort until the
// runtime signals it (the supervisor's own deadline backstop is moved 120 s later by a test-only wrapper, so a runtime signal is needed):
// STOP first, the summary before any signal to the agent container; budget wall_clock with tokens_lower_bound, never usage_unreported.
t('dod5-wall: with a stream open at the stop, STOP comes first and the summary before any signal to the agent; budget wall_clock with tokens_lower_bound, no usage_unreported', async () => {
  await withContainerRun({
    ...lateDeadline, scenario: 'script', wallSeconds: 5, answers: { default: 'hold' },
    steps: [{ do: 'open', id: 's' }, { do: 'wait-head', id: 's' }, { do: 'forever' }],
  }, async ({ record, fx, timeline, runLeft }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    assert.deepEqual([record.exit_reason, record.budget_kind], ['budget', 'wall_clock'], JSON.stringify(record.conditions));
    assert.ok(record.conditions.includes('tokens_lower_bound'), 'the aborted stream makes the token total a lower bound');
    assert.ok(!record.conditions.includes('usage_unreported'), 'the stop-caused abort is not usage_unreported');
    assert.equal(record.usage.usage_missing, 1);
    const forwarded = record.egress_log.filter(entry => entry.decision === 'forwarded');
    assert.deepEqual(forwarded.map(entry => [entry.complete, entry.usage]), [[false, null]], 'the open stream was aborted by the stop');
    const order = assertStopOrder(timeline);
    const release = timeline.find(entry => entry.kind === 'control' && entry.line.startsWith('RELEASE '));
    assert.ok(order.stopAt - release.t >= 5000 - 50 && order.stopAt - release.t <= 5000 + 2000, `STOP at the wall limit (${order.stopAt - release.t} ms after RELEASE)`);
    assert.deepEqual(runLeft, { containers: [], volumes: [], networks: [] });
    assertStagingGone({ fx, record });
  });
});

// S4-AC13: the launcher learns the wall clock from its own clock (A6.5). A sidecar double receives its PHASE deadline 120 s late and the
// supervisor wrapper its RELEASE deadline 120 s late, so neither reports the deadline; an agent that sleeps is still stopped at the limit,
// budget wall_clock, with times.released at the RELEASE line.
t('dod5-wall: with the sidecar and the supervisor deadlines both late, the launcher\'s own clock stops the run (budget, wall_clock)', async () => {
  const late = 'if (Number.isSafeInteger(deadline)) release(deadline);';
  await withContainerRun({ ...lateDeadline, scenario: 'sleep', wallSeconds: 4, sidecar: [[late, 'if (Number.isSafeInteger(deadline)) release(deadline + 120000);']] }, async ({ record, fx, timeline, runLeft }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    assert.deepEqual([record.exit_reason, record.budget_kind], ['budget', 'wall_clock'], JSON.stringify(record.conditions));
    const log = fs.readFileSync(record.log_path, 'utf8');
    assert.doesNotMatch(log, / sidecar \{"event":"limit"/, 'the sidecar reported no limit');
    const order = assertStopOrder(timeline);
    const release = timeline.find(entry => entry.kind === 'control' && entry.line.startsWith('RELEASE '));
    assert.ok(Math.abs(Date.parse(record.times.released) - release.t) <= 1000, 'times.released is the RELEASE instant');
    assert.ok(order.stopAt - release.t >= 4000 - 50 && order.stopAt - release.t <= 4000 + 2000, `STOP at the wall limit (${order.stopAt - release.t} ms after RELEASE)`);
    assert.deepEqual(runLeft, { containers: [], volumes: [], networks: [] });
    assertStagingGone({ fx, record });
  });
});
