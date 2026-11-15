import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { docker, IMAGE_ID, SKIP } from './helpers/container-env.mjs';
import { agentNetworkExt, assertNotStarted, DNS_WRAPPER, dropRequest, insertBeforeImage, isAgent, isSidecar, maskAgentNetwork, pushSecurity, replaceIn, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// gate-adverse-<ID> for the network probes P1, P2 and P6 (S4-AC5).
t('gate-adverse-P1: the agent container attached to EXT (inspect altered so that H1 and H2 pass) fails P1 in the container', async () => {
  await withContainerRun({ planTransform: agentNetworkExt, alter: maskAgentNetwork }, async run => {
    assertNotStarted(run, 'P1', 'device_up');
    assert.equal(run.check('H1').result, 'pass');
    assert.equal(run.check('H2').result, 'pass');
  });
});

t('gate-adverse-P2: a DNS responder on 127.0.0.1:53 in the agent container (any answer, also "no such name") fails P2', async () => {
  await withContainerRun({
    skillFiles: [{ name: 'dns-wrapper.mjs', text: DNS_WRAPPER }],
    planTransform: plan => { plan.agent.create = replaceIn(plan.agent.create, '/acoder/container/entry.mjs', '/acoder/skill/dns-wrapper.mjs'); return plan; },
    alter: (kind, name, info) => { if (kind === 'container' && isAgent(name)) { info.Config.Cmd = ['/acoder/container/entry.mjs']; info.Args = ['/acoder/container/entry.mjs']; } return info; },
  }, async run => { assertNotStarted(run, 'P2', 'dns_answer'); assert.equal(run.check('H2').result, 'pass'); });
});

t('gate-adverse-P6: the agent container attached to EXT (inspect altered) reaches the upstream address and fails P6; a control container on EXT reaches it too', async () => {
  await withContainerRun({
    planTransform: agentNetworkExt,
    alter: maskAgentNetwork,
  }, async run => {
    assertNotStarted(run, 'P1', 'device_up');
    const probes = run.record.isolation_checks.find(entry => entry.id === 'P6');
    assert.deepEqual([probes.result, probes.detail], ['fail', 'connected']);
    const control = await docker(['run', '--rm', ...run.ids.labels, '--network', run.network, '--pull', 'never', '--log-driver', 'none', '--entrypoint', 'node', IMAGE_ID(), '-e',
      `require('node:net').connect(443, '${run.endpointAddress}').on('connect', () => { console.log('reached'); process.exit(0); }).on('error', () => process.exit(3));`]);
    assert.equal(control.stdout.trim(), 'reached', 'the control container on EXT reaches the upstream address');
  });
});
