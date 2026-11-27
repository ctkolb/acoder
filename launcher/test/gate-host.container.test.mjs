import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { docker, IMAGE_ID, SKIP } from './helpers/container-env.mjs';
import { agentNetworkExt, assertNotStarted, DNS_WRAPPER, dropRequest, insertBeforeImage, isAgent, isSidecar, maskAgentNetwork, pushSecurity, replaceIn, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// gate-adverse-<ID> for the host checks H1 to H4 (S4-AC5): the property is really broken; that check fails and nothing is released.
t('gate-adverse-H1: the agent container attached to EXT fails H1; nothing is released', async () => {
  await withContainerRun({ planTransform: agentNetworkExt }, async run => assertNotStarted(run, 'H1', 'network'));
});

t('gate-adverse-H2: an extra read-write bind of a synthetic directory fails H2', async () => {
  await withContainerRun({
    planTransform: (plan, { base }) => {
      const extra = path.join(base, 'extra');
      fs.mkdirSync(extra, { recursive: true });
      plan.agent.create = insertBeforeImage(plan.agent.create, ['--mount', `type=bind,source=${extra},target=/extra`]);
      return plan;
    },
  }, async run => assertNotStarted(run, 'H2', 'mounts'));
});

t('gate-adverse-H2: the mailbox mount made rw fails H2', async () => {
  await withContainerRun({
    planTransform: (plan, { fx }) => { plan.agent.create = plan.agent.create.map(item => (item.endsWith(`target=${fx.mailbox},readonly`) ? item.replace(/,readonly$/, '') : item)); return plan; },
  }, async run => assertNotStarted(run, 'H2', 'mounts'));
});

t('gate-adverse-H2: a seccomp profile option in the agent container\'s inspect fails H2', async () => {
  await withContainerRun({ alter: pushSecurity(isAgent, 'seccomp=/etc/acoder-test-profile.json') }, async run => assertNotStarted(run, 'H2', 'seccomp_option'));
});

t('gate-adverse-H2: seccomp=unconfined in the agent container\'s inspect fails H2', async () => {
  await withContainerRun({ alter: pushSecurity(isAgent, 'seccomp=unconfined') }, async run => assertNotStarted(run, 'H2', 'seccomp_option'));
});

t('gate-adverse-H3: a published port in the sidecar\'s inspect fails H3; the agent container is never created', async () => {
  await withContainerRun({
    alter: (kind, name, info) => { if (kind === 'container' && isSidecar(name)) info.HostConfig.PortBindings = { '443/tcp': [{ HostIp: '127.0.0.1', HostPort: '8443' }] }; return info; },
  }, async run => { assertNotStarted(run, 'H3', 'published_port'); assert.equal(run.check('H1').result, 'not_run'); });
});

t('gate-adverse-H3: the sidecar with the default log driver fails H3', async () => {
  await withContainerRun({
    planTransform: plan => { const at = plan.egress.create.indexOf('--log-driver'); plan.egress.create.splice(at, 2); return plan; },
  }, async run => assertNotStarted(run, 'H3', 'log_driver'));
});

t('gate-adverse-H3: a seccomp profile option in the sidecar\'s inspect fails H3', async () => {
  await withContainerRun({ alter: pushSecurity(isSidecar, 'seccomp=/etc/acoder-test-profile.json') }, async run => assertNotStarted(run, 'H3', 'seccomp_option'));
});

t('gate-adverse-H3: seccomp=unconfined in the sidecar\'s inspect fails H3', async () => {
  await withContainerRun({ alter: pushSecurity(isSidecar, 'seccomp=unconfined') }, async run => assertNotStarted(run, 'H3', 'seccomp_option'));
});

t('gate-adverse-H4: a request-socket volume without the planned options fails H4', async () => {
  await withContainerRun({
    planTransform: plan => { plan.volume.create = plan.volume.create.map(item => item.replace(/^o=size=1m,/, 'o=size=2m,')); return plan; },
  }, async run => assertNotStarted(run, 'H4', 'volume_options'));
});

// The launcher's own EXT (no deps.egressNetwork; made --internal by the transform so that nothing can leave the host): H4 checks its label
// and that no other container is attached, and the network is removed with the run. The stub endpoint is not on it, so U2 fails.
t('gate: an EXT the launcher creates itself carries the run label, passes H4 and is removed with the run (here U2 fails: no endpoint on it)', async () => {
  await withContainerRun({
    ownNetwork: true,
    planTransform: plan => { plan.network.create = ['network', 'create', '--internal', ...plan.network.create.slice(2)]; return plan; },
  }, async run => {
    assertNotStarted(run, 'U2', 'handshake');
    assert.equal(run.check('H4').result, 'pass');
    assert.equal(run.record?.network.egress_network_created, true);
    assert.match(run.record.network.egress_network, /^acoder-ext-\d{8}T\d{6}Z-[0-9a-f]{6}$/);
  });
});
