import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import nodeTest from 'node:test';
import { docker, IMAGE_ID, SKIP } from './helpers/container-env.mjs';
import { assertStagingGone, probeResults, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);
// A name that is not in the hosts file fails: there is no name server (musl then answers "not found" or "try again").
const NAME_FAILURES = ['ENOTFOUND', 'EAI_AGAIN'];

// S4-AC9 (DoD 3) dod3-network, in the test topology of A11 (EXT internal, the stub endpoint and the forbidden server on it): from the agent
// container example.com on 80 and 443 fails, the forbidden server's raw address fails, example.com and forbidden.stub.test do not resolve,
// DNS queries to the loopback addresses and to the EXT gateway get no answer; the allowed name resolves to 127.0.0.1 and a model request
// through the sidecar succeeds (the stub endpoint counts it). Control: a container on EXT resolves and reaches forbidden.stub.test. The
// egress log shows the forwarded request (bytes, phase agent) and the probe-phase entries of the gate.
t('dod3-network: from the agent container only the sidecar path works; the forbidden server, outside names and DNS fail; a control container on EXT reaches the forbidden server', async () => {
  const nonce = randomBytes(16).toString('hex');
  await withContainerRun({
    scenario: 'script', forbidden: true,
    steps: ({ forbiddenAddress, gateway }) => {
      assert.ok(typeof forbiddenAddress === 'string' && typeof gateway === 'string', 'the forbidden server and the EXT gateway have addresses');
      return [{ do: 'probe', nonce, actions: [
        { label: 'example:80', op: 'connect', host: 'example.com', port: 80, ms: 20000 },
        { label: 'example:443', op: 'connect', host: 'example.com', port: 443, ms: 20000 },
        { label: 'forbidden:raw', op: 'connect', host: forbiddenAddress, port: 80 },
        { label: 'resolve:example', op: 'resolve', name: 'example.com' },
        { label: 'resolve:forbidden', op: 'resolve', name: 'forbidden.stub.test' },
        ...['127.0.0.1', '::1', '127.0.0.11', gateway].map(server => ({ label: `dns:${server}`, op: 'dns', server, name: 'forbidden.stub.test' })),
        { label: 'resolve:allowed', op: 'resolve', name: 'model.stub.test' },
        { label: 'model', op: 'http' },
      ] }, { do: 'exit', code: 0 }];
    },
  }, async ({ record, fx, network, forbiddenAddress, forbiddenCount, endpointCount, ids, gateway }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    const results = probeResults(record, nonce);
    const unresolved = label => assert.ok(results[label].ok === false && NAME_FAILURES.includes(results[label].code), `${label} fails at name resolution: ${results[label].code}`);
    for (const label of ['example:80', 'example:443']) unresolved(label);
    assert.equal(results['forbidden:raw'].ok, false, `the forbidden server's raw address fails (${results['forbidden:raw'].code})`);
    assert.ok(['ENETUNREACH', 'EHOSTUNREACH', 'TIMEOUT'].includes(results['forbidden:raw'].code), results['forbidden:raw'].code);
    for (const label of ['resolve:example', 'resolve:forbidden']) unresolved(label);
    const dnsLabels = ['127.0.0.1', '::1', '127.0.0.11', gateway].map(server => `dns:${server}`);
    assert.deepEqual(Object.keys(results).filter(name => name.startsWith('dns:')).sort(), [...dnsLabels].sort(), 'exactly the four DNS probes answered');
    assert.equal(Object.keys(results).filter(name => name.startsWith('dns:')).length, 4);
    for (const label of Object.keys(results).filter(name => name.startsWith('dns:'))) assert.deepEqual([results[label].ok, results[label].answered ?? false], [false, false], `${label} gets no answer`);
    assert.deepEqual(results['resolve:allowed'].addresses, ['127.0.0.1'], 'the allowed name resolves to 127.0.0.1 only');
    assert.deepEqual([results.model.ok, results.model.status], [true, 200], 'a model request through the sidecar succeeds');
    assert.equal(endpointCount(), 1, 'the stub endpoint counted the request');
    assert.equal(forbiddenCount(), 0, 'nothing reached the forbidden server from the agent container');
    // Control: a container on EXT resolves forbidden.stub.test and reaches it.
    const control = await docker(['run', '--rm', ...ids.labels, '--network', network, '--pull', 'never', '--entrypoint', 'node', IMAGE_ID(), '-e',
      "require('node:dns').lookup('forbidden.stub.test', (e, a) => { if (e) process.exit(4); require('node:net').connect(80, a).on('connect', () => { console.log('reached ' + a); process.exit(0); }).on('error', () => process.exit(3)); });"]);
    assert.equal(control.stdout.trim(), `reached ${forbiddenAddress}`, 'the control container resolves and reaches the forbidden server');
    assert.equal(forbiddenCount(), 1, 'the forbidden server counted the control connection');
    // The egress log: the forwarded request in phase agent with byte counts, and the gate's probe-phase entries.
    const forwarded = record.egress_log.filter(entry => entry.decision === 'forwarded');
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].phase, 'agent');
    assert.equal(forwarded[0].host, 'model.stub.test');
    assert.ok(forwarded[0].bytes_up > 0 && forwarded[0].bytes_down > 0, 'non-zero byte counts');
    assert.equal(forwarded[0].status, 200);
    const probePhase = record.egress_log.filter(entry => entry.phase === 'probe');
    assert.deepEqual(probePhase.map(entry => [entry.decision, entry.reason]).sort(), [['local', null], ['refused', 'acoder_host_not_allowed'], ['refused', 'acoder_not_released'], ['refused', 'acoder_path_not_allowed']]);
    assertStagingGone({ fx, record });
  });
});
