import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { docker, listLabelled, SKIP } from './helpers/container-env.mjs';
import { assertStagingGone, withContainerRun } from './helpers/container-run.mjs';

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
