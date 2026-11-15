import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { CHECK_IDS } from '../lib/run.mjs';
import { docker, IMAGE_ID, SKIP } from './helpers/container-env.mjs';
import { agentNetworkExt, assertNotStarted, assertStagingGone, DNS_WRAPPER, dropRequest, insertBeforeImage, isAgent, isSidecar, maskAgentNetwork, pushSecurity, replaceIn, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// S4-AC6 (container part): the supervisor's end-of-input and deadline kills repeated on real containers.
t('supervisor (container): when its standard input ends after the release the agent\'s process group is killed and the container ends at once', async () => {
  await withContainerRun({
    scenario: 'sleep', wallSeconds: 60,
    hooks: { beforeRelease: ({ endAgentInput }) => { setTimeout(endAgentInput, 7000); } },
  }, async ({ record, marker }) => {
    assert.ok(record !== null, 'a record was written');
    assert.equal(record.agent_started, true);
    assert.ok(fs.existsSync(marker), 'the agent ran');
    assert.ok(record.times.wall_seconds < 45, `ended long before the wall clock (${record.times.wall_seconds} s)`);
    assert.equal(record.agent_exit.code, 137, 'the agent container ended with the killed agent\'s status');
    const log = fs.readFileSync(record.log_path, 'utf8');
    assert.match(log, /supervisor \{"event":"agent_exit","code":null,"signal":"SIGKILL"\}/);
    assert.doesNotMatch(log, /"event":"deadline"/);
  });
});

t('supervisor (container): at the RELEASE deadline the supervisor prints deadline and kills the agent\'s process group', async () => {
  await withContainerRun({ scenario: 'sleep', wallSeconds: 3 }, async ({ record, marker }) => {
    assert.ok(record !== null, 'a record was written');
    assert.equal(record.agent_started, true);
    assert.ok(fs.existsSync(marker));
    const log = fs.readFileSync(record.log_path, 'utf8');
    assert.match(log, /supervisor \{"event":"deadline"\}/);
    assert.match(log, /supervisor \{"event":"agent_exit","code":null,"signal":"SIGKILL"\}/);
    assert.equal(record.agent_exit.code, 137);
    assert.equal(record.budget_kind, 'wall_clock');
  });
});
