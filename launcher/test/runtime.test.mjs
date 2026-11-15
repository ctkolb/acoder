import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { checkImageAndRuntime } from '../lib/prepare.mjs';
import { Refusal } from '../lib/refusal.mjs';
import { createRuntime, findRuntime, RUN_LABEL_KEY } from '../lib/runtime.mjs';
import { IMAGE_ID, imageAnswer, makeFakeRuntime } from './helpers/fake-runtime.mjs';
import { mustAsync, thrownOf } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own and is registered from this file.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, fn);

const RUN = '20261115T101500Z-a1b2c3';
const LABEL = `${RUN_LABEL_KEY}=${RUN}`;

async function withFake(names, fn) {
  const fake = makeFakeRuntime(names);
  try { return await fn(fake); } finally { fake.cleanup(); }
}
const runtimeOf = (fake, name = 'docker', extra = {}) => createRuntime({ ...findRuntime(name, fake.env()), env: fake.env(extra), runId: RUN });
// The refusal message of a promise, or null when it resolves (the test then fails on its assertion).
const refusalOf = async promise => {
  try { await promise; return null; } catch (error) {
    assert.ok(error instanceof Refusal, `a refusal, not ${error?.constructor?.name}: ${error?.message}`);
    return error.message;
  }
};

// S4-AC1, A1.5: the runtime is --runtime, else docker when it is on PATH, else podman; a missing runtime is a refusal (exit code 2).
t('runtime: --runtime docker or podman is used when it is on PATH; without --runtime docker is preferred, then podman', async () => {
  await withFake(['docker', 'podman'], async fake => {
    assert.deepEqual(findRuntime('podman', fake.env()), { name: 'podman', bin: fake.bin('podman') });
    assert.deepEqual(findRuntime('docker', fake.env()), { name: 'docker', bin: fake.bin('docker') });
    assert.deepEqual(findRuntime(null, fake.env()), { name: 'docker', bin: fake.bin('docker') });
  });
  await withFake(['podman'], async fake => { assert.deepEqual(findRuntime(null, fake.env()), { name: 'podman', bin: fake.bin('podman') }); });
});

t('runtime: a missing runtime is a refusal naming it (no runtime on PATH, or the requested one is absent)', async () => {
  await withFake([], async fake => {
    const none = thrownOf(() => findRuntime(null, fake.env()));
    assert.equal(none, 'no container runtime is installed: neither docker nor podman is on PATH');
    assert.ok((() => { try { findRuntime(null, fake.env()); } catch (error) { return error instanceof Refusal; } return false; })());
  });
  await withFake(['docker'], async fake => {
    assert.equal(thrownOf(() => findRuntime('podman', fake.env())), 'the container runtime podman is not installed (not on PATH)');
    assert.equal(thrownOf(() => findRuntime('runc', fake.env())), 'the container runtime must be docker or podman');
  });
  assert.equal(thrownOf(() => findRuntime(null, {})), 'no container runtime is installed: neither docker nor podman is on PATH');
});

t('runtime: a daemon that does not answer is a refusal; one that answers gives the client and server versions', async () => {
  await withFake(['docker'], async fake => {
    assert.equal(await refusalOf(runtimeOf(fake, 'docker', { FAKE_MODE: 'down' }).answers()), 'the docker daemon does not answer');
    assert.deepEqual(await mustAsync(() => runtimeOf(fake).answers()), { name: 'docker', client_version: '29.0.0', server_version: '29.0.1' });
    assert.deepEqual(fake.calls().map(call => call.argv), [['version', '--format', '{{json .}}'], ['version', '--format', '{{json .}}']]);
  });
});

// S4-AC1: every runtime call is an argument array; nothing is joined into a shell string.
t('runtime: every argument reaches the runtime exactly as given (spaces, quotes, ;, $(...), backticks, globs), never through a shell', async () => {
  await withFake(['docker'], async fake => {
    const tricky = ['inspect', 'a b', "it's", 'x; touch pwned', '$(touch pwned)', '`id`', '*', '--format', '{{json .}}', ''];
    const result = await mustAsync(() => runtimeOf(fake).call(tricky));
    assert.equal(result.code, 0);
    assert.deepEqual(fake.calls().at(-1).argv, tricky);
  });
});

t('runtime: a shell string, a non-string element or an element with a NUL byte is refused before anything runs', async () => {
  await withFake(['docker'], async fake => {
    const runtime = runtimeOf(fake);
    for (const bad of ['ps -a', ['ps', 1], ['ps', null], ['ps', 'a\0b'], []]) {
      assert.match(String(await runtime.call(bad).then(() => null, error => error.message)), /^a runtime call is a non-empty argument array of strings/);
    }
    assert.deepEqual(fake.calls(), []);
  });
});

// S4-AC1: every created resource carries the label acoder.run=<run_id>.
t('runtime: create, run, network create and volume create without the run label (or with another run\'s) are refused before anything runs', async () => {
  await withFake(['docker'], async fake => {
    const runtime = runtimeOf(fake);
    const cases = [
      ['create', '--name', 'x', 'img'], ['run', '--rm', 'img'], ['network', 'create', 'n'], ['volume', 'create', 'v'], ['container', 'create', 'img'],
      ['create', '--label', `${RUN_LABEL_KEY}=other`, 'img'], ['create', `--label=${LABEL}`, 'img'], ['create', 'img', '--label', LABEL.toUpperCase()],
    ];
    for (const args of cases) assert.match(String(await runtime.call(args).then(() => null, error => error.message)), /^a created runtime resource must carry the label acoder\.run=/, JSON.stringify(args));
    assert.deepEqual(fake.calls(), []);
    for (const args of [['create', '--label', LABEL, 'img'], ['network', 'create', '--label', LABEL, 'n'], ['volume', 'create', '--label', LABEL, 'v']]) {
      assert.equal((await mustAsync(() => runtime.call(args))).code, 0);
    }
    assert.equal(fake.calls().length, 3);
  });
});

// A8.2: the key is only in the environment of the process that creates the sidecar; every other call runs without it.
t('runtime: the extra environment of one call reaches only that call; the base environment holds no key name', async () => {
  await withFake(['docker'], async fake => {
    const runtime = runtimeOf(fake);
    await mustAsync(() => runtime.call(['create', '--label', LABEL, 'img'], { extraEnv: { ACODER_UPSTREAM_KEY: 'k'.repeat(20) } }));
    await mustAsync(() => runtime.call(['create', '--label', LABEL, 'img2']));
    const [first, second] = fake.calls();
    assert.equal(first?.key_present, true);
    assert.equal(second?.key_present, false);
    assert.equal(thrownOf(() => createRuntime({ name: 'docker', bin: fake.bin('docker'), env: { ...fake.env(), ACODER_UPSTREAM_KEY: 'x' }, runId: RUN })), 'the base environment of the runtime must not hold ACODER_UPSTREAM_KEY');
  });
});

t('runtime: a call that does not end within its limit is killed and reported (code null), not left running', async () => {
  await withFake(['docker'], async fake => {
    const runtime = runtimeOf(fake);
    const hanging = runtimeOf(fake, 'docker', { FAKE_MODE: 'hang' });
    const started = Date.now();
    // The fake ends by itself after 20 s; a call that is not ended at its limit fails here on an assertion after 5 s.
    const result = await mustAsync(() => Promise.race([hanging.call(['ps'], { timeoutMs: 500 }), new Promise(resolve => setTimeout(() => resolve({ code: 'not ended within 5 s' }), 5000))]));
    assert.equal(result.code, null);
    assert.ok(Date.now() - started < 10000, 'the call ended at its limit');
    assert.equal((await mustAsync(() => runtime.call(['ps']))).code, 0);
  });
});

// A10.3 and A8.4 in state V with the image inspect of the runtime wrapper (S4-AC3).
const options = (over = {}) => ({ image: IMAGE_ID, allowImageEnv: [], ...over });

t('image check: the local image is inspected by its reference; id, repository digests and environment names are returned and NODE_VERSION and YARN_VERSION are accepted', async () => {
  await withFake(['docker'], async fake => {
    fake.setImage(imageAnswer());
    const result = await mustAsync(() => checkImageAndRuntime(options(), runtimeOf(fake)));
    assert.deepEqual(result.image, { ref: IMAGE_ID, id: IMAGE_ID, repo_digests: [], env_names: ['NODE_VERSION', 'PATH', 'YARN_VERSION'], allowed_env_names: [] });
    assert.deepEqual(result.runtime, { name: 'docker', client_version: '29.0.0', server_version: '29.0.1', host_os: process.platform, host_arch: process.arch });
    assert.deepEqual(fake.calls().map(call => call.argv), [['version', '--format', '{{json .}}'], ['image', 'inspect', IMAGE_ID]]);
  });
});

t('image check: a repository digest of the local image is accepted as <name>@sha256:', async () => {
  await withFake(['docker'], async fake => {
    const digest = `sha256:${'e'.repeat(64)}`;
    fake.setImage(imageAnswer({ RepoDigests: [`ref@${digest}`] }));
    const result = await mustAsync(() => checkImageAndRuntime(options({ image: `ref@${digest}` }), runtimeOf(fake)));
    assert.equal(result?.image?.id, IMAGE_ID);
    assert.deepEqual(result?.image?.repo_digests, [`ref@${digest}`]);
  });
});

t('image check: refusals of state V (each names the item, never a value; nothing else is called after the refusal)', async () => {
  const cases = [
    ['an image that is not on the host', null, options(), /^the image is not on this host \(image inspect found nothing; nothing is pulled\)$/],
    ['a digest that matches neither id nor repository digest', imageAnswer({ RepoDigests: [`ref@sha256:${'1'.repeat(64)}`] }), options({ image: `ref@sha256:${'2'.repeat(64)}` }), /matches neither the image id nor a repository digest/],
    ['an unlisted environment name', imageAnswer({ Config: { Env: ['PATH=/bin', 'SECRET_THING=value-not-shown'] } }), options(), /^the image defines the environment variable SECRET_THING, which is not on the list of A8.4/],
    ['a declared volume', imageAnswer({ Config: { Volumes: { '/data': {} } } }), options(), /^the image declares a volume$/],
    ['a tag', imageAnswer(), options({ image: 'node:22' }), /a tag or a bare name is refused/],
    ['a bare name', imageAnswer(), options({ image: 'acoder-reviewer-ref' }), /a tag or a bare name is refused/],
    ['an answer that is not one image', [], options(), /does not describe one local image/],
    ['an answer that is not JSON', 'not json', options(), /does not describe one local image/],
  ];
  for (const [what, answer, opts, pattern] of cases) {
    await withFake(['docker'], async fake => {
      if (answer !== null) fake.setImage(answer);
      const message = await refusalOf(checkImageAndRuntime(opts, runtimeOf(fake)));
      assert.match(String(message), pattern, what);
      assert.ok(!String(message).includes('value-not-shown'), 'a refusal never names a value');
      assert.ok(fake.calls().length <= 2, what);
    });
  }
});

t('image check: --allow-image-env accepts exactly the named variable', async () => {
  await withFake(['docker'], async fake => {
    fake.setImage(imageAnswer({ Config: { Env: ['PATH=/bin', 'EXTRA_ONE=1'] } }));
    const result = await mustAsync(() => checkImageAndRuntime(options({ allowImageEnv: ['EXTRA_ONE'] }), runtimeOf(fake)));
    assert.deepEqual(result?.image?.env_names, ['EXTRA_ONE', 'PATH']);
    assert.deepEqual(result?.image?.allowed_env_names, ['EXTRA_ONE']);
  });
});

t('image check: a daemon that does not answer is refused before the image is inspected', async () => {
  await withFake(['docker'], async fake => {
    fake.setImage(imageAnswer());
    assert.equal(await refusalOf(checkImageAndRuntime(options(), runtimeOf(fake, 'docker', { FAKE_MODE: 'down' }))), 'the docker daemon does not answer');
    assert.deepEqual(fake.calls().map(call => call.argv[0]), ['version']);
  });
});
