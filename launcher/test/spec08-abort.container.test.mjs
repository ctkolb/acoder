import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { SKIP } from './helpers/container-env.mjs';
import { agentLines, assertStagingGone, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// S4-AC13 (R5-02, R9-01/02) spec08-abort through the container relay: a client abort of a stream BEFORE its usage, while admissions are
// open and a token limit is set, is usage_unreported; the next request (sent at once after the abort, straight to the request socket) is
// refused. Owner decision: the launcher's STOP follows the sidecar's limit event within milliseconds, so the next request is either refused
// with acoder_usage_unreported or reset by the stop; it never gets an answer, and nothing is admitted after the latch (the sidecar's 429 at
// the latch itself is the S3 unit test spec08-abort).
t('spec08-abort: a pre-usage client abort with admissions open and a token limit ends usage_unreported; the next request is refused', async () => {
  await withContainerRun({
    scenario: 'script', wallSeconds: 60, limits: { tokens: 1000 }, answers: { sequence: ['hold'] },
    steps: [{ do: 'open', id: 's' }, { do: 'wait-head', id: 's' }, { do: 'abort', id: 's', afterMs: 300 }, { do: 'request', socket: true }, { do: 'forever' }],
  }, async ({ record, fx, endpointCount }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    assert.deepEqual([record.exit_reason, record.error_detail], ['error', 'usage_unreported'], JSON.stringify(record.conditions));
    const answers = agentLines(record).filter(line => line.stub === 'answer');
    assert.equal(answers.length, 1, 'the next request ended');
    assert.ok(answers[0].status === 429 || (answers[0].status === null && answers[0].error !== null), `the next request was refused or reset by the stop: ${JSON.stringify(answers[0])}`);
    if (answers[0].status === 429) assert.equal(record.egress_totals.refused_by_reason.acoder_usage_unreported, 1);
    const forwarded = record.egress_log.filter(entry => entry.phase === 'agent' && entry.decision === 'forwarded');
    const latch = Date.parse(forwarded[0].closed);
    assert.ok(forwarded.slice(1).every(entry => Date.parse(entry.opened) <= latch), `nothing was admitted after the latch: ${JSON.stringify(forwarded)}`);
    assert.ok(forwarded.every(entry => entry.status === null || entry.complete === false), 'no forwarded request completed');
    assert.ok(endpointCount() <= forwarded.length, 'only admitted requests reached the endpoint');
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
