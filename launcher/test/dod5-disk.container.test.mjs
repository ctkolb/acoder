import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { SKIP } from './helpers/container-env.mjs';
import { assertStagingGone, assertStopOrder, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);
const BOUND = 262144;

// The host's own view of the disk sum of A8.6: regular files under scratch (no link followed) plus both reports and the run's logs.
function hostSum(fx) {
  let total = 0;
  const walk = dir => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      let info;
      try { info = fs.lstatSync(path.join(dir, name)); } catch { continue; }
      if (info.isFile()) total += info.size;
      else if (info.isDirectory()) walk(path.join(dir, name));
    }
  };
  walk(fx.writable.scratch);
  const files = [fx.writable.reportMd, fx.writable.reportJson, ...fs.readdirSync(fx.stage).filter(name => name.startsWith(`run-${fx.tag}.`) && name.endsWith('.log')).map(name => path.join(fx.stage, name))];
  for (const file of files) { try { const info = fs.lstatSync(file); if (info.isFile()) total += info.size; } catch { /* not there */ } }
  return total;
}

// Watches the host sum every 50 ms from the release on; `crossed` is the first time it was at or above the bound.
function watcher(fx) {
  const state = { crossed: null, timer: null };
  state.start = () => { state.timer = setInterval(() => { if (state.crossed === null && hostSum(fx) >= BOUND) state.crossed = Date.now(); }, 50); };
  state.stop = () => clearInterval(state.timer);
  return state;
}

// S4-AC20 (DoD 5; R7-07, R9-01/03) dod5-disk: the real budget controller is wired to runReview. A stub writes persistently past a small
// scratch_max_bytes bound while a pre-usage stream is OPEN: detected within 2000 ms, stopped within a further 20 s, budget disk with the
// limits in the record; STOP first and the summary before any agent signal; lower-bound counts, no usage_unreported.
t('dod5-disk: persistent scratch writes past the bound with a stream open: detected within 2000 ms, stopped within 20 s, budget disk, STOP and summary before any agent signal', async () => {
  let watch = null;
  await withContainerRun({
    scenario: 'script', wallSeconds: 120, limits: { scratch_max_bytes: BOUND }, answers: { default: 'hold' },
    steps: [{ do: 'open', id: 's' }, { do: 'wait-head', id: 's' }, { do: 'grow', name: 'big', bytes: 16384, everyMs: 50 }],
    hooks: { beforeRelease: (info, { fx }) => { watch = watcher(fx); watch.start(); } },
  }, async ({ record, fx, timeline, runLeft }) => {
    watch.stop();
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    assert.deepEqual([record.exit_reason, record.budget_kind], ['budget', 'disk'], JSON.stringify(record.conditions));
    assert.equal(record.limits.scratch_max_bytes, BOUND);
    assert.ok(record.conditions.includes('tokens_lower_bound'));
    assert.ok(!record.conditions.includes('usage_unreported'));
    assert.equal(record.usage.usage_missing, 1);
    const order = assertStopOrder(timeline);
    assert.ok(watch.crossed !== null, 'the host saw the bound crossed');
    assert.ok(order.stopAt - watch.crossed <= 2000, `detected within 2000 ms (${order.stopAt - watch.crossed} ms)`);
    const agentExit = timeline.find(entry => entry.kind === 'exit' && entry.to === 'agent');
    assert.ok(agentExit.t - order.stopAt <= 20000, `stopped within a further 20 s (${agentExit.t - order.stopAt} ms)`);
    assert.deepEqual(runLeft, { containers: [], volumes: [], networks: [] });
    assertStagingGone({ fx, record });
  });
});

// Controls: output below the bound continues; a link to a large host file is not followed (and is counted as a link leaving scratch);
// entries that vanish between listing and lstat do not stop the run. The run ends done.
t('dod5-disk: below-bound output, a link to a large file outside scratch and vanishing entries do not stop the run (done)', async () => {
  let big = null;
  await withContainerRun({
    scenario: 'script', wallSeconds: 120, limits: { scratch_max_bytes: BOUND },
    steps: ({ fx }) => {
      big = path.join(fx.base, 'large-host-file.bin');
      fs.writeFileSync(big, Buffer.alloc(4 * BOUND, 1));
      return [
        { do: 'write', name: 'small.txt', bytes: 4096 }, { do: 'link', name: 'large-link', target: big }, { do: 'churn', ms: 3500 },
        { do: 'request' }, { do: 'reports' }, { do: 'exit', code: 0 },
      ];
    },
  }, async ({ record, fx }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    assert.equal(record.exit_reason, 'done', JSON.stringify({ conditions: record.conditions, detail: record.error_detail }));
    assert.ok(fs.lstatSync(path.join(fx.writable.scratch, 'large-link')).isSymbolicLink(), 'the link is in scratch');
    assert.equal(record.scratch_symlinks_outside, 1, 'the link leaving scratch is counted');
    assert.equal(fs.statSync(big).size, 4 * BOUND, 'the large file was not touched');
    assertStagingGone({ fx, record });
  });
});

// Precedence: a disk stop together with an incomplete post-run scan (an unreadable directory in scratch) is error secret_scan_incomplete,
// above the disk budget; both conditions are in the record.
t('dod5-disk: an incomplete scan outranks the disk stop: error secret_scan_incomplete, with budget and disk in the record', async () => {
  await withContainerRun({
    scenario: 'script', wallSeconds: 120, limits: { scratch_max_bytes: BOUND },
    steps: [{ do: 'mkdir', name: 'closed', mode: '000' }, { do: 'grow', name: 'big', bytes: 16384, everyMs: 50 }],
  }, async ({ record, fx }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    assert.deepEqual([record.exit_reason, record.error_detail, record.budget_kind], ['error', 'secret_scan_incomplete', 'disk'], JSON.stringify(record.conditions));
    assert.ok(record.conditions.includes('budget'));
    assert.equal(record.secret_scan.status, 'incomplete');
    assert.equal(record.inputs.scratch_git_entries_complete, false);
    assertStagingGone({ fx, record });
  });
});
