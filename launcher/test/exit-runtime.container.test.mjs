import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { SKIP } from './helpers/container-env.mjs';
import { assertStagingGone, isAgent, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// S4-AC14 runtime_failure, through the runtime seam: the runtime refuses the call that stops the agent container after a call limit; the
// launcher records runtime_failure (above budget), still ends the agent and removes everything.
t('exit reason runtime_failure: the runtime fails the call that stops the agent; error runtime_failure above the call budget; nothing remains', async () => {
  await withContainerRun({
    scenario: 'never', wallSeconds: 60, limits: { calls: 2 }, failCall: args => args[0] === 'stop' && isAgent(args.at(-1)),
  }, async ({ record, result, fx, runLeft }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    assert.deepEqual([record.exit_reason, record.error_detail, result.exit_code], ['error', 'runtime_failure', 1], JSON.stringify(record.conditions));
    assert.ok(record.conditions.includes('budget'), 'the call budget is still listed');
    assert.equal(record.budget_kind, 'calls');
    assert.deepEqual(runLeft, { containers: [], volumes: [], networks: [] });
    assertStagingGone({ fx, record });
  });
});

// S4-AC14 input_snapshot_changed: the verified copy is altered after the agent ran (a test hook between stop and scan); the re-hash finds it.
t('exit reason input_snapshot_changed: the snapshot copy changed during the run; unchanged_at_end false', async () => {
  await withContainerRun({
    scenario: 'good-1',
    hooks: {
      afterStop: ({ snapshot }) => {
        const file = path.join(snapshot, 'S1', 'note.md');
        fs.chmodSync(path.dirname(file), 0o755);
        fs.chmodSync(file, 0o644);
        fs.appendFileSync(file, 'changed\n');
      },
    },
  }, async ({ record, result, fx }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    assert.deepEqual([record.exit_reason, record.error_detail, result.exit_code], ['error', 'input_snapshot_changed', 1], JSON.stringify(record.conditions));
    assert.equal(record.inputs.unchanged_at_end, false);
    assertStagingGone({ fx, record });
  });
});

t('exit reason done keeps unchanged_at_end true when the snapshot copy is unchanged', async () => {
  await withContainerRun({ scenario: 'good-1' }, async ({ record }) => {
    assert.equal(record.exit_reason, 'done', JSON.stringify(record.conditions));
    assert.equal(record.inputs.unchanged_at_end, true);
  });
});

// S4-AC14 secret_found: the endpoint reflects the key; the sidecar's redactor replaces it (key_reflections > 0), which ends the run with
// error secret_found even though the agent saw only [REDACTED].
t('exit reason secret_found: an endpoint that reflects the key ends error secret_found with key_reflections above 0', async () => {
  await withContainerRun({ scenario: 'good-1', answers: { default: 'echo-key' } }, async ({ record, result, fx }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    assert.deepEqual([record.exit_reason, record.error_detail, result.exit_code], ['error', 'secret_found', 1], JSON.stringify(record.conditions));
    assert.ok(record.egress_totals.key_reflections > 0);
    assertStagingGone({ fx, record });
  });
});
