import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { CHECK_IDS } from '../lib/run.mjs';
import { docker, IMAGE_ID, SKIP } from './helpers/container-env.mjs';
import { agentNetworkExt, assertGateSequence, assertNotStarted, assertStagingGone, DNS_WRAPPER, dropRequest, insertBeforeImage, isAgent, isSidecar, maskAgentNetwork, pushSecurity, replaceIn, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// S4-AC4 and S4-AC6 (container part): the healthy run (the twin of every adverse fixture) and the container repeats of the
// supervisor's release, end of input and deadline.
t('gate: a healthy run passes all fourteen checks, writes the started file, releases the agent (marker in scratch) and removes every resource', async () => {
  let atRelease = null;
  const beforeRelease = (info, { fx }) => { atRelease = { started: fs.existsSync(fx.writable.startedRecord), marker: fs.existsSync(path.join(fx.writable.scratch, 'stub-agent-marker.json')) }; };
  await withContainerRun({ scenario: 'marker', hooks: { beforeRelease } }, async ({ result, record, fx, marker, runLeft, inspected, timeline }) => {
    assertGateSequence({ timeline, result }, null);
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
    assertStagingGone({ fx, record });
  });
});

// F-38-07 (A3.6): the release waits for the sidecar's acknowledgement of PHASE. A sidecar double that switches its phase but never prints
// the phase event: no started file, no RELEASE, the agent never runs, a not-started record (runtime_failure at R), nothing left.
t('gate: a sidecar that withholds its PHASE acknowledgement gets no release: no started file, no RELEASE, no agent marker, a not-started record', async () => {
  await withContainerRun({ scenario: 'marker', sidecar: [["    emit({ event: 'phase', phase });\n", '']] }, async ({ result, record, fx, marker, runLeft, timeline }) => {
    const phase = timeline.findIndex(entry => entry.kind === 'control' && entry.to === 'sidecar' && entry.line.startsWith('PHASE agent '));
    assert.ok(phase >= 0, 'all fourteen checks passed and PHASE was written');
    assert.equal(timeline.findIndex(entry => entry.kind === 'sidecar-phase'), -1, 'the double printed no phase event');
    assert.ok(!timeline.some(entry => entry.kind === 'control' && entry.line.startsWith('RELEASE ')), 'no RELEASE was written');
    assert.deepEqual([result.outcome, result.exit_code, result.state, result.detail], ['not-started', 1, 'R', 'runtime_failure']);
    assert.ok(record !== null, 'a not-started record was written');
    assert.match(path.basename(result.record), new RegExp(`^run-${fx.tag}\\.notstarted-\\d{8}T\\d{6}Z-[0-9a-f]{6}\\.json$`));
    assert.deepEqual([record.agent_started, record.exit_reason, record.error_detail], [false, null, 'runtime_failure']);
    assert.deepEqual(record.isolation_checks.map(entry => [entry.id, entry.result]), CHECK_IDS.map(id => [id, 'pass']), 'the gate itself passed');
    assert.equal(fs.existsSync(fx.writable.startedRecord), false, 'no started file');
    assert.equal(fs.existsSync(marker), false, 'the stub agent never ran');
    assert.deepEqual(runLeft, { containers: [], volumes: [], networks: [] }, 'all resources of the run are gone');
    assertStagingGone({ fx, record });
  });
});

// F-40-03 (R39-04; A3.6, A6.6 R): only a phase event with phase agent that arrives after PHASE agent was written acknowledges it. The real
// sidecar, patched to answer the switch with a probe-phase event: no started file, no RELEASE, the agent never runs, a not-started record
// (runtime_failure at R), nothing left.
t('gate: a sidecar that answers PHASE agent with a probe-phase event gets no release: no started file, no RELEASE, no agent marker', async () => {
  await withContainerRun({ scenario: 'marker', sidecar: [["    emit({ event: 'phase', phase });\n", "    emit({ event: 'phase', phase: 'probe' });\n"]] }, async ({ result, record, fx, marker, runLeft, timeline }) => {
    const phase = timeline.findIndex(entry => entry.kind === 'control' && entry.to === 'sidecar' && entry.line.startsWith('PHASE agent '));
    assert.ok(phase >= 0, 'all fourteen checks passed and PHASE was written');
    assert.ok(timeline.findIndex(entry => entry.kind === 'sidecar-phase') > phase, 'the double printed its (wrong) phase event after PHASE');
    assert.ok(!timeline.some(entry => entry.kind === 'control' && entry.line.startsWith('RELEASE ')), 'no RELEASE was written');
    assert.deepEqual([result.outcome, result.exit_code, result.state, result.detail], ['not-started', 1, 'R', 'runtime_failure']);
    assert.ok(record !== null, 'a not-started record was written');
    assert.deepEqual([record.agent_started, record.exit_reason, record.error_detail], [false, null, 'runtime_failure']);
    assert.deepEqual(record.isolation_checks.map(entry => [entry.id, entry.result]), CHECK_IDS.map(id => [id, 'pass']), 'the gate itself passed');
    assert.equal(fs.existsSync(fx.writable.startedRecord), false, 'no started file');
    assert.equal(fs.existsSync(marker), false, 'the stub agent never ran');
    assert.deepEqual(runLeft, { containers: [], volumes: [], networks: [] }, 'all resources of the run are gone');
    assertStagingGone({ fx, record });
  });
});
