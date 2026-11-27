import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { SKIP } from './helpers/container-env.mjs';
import { assertStagingGone, assertStopOrder, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);
const USAGE = 18;

// S4-AC13 (DoD 5) dod5-tokens: reported usage (11 + 7 per answer) reaches the token limit; the next request is refused; budget tokens;
// admitted_after_token_limit 0; the overshoot is within A6.4 (the crossing response plus at most max_in_flight - 1 others).
t('dod5-tokens: reported usage reaches the token limit: budget tokens, admitted_after_token_limit 0, overshoot within A6.4', async () => {
  await withContainerRun({ scenario: 'never', wallSeconds: 60, limits: { tokens: 50 } }, async ({ record, result, fx, runLeft, endpointCount }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    assert.deepEqual([record.exit_reason, record.budget_kind, result.exit_code], ['budget', 'tokens', 3], JSON.stringify(record.conditions));
    assert.equal(record.usage.admitted_after_token_limit, 0);
    assert.ok(record.usage.tokens.total >= 50, 'the total reached the limit');
    assert.ok(record.usage.tokens.total <= 50 + USAGE * record.provider.max_in_flight, `the overshoot is bounded (${record.usage.tokens.total})`);
    assert.equal(record.usage.tokens.total, USAGE * endpointCount(), 'the totals equal the usage the endpoint reported');
    assert.ok(record.egress_totals.refused_by_reason.acoder_budget_tokens >= 1, 'a later request was refused with acoder_budget_tokens');
    assert.ok(!record.conditions.includes('usage_unreported'));
    assert.deepEqual(runLeft, { containers: [], volumes: [], networks: [] });
    assertStagingGone({ fx, record });
  });
});

// S4-AC13 dod5-tokens, scenario no-usage with the required token limit: a completed 2xx answer without readable usage while admissions are
// open is usage_unreported: error.
t('dod5-tokens: a completed answer without usage while admissions are open ends error, usage_unreported', async () => {
  await withContainerRun({ scenario: 'good-2', wallSeconds: 60, limits: { tokens: 1000 }, answers: { default: 'no-usage' } }, async ({ record, result, fx }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    assert.deepEqual([record.exit_reason, record.error_detail, result.exit_code], ['error', 'usage_unreported', 1], JSON.stringify(record.conditions));
    assert.ok(record.egress_totals.refused_by_reason.acoder_usage_unreported >= 1, 'the next request was refused with acoder_usage_unreported');
    assert.equal(record.usage.calls_forwarded, 1);
    assertStagingGone({ fx, record });
  });
});

// S4-AC13: the token stop with a pre-usage stream OPEN: after the total reaches the limit and before any refusal the agent aborts the open
// stream; budget tokens with tokens_lower_bound, never usage_unreported; STOP first and the summary before any signal to the agent.
t('dod5-tokens: a stream aborted after the total reached the limit and before any refusal ends budget tokens with tokens_lower_bound', async () => {
  await withContainerRun({
    scenario: 'script', wallSeconds: 60, limits: { tokens: 500 }, answers: { sequence: ['hold', 'big'] },
    steps: [{ do: 'open', id: 's' }, { do: 'wait-head', id: 's' }, { do: 'request' }, { do: 'abort', id: 's', afterMs: 300 }, { do: 'forever' }],
  }, async ({ record, fx, timeline }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    assert.deepEqual([record.exit_reason, record.budget_kind], ['budget', 'tokens'], JSON.stringify(record.conditions));
    assert.ok(record.conditions.includes('tokens_lower_bound'));
    assert.ok(!record.conditions.includes('usage_unreported'));
    assert.equal(record.usage.tokens.total, 1000);
    assert.equal(record.usage.usage_missing, 1);
    assert.equal(record.egress_totals.refused_agent, 0, 'nothing was refused before the stop');
    assertStopOrder(timeline);
    assertStagingGone({ fx, record });
  });
});
