import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodeTest from 'node:test';
import { listLabelled, SKIP } from './helpers/container-env.mjs';
import { assertStagingGone, assertStopOrder, withContainerEnv } from './helpers/container-run.mjs';
import { lastLine, runMain } from './helpers/fixtures.mjs';
import { startLauncher } from './helpers/launcher-process.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);
const HOLD = { scenario: 'script', answers: { default: 'hold' }, steps: [{ do: 'open', id: 's' }, { do: 'wait-head', id: 's' }, { do: 'forever' }] };

// S4-AC14 (A6.8) interrupted: SIGINT or SIGTERM to the launcher process after the release, with a pre-usage stream OPEN: STOP first, the
// sidecar's summary before any runtime signal to the agent, then error interrupted with tokens_lower_bound, never usage_unreported. A
// second launch of the same ticket is refused (the run is started).
for (const signal of ['SIGINT', 'SIGTERM']) {
  t(`exit reason interrupted: ${signal} to the launcher with a stream open: STOP first, summary before any agent signal, error interrupted`, async () => {
    await withContainerEnv(HOLD, async context => {
      const { fx } = context;
      const launcher = startLauncher(context);
      assert.ok(await launcher.until(() => context.endpointOpen() >= 1, 150000), 'the agent opened its stream');
      process.kill(launcher.child.pid, signal);
      const done = await launcher.done;
      assert.equal(done.code, 1, done.stderr);
      assert.equal(lastLine(done.stdout), `ACODER LAUNCH ${fx.tag} error ${fx.writable.runRecord}`);
      const record = JSON.parse(fs.readFileSync(fx.writable.runRecord, 'utf8'));
      assert.deepEqual([record.exit_reason, record.error_detail, record.agent_started], ['error', 'interrupted', true], JSON.stringify(record.conditions));
      assert.ok(record.conditions.includes('tokens_lower_bound'));
      assert.ok(!record.conditions.includes('usage_unreported'), 'the stop-caused abort is not usage_unreported');
      assertStopOrder(launcher.timeline());
      assert.deepEqual(await listLabelled(`label=acoder.run=${record.run_id}`), { containers: [], volumes: [], networks: [] });
      assertStagingGone({ fx, record });
      if (signal === 'SIGINT') {
        // A6.6 R: once the started file exists the ticket cannot be launched again.
        const again = await runMain(context.argv(), { env: { PATH: process.env.PATH, ACODER_MODEL_API_KEY: fx.key }, deps: { launchEnabled: true } });
        assert.equal(again.code, 2, again.stderr);
        assert.match(again.stderr, /^refused: .*run-ct-S4-r1\.(started\.)?json already exists\n$/);
        assert.equal(lastLine(again.stdout), `ACODER LAUNCH ${fx.tag} refused -`);
      }
    });
  });
}
