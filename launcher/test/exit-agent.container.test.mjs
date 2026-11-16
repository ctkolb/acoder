import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodeTest from 'node:test';
import { SKIP } from './helpers/container-env.mjs';
import { assertStagingGone, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// The outcome of a started run: exit reason, error detail, the last line's outcome and exit code; the record, started file and resources.
function assertOutcome({ record, result, fx, runLeft }, [reason, detail]) {
  assert.ok(record !== null && record.agent_started === true, 'the agent ran');
  assert.deepEqual([record.exit_reason, record.error_detail], [reason, detail], JSON.stringify({ conditions: record.conditions, exit: record.agent_exit }));
  assert.deepEqual([result.outcome, result.exit_code], [reason, { done: 0, budget: 3, error: 1 }[reason]]);
  assert.equal(result.record, fx.writable.runRecord, 'the record of a started run is run-<tag>.json');
  assert.ok(fs.existsSync(fx.writable.startedRecord), 'the started file exists');
  assert.deepEqual(runLeft, { containers: [], volumes: [], networks: [] });
  assertStagingGone({ fx, record });
}

// S4-AC14 (DoD 5, 6; SPEC-09): each exit reason and error_detail of A6.5 step 5 and `done`, on real containers.
t('exit reason done: the agent ends by itself with success, the last forwarded request is complete 2xx, both reports are valid, the scan is clean', async () => {
  await withContainerRun({ scenario: 'good-2' }, async run => {
    assertOutcome(run, ['done', null]);
    assert.deepEqual(run.record.conditions, []);
    assert.equal(run.record.secret_scan.status, 'clean');
    assert.equal(run.record.agent_exit.outcome, 'success');
  });
});

t('exit reason agent_failed: the adapter outcome is error although the agent exits 0', async () => {
  await withContainerRun({ scenario: 'script', steps: [{ do: 'request' }, { do: 'reports' }, { do: 'print', value: { stub: 'error' } }, { do: 'exit', code: 0 }] }, async run => {
    assertOutcome(run, ['error', 'agent_failed']);
    assert.deepEqual(run.record.agent_exit, { code: 0, signal: null, outcome: 'error' });
  });
});

t('exit reason agent_exit_nonzero: the agent container ends with a non-zero status', async () => {
  await withContainerRun({ scenario: 'script', steps: [{ do: 'request' }, { do: 'reports' }, { do: 'exit', code: 3 }] }, async run => {
    assertOutcome(run, ['error', 'agent_exit_nonzero']);
    assert.equal(run.record.agent_exit.code, 3);
  });
});

t('exit reason no_model_request: the sidecar forwarded nothing', async () => {
  await withContainerRun({ scenario: 'script', steps: [{ do: 'reports' }, { do: 'exit', code: 0 }] }, async run => {
    assertOutcome(run, ['error', 'no_model_request']);
    assert.equal(run.record.usage.calls_forwarded, 0);
  });
});

t('exit reason last_model_request_failed: scenario report-then-fail, the last forwarded request got a 500', async () => {
  await withContainerRun({ scenario: 'report-then-fail', answers: { sequence: ['ok', 'fail'] } }, async run => {
    assertOutcome(run, ['error', 'last_model_request_failed']);
    assert.deepEqual(run.record.egress_log.filter(entry => entry.decision === 'forwarded').map(entry => entry.status), [200, 500]);
  });
});

t('exit reason report_missing: the agent wrote no report', async () => {
  await withContainerRun({ scenario: 'script', steps: [{ do: 'request' }, { do: 'exit', code: 0 }] }, async run => {
    assertOutcome(run, ['error', 'report_missing']);
    assert.equal(fs.existsSync(run.fx.writable.reportMd), false, 'an empty report file is removed after the run (A2.3.6)');
  });
});

t('exit reason report_invalid: the JSON report names another session', async () => {
  await withContainerRun({ scenario: 'script', steps: [{ do: 'request' }, { do: 'reports', json: '{"session":"another-tag"}\n' }, { do: 'exit', code: 0 }] }, async run => {
    assertOutcome(run, ['error', 'report_invalid']);
    assert.deepEqual([run.record.reports.json.parses, run.record.reports.json.session_matches], [true, false]);
  });
});
