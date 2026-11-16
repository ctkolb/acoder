import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import nodeTest from 'node:test';
import { docker, IMAGE_ID, removeLabelled, SKIP, testIds } from './helpers/container-env.mjs';
import { assertStagingGone, probeResults, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);
const HOST_NAME = 'host.docker.internal';

// A listener on the host's loopback address (Docker Desktop forwards its host name there; nothing on the local network can reach it), on a
// port the test picks itself; it counts the connections it accepts.
async function hostListener() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 40000 + randomBytes(2).readUInt16BE(0) % 20000;
    const state = { count: 0 };
    const server = net.createServer(socket => { state.count += 1; socket.end(); });
    const ok = await new Promise(resolve => { server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => resolve(true)); });
    if (ok) return { port, state, close: () => new Promise(resolve => server.close(() => resolve())) };
  }
  throw new Error('no free port for the host listener');
}

// The one control of D-R39: one labelled ordinary bridge network and one short-lived control container of the test image (--pull never)
// whose only action is a single TCP connect to the listener through the runtime's host name; both removed here, also on failure.
async function control(port) {
  const ids = testIds();
  const network = `acoder-test-bridge-${ids.id}`;
  try {
    const made = await docker(['network', 'create', ...ids.labels, network]);
    assert.equal(made.code, 0, made.stderr);
    const run = await docker(['run', '--rm', ...ids.labels, '--network', network, '--pull', 'never', '--cap-drop', 'ALL', '--read-only', '--entrypoint', 'node', IMAGE_ID(), '-e',
      `require('node:net').connect(${port}, '${HOST_NAME}').on('connect', function () { console.log('reached ' + this.remoteAddress); process.exit(0); }).on('error', () => process.exit(3));`], { timeoutMs: 30000 });
    return { reached: run.code === 0, address: /^reached (\S+)$/.exec(run.stdout.trim())?.[1] ?? null };
  } finally {
    const left = await removeLabelled(ids.filter);
    assert.deepEqual(left, { containers: [], volumes: [], networks: [] }, 'the control network and container are removed');
  }
}

// S4-AC9 (DoD 3, SPEC-06) spec06-host-listener: the test opens a listener on the host; a control container on an ordinary bridge network
// connects to it through the runtime's host name; if the control cannot connect the sub-check is NOT_CHECKED (the test is skipped with that
// reason); otherwise the agent container's attempt to the same address and port, by name and by the address the control used, fails.
t('spec06-host-listener: a host listener reachable from an ordinary bridge network through the runtime host name is not reachable from the agent container', async context => {
  const listener = await hostListener();
  try {
    const reach = await control(listener.port);
    if (!reach.reached) { context.skip(`NOT_CHECKED: the control container could not connect to the host listener through ${HOST_NAME}`); return; }
    assert.equal(listener.state.count, 1, 'control: the host listener accepted the control connection');
    const nonce = randomBytes(16).toString('hex');
    await withContainerRun({
      scenario: 'script',
      steps: [{ do: 'probe', nonce, actions: [
        { label: 'by-name', op: 'connect', host: HOST_NAME, port: listener.port, ms: 20000 },
        { label: 'by-address', op: 'connect', host: reach.address, port: listener.port },
        { label: 'twin', op: 'http' },
      ] }, { do: 'exit', code: 0 }],
    }, async ({ record, fx }) => {
      assert.ok(record !== null && record.agent_started === true, 'the agent ran');
      const results = probeResults(record, nonce);
      assert.ok(results['by-name'].ok === false && ['ENOTFOUND', 'EAI_AGAIN'].includes(results['by-name'].code), `the runtime host name does not resolve in the agent container: ${results['by-name'].code}`);
      assert.equal(results['by-address'].ok, false, `the address the control reached fails from the agent container (${results['by-address'].code})`);
      assert.equal(results.twin.status, 200, 'twin: the sidecar path works');
      assert.equal(listener.state.count, 1, 'the host listener saw no connection from the agent container');
      assertStagingGone({ fx, record });
    });
  } finally { await listener.close(); }
});
