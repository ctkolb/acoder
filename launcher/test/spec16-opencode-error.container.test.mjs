import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodeTest from 'node:test';
import { AGENT_SKIP } from './helpers/container-env.mjs';
import { lastLine } from './helpers/fixtures.mjs';
import { assertNoHostOrPathRefusal, opencodeEvents, streamCounts, withOpencodeRun } from './helpers/opencode-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime,
// ACODER_TEST_IMAGE or ACODER_TEST_AGENT_IMAGE (A10 item 4, S6-AC12).
const t = (name, fn, timeout = 300000) => nodeTest(name, { timeout, skip: AGENT_SKIP() }, fn);

// The requests that let the agent write both reports: the title, the read and the two report writes. Every later request fails.
const GOOD = 4;
// A call limit far above what opencode's retries of the failing request need, so that the run cannot end budget, calls.
const CALLS = '60';

// S6-AC7 (DoD 1, 5; SPEC-16) spec16-opencode-error: the agent wrote both report files, then the endpoint fails every request; the exit
// reason is error whatever opencode's exit code is (A6.5: the last forwarded request did not end complete with a 2xx status). The exit
// code and the events opencode printed after the failure are printed as a diagnostic for the report (F15, F19).
async function failingRun(t, after, check) {
  await withOpencodeRun({ set: { '--budget-calls': CALLS }, scenario: { fail_after: GOOD, after } }, async ({ context: { fx }, done, record, bodies, requests }) => {
    assert.equal(lastLine(done.stdout), `ACODER LAUNCH ${fx.tag} error ${fx.writable.runRecord}`, `${done.stdout}${done.stderr}`);
    assert.equal(record.exit_reason, 'error', JSON.stringify(record.conditions));
    assert.equal(record.budget_kind, null);
    for (const file of [fx.writable.reportMd, fx.writable.reportJson]) assert.ok(fs.statSync(file).size > 0, `${file} was written before the failure`);
    assert.equal(JSON.parse(fs.readFileSync(fx.writable.reportJson, 'utf8')).session, fx.tag);
    assert.deepEqual(requests.slice(0, GOOD).map(entry => entry.mode), Array(GOOD).fill('script'));
    assert.ok(requests.length > GOOD && requests.slice(GOOD).every(entry => entry.mode === after), `every later request was answered by ${after}`);
    const forwarded = record.egress_log.filter(entry => entry.phase === 'agent' && entry.decision === 'forwarded');
    assert.equal(forwarded.length, requests.length, 'every request reached the endpoint through the sidecar');
    assert.ok(forwarded.slice(GOOD).every(entry => !(entry.complete === true && entry.status >= 200 && entry.status < 300)), 'no failing request ended complete with a 2xx status');
    assertNoHostOrPathRefusal(record);
    const errors = opencodeEvents(record).filter(event => event.type === 'error');
    t.diagnostic(`F19/F15 ${after}: exit code ${done.code}; error_detail ${record.error_detail}; conditions ${JSON.stringify(record.conditions)}; agent_exit ${JSON.stringify(record.agent_exit)}; requests ${requests.length}; error events ${JSON.stringify(errors)}; streams ${JSON.stringify(streamCounts(record, bodies))}`);
    check({ done, record, errors });
  });
}

// HTTP 500: opencode retries the failing request with growing delays, prints one error event (F15: {type, timestamp, sessionID, error:
// {name, data: {message, statusCode, ...}}}) and exits by itself with a nonzero code (F19).
t('spec16-opencode-error: after the reports, every request answered with HTTP 500 ends error whatever opencode\'s exit code is', async t => {
  await failingRun(t, 'fail', ({ record, errors }) => {
    assert.ok(record.conditions.includes('last_model_request_failed'), JSON.stringify(record.conditions));
    assert.ok(errors.length >= 1 && errors.every(event => typeof event.error?.name === 'string' && event.error?.data?.statusCode === 500), `opencode printed an error event for the 500: ${JSON.stringify(errors)}`);
  });
});

// A closed connection: the sidecar answers 502 and the request ends incomplete without usage; with the token limit set and admissions open
// that is usage_unreported (A6.4), a deliberately injected failure (S6-AC13 labels it separately).
t('spec16-opencode-error: after the reports, every connection closed by the endpoint ends error whatever opencode\'s exit code is', async t => {
  await failingRun(t, 'close', ({ record }) => {
    assert.ok(record.conditions.includes('last_model_request_failed'), JSON.stringify(record.conditions));
    assert.ok(record.egress_log.some(entry => entry.phase === 'agent' && entry.decision === 'forwarded' && entry.complete === false && entry.usage === null), 'a closed connection ended incomplete without usage');
  });
});
