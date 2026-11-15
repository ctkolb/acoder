import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { checkImageAndRuntime } from '../lib/prepare.mjs';
import { Refusal } from '../lib/refusal.mjs';
import { createRuntime, findRuntime } from '../lib/runtime.mjs';
import { IMAGE_ID, SKIP } from './helpers/container-env.mjs';
import { mustAsync } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17).
const t = (name, fn, timeout = 60000) => nodeTest(name, { timeout, skip: SKIP }, fn);

const hostEnv = () => { const env = { ...process.env }; delete env.ACODER_UPSTREAM_KEY; return env; };
const runtime = () => createRuntime({ ...findRuntime(null, hostEnv()), env: hostEnv(), runId: '20261115T101500Z-c0ffee' });

// S4-AC3 and S4-AC1 with the REAL `image inspect` of the runtime on this host (A10.3, A8.4).
t('image check (real runtime): the test image is accepted by its id; its environment names are recorded; the daemon versions are read', async () => {
  const result = await mustAsync(() => checkImageAndRuntime({ image: IMAGE_ID(), allowImageEnv: [] }, runtime()));
  const expectedId = IMAGE_ID().slice(IMAGE_ID().indexOf('sha256:'));
  if (IMAGE_ID().startsWith('sha256:')) assert.equal(result.image.id, expectedId);
  assert.equal(result.image.ref, IMAGE_ID());
  assert.ok(result.image.env_names.includes('PATH'));
  assert.ok(result.image.env_names.every(name => ['PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'TZ', 'NODE_VERSION', 'YARN_VERSION'].includes(name)), `the image's names are on the built-in list: ${result.image.env_names}`);
  assert.match(result.runtime.server_version, /^\d+\.\d+/);
});

t('image check (real runtime): an image id that is not on the host is refused and nothing is pulled', async () => {
  const absent = `sha256:${'0'.repeat(63)}1`;
  const error = await runtime().answers().then(() => checkImageAndRuntime({ image: absent, allowImageEnv: [] }, runtime())).then(() => null, caught => caught);
  assert.ok(error instanceof Refusal, 'a refusal');
  assert.equal(error.message, 'the image is not on this host (image inspect found nothing; nothing is pulled)');
  const after = await runtime().call(['image', 'inspect', absent]);
  assert.notEqual(after.code, 0, 'the absent image was not pulled');
});
