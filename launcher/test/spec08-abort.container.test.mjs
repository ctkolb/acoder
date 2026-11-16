import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { SKIP } from './helpers/container-env.mjs';
import { agentLines, assertStagingGone, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// S4-AC13 (R5-02, R9-01/02) spec08-abort through the container relay: a client abort of a stream BEFORE its usage, while admissions are
// open and a token limit is set, is usage_unreported; the next request is refused with acoder_usage_unreported.
t('spec08-abort: a pre-usage client abort with admissions open and a token limit ends usage_unreported; the next request is refused', async () => {
  await withContainerRun({
    scenario: 'script', wallSeconds: 60, limits: { tokens: 1000 }, answers: { sequence: ['hold'] },
    steps: [{ do: 'open', id: 's' }, { do: 'wait-head', id: 's' }, { do: 'abort', id: 's', afterMs: 300 }, { do: 'sleep', ms: 500 }, { do: 'request' }, { do: 'forever' }],
  }, async ({ record, fx, endpointCount }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    assert.deepEqual([record.exit_reason, record.error_detail], ['error', 'usage_unreported'], JSON.stringify(record.conditions));
    const answers = agentLines(record).filter(line => line.stub === 'answer');
    assert.equal(answers[0]?.status, 429, 'the next request was refused');
    assert.equal(record.egress_totals.refused_by_reason.acoder_usage_unreported, 1);
    assert.equal(endpointCount(), 1, 'only the aborted stream reached the endpoint');
    assertStagingGone({ fx, record });
  });
});

// S4-AC13: a client abort AFTER the final usage arrived is no error: the usage is counted and the run can end done.
t('spec08-abort: a client abort after the usage arrived is no error; the usage is counted and the run ends done', async () => {
  await withContainerRun({
    scenario: 'script', wallSeconds: 60, limits: { tokens: 1000 }, answers: { sequence: ['usage-hold'] },
    steps: [{ do: 'open', id: 's' }, { do: 'wait-head', id: 's' }, { do: 'abort', id: 's', afterMs: 1000 }, { do: 'request' }, { do: 'reports' }, { do: 'exit', code: 0 }],
  }, async ({ record, fx, endpointCount }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    assert.equal(record.exit_reason, 'done', JSON.stringify({ conditions: record.conditions, detail: record.error_detail }));
    assert.ok(!record.conditions.includes('usage_unreported'));
    const forwarded = record.egress_log.filter(entry => entry.decision === 'forwarded');
    assert.deepEqual(forwarded.map(entry => [entry.complete, entry.usage?.input ?? null]), [[false, 11], [true, 11]], 'the aborted stream kept its usage');
    assert.equal(record.usage.tokens.total, 36);
    assert.equal(endpointCount(), 2);
    assertStagingGone({ fx, record });
  });
});
