import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import nodeTest from 'node:test';
import { INJECTED_ENV } from '../lib/run.mjs';
import { SKIP } from './helpers/container-env.mjs';
import { agentLines, assertNotStarted, containerDeps, withContainerEnv, withContainerRun } from './helpers/container-run.mjs';
import { lastLine, listing, runMain } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);
const SIDECAR_NAMES = ['ACODER_RUN_ID', 'ACODER_UPSTREAM_KEY', 'NODE_EXTRA_CA_CERTS', 'NODE_VERSION', 'PATH', 'YARN_VERSION'];

// S4-AC12 (DoD 8; SPEC-07) spec07-env, container part: the sidecar's reported names (its ready event) and the supervisor's own environment
// names (read by the agent from /proc/1/environ) equal the planned A8.3 names plus the runtime's injected allowance actually present; a
// marker variable and SSH_AUTH_SOCK in the launcher's own environment appear in neither container.
t('spec07-env: the sidecar and the supervisor have exactly the planned names plus the Docker allowance; host variables do not leak', async () => {
  const marker = `ACODER_TEST_MARKER_${randomBytes(4).toString('hex').toUpperCase()}`;
  await withContainerRun({
    scenario: 'script', env: { [marker]: 'leak', SSH_AUTH_SOCK: '/var/run/agent.sock' },
    steps: [{ do: 'probe', nonce: '0'.repeat(32), actions: [{ label: 'supervisor', op: 'environ-names', pid: 1 }] }, { do: 'exit', code: 0 }],
  }, async ({ record }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    const log = fs.readFileSync(record.log_path, 'utf8');
    const ready = JSON.parse(/ sidecar (\{"event":"ready".*)$/m.exec(log)[1]);
    const injected = ready.env_names.filter(name => !SIDECAR_NAMES.includes(name));
    assert.ok(SIDECAR_NAMES.every(name => ready.env_names.includes(name)), `the planned names are there: ${ready.env_names}`);
    assert.ok(injected.every(name => INJECTED_ENV.docker.includes(name)), `only the Docker allowance is added: ${injected}`);
    assert.deepEqual(injected.sort(), ['HOME', 'HOSTNAME'], 'Docker Desktop injects HOME and HOSTNAME into the sidecar (measured)');
    const probe = agentLines(record).find(line => line.stub === 'probe-results').results[0];
    assert.equal(probe.ok, true, JSON.stringify(probe));
    for (const names of [ready.env_names, probe.names]) {
      assert.ok(!names.includes(marker) && !names.includes('SSH_AUTH_SOCK'), 'no host variable leaks into a container');
    }
    const planned = ['ACODER_CONTAINER', 'ACODER_EVENT_PREFIX', 'ACODER_PROBE_INPUT', 'ACODER_RUN_ID', 'ACODER_TAG', 'ACODER_TICKET_SHA256', 'HOME', 'STUB_API_KEY', 'STUB_BASE_URL', 'TMPDIR', ...record.image.env_names];
    assert.deepEqual([...probe.names].sort(), [...planned, 'HOSTNAME'].sort(), 'the supervisor has the planned names plus the injected HOSTNAME only (measured)');
  });
});

// spec07-env: an extra variable added to the agent container's plan fails H2 (before anything in the container runs); with the inspect
// answer masked it fails P8 (gate-adverse-P8 of part 1 is the masked case).
t('spec07-env: an extra variable in the agent container\'s plan fails H2', async () => {
  const extra = plan => { const at = plan.agent.create.indexOf('--env'); plan.agent.create.splice(at, 0, '--env', 'EXTRA_NAME=1'); return plan; };
  await withContainerRun({ planTransform: extra }, async run => assertNotStarted(run, 'H2', 'env_names'));
});

// spec07-env: a fake `image inspect` answer with an unlisted variable name, or with a declared volume, is refused before any effect.
for (const [label, change, pattern] of [
  ['an unlisted environment variable name', info => { info.Config.Env.push('SECRET_TOKEN=x'); }, /SECRET_TOKEN/],
  ['a declared volume', info => { info.Config.Volumes = { '/data': {} }; }, /volume/],
]) {
  t(`spec07-env: an image inspect answer with ${label} is refused before any effect`, async () => {
    await withContainerEnv({}, async context => {
      const { fx } = context;
      const calls = [];
      const runtime = real => {
        const seam = context.runtimeSeam(real);
        return { ...seam, call: (args, extra) => { calls.push(args); return seam.call(args, extra); }, imageInspect: async ref => { const info = await real.imageInspect(ref); change(info[0]); return info; } };
      };
      const before = listing(fx.base);
      const out = await runMain(['review', 'run', ...context.argv()], { env: { PATH: process.env.PATH, ACODER_MODEL_API_KEY: fx.key }, deps: { ...containerDeps({}, context), runtime, launchEnabled: true } });
      assert.equal(out.code, 2, out.stderr);
      assert.match(out.stderr, pattern);
      assert.ok(!out.stderr.includes('=x'), 'a value is never named');
      assert.equal(lastLine(out.stdout), `ACODER LAUNCH ${fx.tag} refused -`);
      assert.deepEqual(listing(fx.base), before, 'no effect');
      assert.deepEqual(calls.filter(args => ['create', 'run', 'start'].includes(args[0]) || args[1] === 'create'), [], 'nothing was created');
    });
  });
}
