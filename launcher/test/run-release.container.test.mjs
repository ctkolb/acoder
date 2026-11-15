import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { CHECK_IDS } from '../lib/run.mjs';
import { docker, IMAGE_ID, SKIP } from './helpers/container-env.mjs';
import { agentNetworkExt, assertNotStarted, DNS_WRAPPER, dropRequest, insertBeforeImage, isAgent, isSidecar, maskAgentNetwork, pushSecurity, replaceIn, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// S4-AC4 and S4-AC6 (container part): the healthy run (the twin of every adverse fixture) and the container repeats of the
// supervisor's release, end of input and deadline.
t('gate: a healthy run passes all fourteen checks, writes the started file, releases the agent (marker in scratch) and removes every resource', async () => {
  let atRelease = null;
  const beforeRelease = (info, { fx }) => { atRelease = { started: fs.existsSync(fx.writable.startedRecord), marker: fs.existsSync(path.join(fx.writable.scratch, 'stub-agent-marker.json')) }; };
  await withContainerRun({ scenario: 'marker', hooks: { beforeRelease } }, async ({ result, record, fx, marker, runLeft, inspected }) => {
    assert.deepEqual(atRelease, { started: true, marker: false }, 'the started file exists, and the agent has not run, just before RELEASE');
    assert.ok(record !== null, 'a record was written');
    assert.deepEqual(record.isolation_checks.map(entry => [entry.id, entry.result]), CHECK_IDS.map(id => [id, 'pass']), JSON.stringify(record.isolation_checks));
    assert.equal(record.agent_started, true, `${JSON.stringify({ exit: record.agent_exit, reason: record.exit_reason, detail: record.error_detail, conditions: record.conditions })}\n${fs.existsSync(record.log_path) ? fs.readFileSync(record.log_path, 'utf8').slice(-3000) : 'no log'}`);
    assert.ok(fs.existsSync(fx.writable.startedRecord), 'the started file exists');
    assert.ok(fs.existsSync(marker), 'the stub agent ran after the release');
    const agent = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(agent.stdin_bytes, 0, 'the agent read nothing on standard input');
    assert.equal(result.record, fx.writable.runRecord);
    assert.equal(record.agent_exit.code, 0);
    assert.deepEqual(runLeft, { containers: [], volumes: [], networks: [] });
    assert.ok(inspected.every(entry => !entry.text.includes(fx.key)), 'no inspect answer the launcher read holds the key');
    assert.equal(record.cleanup.status, 'complete');
  });
});

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
