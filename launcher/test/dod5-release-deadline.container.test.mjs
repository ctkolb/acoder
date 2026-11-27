import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { SKIP } from './helpers/container-env.mjs';
import { assertNotStarted, assertStagingGone, withContainerRun } from './helpers/container-run.mjs';
import { CLOCK_REPLY, maskWrapper, useWrapper } from './helpers/supervisor-wrappers.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);
const SIDECAR_CLOCK = "emit({ event: 'clock', clock_epoch_ms: now() });";
const UPSTREAM = "        if (!stopped) emit({ event: 'upstream', host: endpointHost, handshake: result, address });";

// S4-AC13 (DoD 5; R9-07) dod5-release-deadline, container repeats: a skewed sidecar sample (a sidecar double) and skewed, missing,
// malformed or duplicated supervisor clock replies (a test-only supervisor wrapper, masked at inspect for its changed command) refuse under
// U1 before release: no started file and no agent marker.
for (const skew of [60000, -60000]) {
  t(`dod5-release-deadline: a sidecar clock sample ${skew > 0 ? '+' : ''}${skew} ms off fails U1 with clock_skew; nothing is released`, async () => {
    await withContainerRun({ sidecar: [[SIDECAR_CLOCK, `emit({ event: 'clock', clock_epoch_ms: now() + (${skew}) });`]] }, async run => assertNotStarted(run, 'U1', 'clock_skew'));
  });
}

const supervisorClock = (mode, detail) => async () => {
  await withContainerRun({
    skillFiles: [{ name: 'clock-reply.mjs', text: CLOCK_REPLY }, { name: 'clock-mode.json', text: JSON.stringify(mode) }],
    planTransform: useWrapper('clock-reply.mjs'), alter: maskWrapper,
  }, async run => {
    assertNotStarted(run, 'U1');
    assert.ok(detail.includes(run.check('U1').detail), `U1 detail ${run.check('U1').detail}`);
    assert.equal(run.check('H2').result, 'pass', 'the wrapper is masked at inspect only');
  });
};
t('dod5-release-deadline: a supervisor clock reply +60000 ms off fails U1 with clock_skew', supervisorClock({ mode: 'skew', ms: 60000 }, ['clock_skew']));
t('dod5-release-deadline: a supervisor clock reply -60000 ms off fails U1 with clock_skew', supervisorClock({ mode: 'skew', ms: -60000 }, ['clock_skew']));
t('dod5-release-deadline: a missing supervisor clock reply fails U1 (protocol)', supervisorClock({ mode: 'missing' }, ['clock_protocol']));
t('dod5-release-deadline: a malformed supervisor clock reply fails U1 (protocol)', supervisorClock({ mode: 'malformed' }, ['clock_protocol', 'protocol']));
t('dod5-release-deadline: a duplicated supervisor clock reply fails U1 (protocol)', supervisorClock({ mode: 'duplicate' }, ['clock_protocol', 'protocol']));

// A delayed gate (the sidecar double reports its upstream handshake 8 s late) does not consume budget: the sidecar's PHASE deadline and the
// supervisor's RELEASE deadline are the same epoch-ms value, release plus wall_seconds; the supervisor's own deadline ends the agent then,
// and the agent ran the full wall time after the release.
t('dod5-release-deadline: a delayed gate does not consume budget; sidecar, supervisor and launcher use release plus wall_seconds', async () => {
  await withContainerRun({
    scenario: 'sleep', wallSeconds: 4, sidecar: [[UPSTREAM, `        if (!stopped) setTimeout(() => emit({ event: 'upstream', host: endpointHost, handshake: result, address }), 8000);`]],
  }, async ({ record, fx, timeline }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    const phase = timeline.find(entry => entry.kind === 'control' && entry.line.startsWith('PHASE agent '));
    const release = timeline.find(entry => entry.kind === 'control' && entry.line.startsWith('RELEASE '));
    const deadline = Number(release.line.split(' ')[2]);
    assert.equal(Number(phase.line.split(' ')[2]), deadline, 'the sidecar and the supervisor get the same deadline');
    assert.ok(Math.abs(deadline - release.t - 4000) <= 200, `the deadline is release plus wall_seconds (${deadline - release.t} ms)`);
    assert.ok(release.t - Date.parse(record.times.launched) >= 8000, 'the gate was delayed');
    assert.equal(record.budget_kind, 'wall_clock');
    assert.match(String(record.conditions), /budget/);
    const ran = Date.parse(record.times.ended) - release.t;
    assert.ok(ran >= 4000, `the agent ran the full wall time after the release (${ran} ms)`);
    assertStagingGone({ fx, record });
  });
});
