import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listing, t, withFixture } from './helpers/fixtures.mjs';

// S2-AC18 (skeleton): --dry-run performs states V and S, prints the plan as JSON, exits 0, removes the staging directory,
// creates nothing in the mailbox and prints no key value. The image and runtime checks are not_run until stage S4.
t('dry-run: prints one JSON plan, exits 0 and leaves nothing behind', () => withFixture({}, async fx => {
  const before = listing(fx.base);
  const result = await fx.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trimEnd().split('\n').filter(line => line.startsWith('ACODER LAUNCH')).length, 0);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.dry_run, true);
  assert.equal(plan.tag, fx.tag);
  assert.equal(plan.image.check, 'not_run');
  assert.equal(plan.runtime.check, 'not_run');
  assert.equal(plan.image.ref, `sha256:${'b'.repeat(64)}`);
  assert.equal(plan.agent, 'opencode');
  assert.equal(plan.provider, 'openai');
  assert.equal(plan.model, 'gpt-6-luna');
  assert.equal(plan.effort, 'high');
  assert.equal(plan.endpoint, 'https://models.example.org/v1');
  assert.deepEqual(plan.limits, { wall_seconds: 300, calls: 10, tokens: 1000, max_in_flight: 4, scratch_max_bytes: 4294967296 });
  assert.equal(plan.key.env, 'ACODER_MODEL_API_KEY');
  assert.ok(!result.stdout.includes(fx.key) && !result.stderr.includes(fx.key), 'no key value is printed');
  assert.deepEqual(listing(fx.base), before, 'the mailbox, the exports and the staging directory are unchanged');
  assert.equal(fs.existsSync(fx.writable.scratch), false);
  assert.equal(fs.existsSync(fx.writable.reportMd), false);
}));
