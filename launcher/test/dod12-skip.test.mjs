import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { containerSkipReason, testRuntime } from './helpers/container-env.mjs';
import { fixtureBase, forceRemove, LAUNCHER } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own and is registered from this file.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, fn);

const IMAGE = `sha256:${'c'.repeat(64)}`;
const yes = () => true;
const no = () => false;

// DoD 12, S4-AC17: the gate of the container tests with a fake environment.
t('dod12-skip: without ACODER_TEST_IMAGE every container test is skipped with that reason', () => {
  assert.equal(containerSkipReason({}, { runtime: 'docker', answers: yes }), 'ACODER_TEST_IMAGE is not set');
  assert.equal(containerSkipReason({ ACODER_TEST_IMAGE: '' }, { runtime: 'docker', answers: yes }), 'ACODER_TEST_IMAGE is not set');
});

t('dod12-skip: an image given as a tag or a bare name is a skip reason, not a run', () => {
  for (const image of ['node:22', 'acoder-reviewer-ref', `sha256:${'C'.repeat(64)}`, `sha256:${'c'.repeat(63)}`]) {
    assert.match(String(containerSkipReason({ ACODER_TEST_IMAGE: image }, { runtime: 'docker', answers: yes })), /is not <name>@sha256/);
  }
  assert.equal(containerSkipReason({ ACODER_TEST_IMAGE: `ref@${IMAGE}` }, { runtime: 'docker', answers: yes }), false);
});

t('dod12-skip: no runtime installed, or a daemon that does not answer, is a skip reason', () => {
  assert.equal(containerSkipReason({ ACODER_TEST_IMAGE: IMAGE }, { runtime: null, answers: yes }), 'no container runtime (docker or podman) is installed');
  assert.equal(containerSkipReason({ ACODER_TEST_IMAGE: IMAGE }, { runtime: 'podman', answers: no }), 'the podman daemon does not answer');
  assert.equal(containerSkipReason({ ACODER_TEST_IMAGE: IMAGE }, { runtime: 'docker', answers: yes }), false);
});

t('dod12-skip: the runtime is docker when it is on PATH, else podman, else none', () => {
  const on = names => file => names.some(name => file === `/x/bin/${name}`);
  assert.equal(testRuntime({ PATH: '/x/bin' }, on(['docker', 'podman'])), 'docker');
  assert.equal(testRuntime({ PATH: '/x/bin' }, on(['podman'])), 'podman');
  assert.equal(testRuntime({ PATH: '/x/bin' }, on([])), null);
  assert.equal(testRuntime({}, on(['docker'])), null);
});

// `npm run check:container` without an image: require-container prints NOT_CHECKED and exits 1 (A11 3).
t('dod12-skip: require-container prints NOT_CHECKED with the reason and exits 1 without an image; 0 is never printed as a pass', () => {
  const env = { ...process.env };
  delete env.ACODER_TEST_IMAGE;
  const result = spawnSync(process.execPath, [path.join(LAUNCHER, 'test/helpers/require-container.mjs')], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'NOT_CHECKED: ACODER_TEST_IMAGE is not set\n');
});

t('dod12-skip: require-container reports a missing runtime as NOT_CHECKED (an empty PATH)', () => {
  const dir = fs.mkdtempSync(path.join(fixtureBase(), 'acr-'));
  try {
    const result = spawnSync(process.execPath, [path.join(LAUNCHER, 'test/helpers/require-container.mjs')], { env: { PATH: dir, ACODER_TEST_IMAGE: IMAGE }, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, 'NOT_CHECKED: no container runtime (docker or podman) is installed\n');
  } finally { forceRemove(dir); }
});

t('dod12-skip: the package scripts are exactly those of K1.3', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(LAUNCHER, '..', 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['check:container'], 'node launcher/test/helpers/require-container.mjs && node --test launcher/test/*.container.test.mjs');
  assert.equal(scripts['test:container:cleanup'], 'node launcher/test/helpers/cleanup-containers.mjs');
  assert.equal(scripts.test, 'node --test scripts/*.test.mjs launcher/test/*.test.mjs');
});
