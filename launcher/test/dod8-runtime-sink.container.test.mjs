import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodeTest from 'node:test';
import { docker, listLabelled, SKIP } from './helpers/container-env.mjs';
import { assertStagingGone, withContainerRun } from './helpers/container-run.mjs';
import { expectedForms } from './helpers/key-forms.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// S4-AC12 (DoD 8; SPEC-07) dod8-runtime-sink, exactly as A8.7: during a run (the hook between gate and release) the test reads `inspect` of
// both containers (log driver and log path only, never the environment): log driver none, no log path. After the run no container exists.
t('dod8-runtime-sink: both containers run with log driver none and no log path; after the run no container of the run exists', async () => {
  const seen = {};
  await withContainerRun({
    scenario: 'good-1',
    hooks: {
      beforeRelease: async ({ names }) => {
        for (const [role, name] of [['agent', names.agent], ['egress', names.egress]]) {
          const answer = await docker(['container', 'inspect', '--format', '{{.HostConfig.LogConfig.Type}}|{{.LogPath}}|{{.State.Status}}', name]);
          seen[role] = answer.stdout.trim();
        }
      },
    },
  }, async ({ record, result, fx }) => {
    assert.deepEqual(seen, { agent: 'none||running', egress: 'none||running' }, 'log driver none and no log path, while both run');
    assert.equal(record.agent_started, true);
    assert.deepEqual(await listLabelled(`label=acoder.run=${result.run_id}`), { containers: [], volumes: [], networks: [] }, 'no container of the run exists');
    assertStagingGone({ fx, record });
  });
});

// The redaction of the runtime's output (A8.5): what the containers print reaches the launcher log through the runtime's attach streams.
// The stub agent prints the key (joined at run time from two halves, so no input file holds it): the log holds no form of the key, the line
// carries [REDACTED] and secret_scan.log_redactions counts it.
t('dod8-runtime-sink: a key printed on the agent container\'s output reaches the log only as [REDACTED] and is counted', async () => {
  await withContainerRun({
    scenario: 'script',
    steps: ({ fx }) => [{ do: 'print', parts: [fx.key.slice(0, 8), fx.key.slice(8)] }, { do: 'request' }, { do: 'reports' }, { do: 'exit', code: 0 }],
  }, async ({ record, fx }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    const log = fs.readFileSync(record.log_path, 'latin1');
    assert.deepEqual(Object.entries(expectedForms(fx.key)).filter(([, form]) => log.includes(form)).map(([name]) => name), [], 'no form of the key in the log');
    assert.match(log, / agent .*\[REDACTED\]/, 'the printed line reached the log redacted');
    assert.ok(record.secret_scan.log_redactions >= 1, `the redaction is counted: ${record.secret_scan.log_redactions}`);
    assertStagingGone({ fx, record });
  });
});
