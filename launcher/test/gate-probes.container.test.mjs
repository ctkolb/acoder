import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { docker, IMAGE_ID, SKIP } from './helpers/container-env.mjs';
import { agentNetworkExt, assertNotStarted, DNS_WRAPPER, dropRequest, insertBeforeImage, isAgent, isSidecar, maskAgentNetwork, pushSecurity, replaceIn, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// gate-adverse-<ID> for the probes P3, P4, P5, P7 and P8 (S4-AC5).
t('gate-adverse-P3: a hosts file with one more entry fails P3', async () => {
  await withContainerRun({ planTransform: plan => { plan.payload_files.agent['etc/hosts'] += '127.0.0.1 extra.stub.test\n'; return plan; } }, async run => assertNotStarted(run, 'P3', 'hosts_changed'));
});

t('gate-adverse-P3: a resolv file naming a server fails P3', async () => {
  await withContainerRun({ planTransform: plan => { plan.payload_files.agent['etc/resolv.conf'] = 'nameserver 10.255.255.1\n'; return plan; } }, async run => assertNotStarted(run, 'P3', 'resolv_changed'));
});

t('gate-adverse-P4: a sidecar double that lets a denied host through fails P4', async () => {
  await withContainerRun({ sidecar: [['return allowlist.find(entry => entry === match[1]) ?? null;', 'return allowlist[0];']] }, async run => assertNotStarted(run, 'P4', 'host_not_refused'));
});

t('gate-adverse-P5: a sidecar double that forwards before the release fails P5 (the stub endpoint counts the forwarded request)', async () => {
  await withContainerRun({ sidecar: [["    if (phase === 'probe') {\n      const code = accounting.check(now());", "    if (false) {\n      const code = accounting.check(now());"]] }, async run => {
    assertNotStarted(run, 'P5', 'released_before_release');
    assert.ok(run.record.egress_log.some(entry => entry.decision === 'forwarded' && entry.phase === 'probe'));
  });
});

t('gate-adverse-P5: a sidecar double whose probe path does not answer fails P5', async () => {
  await withContainerRun({ sidecar: [["const PROBE_PATH = '/__acoder/probe';", "const PROBE_PATH = '/__acoder/elsewhere';"]] }, async run => assertNotStarted(run, 'P5', 'probe_path_failed'));
});

t('gate-adverse-P7: the snapshot mounted read-write with a writable stage folder copy (inspect altered so that H2 passes) fails P7', async () => {
  await withContainerRun({
    afterSnapshot: ({ mailbox }, { fx }) => fs.chmodSync(path.join(mailbox, path.relative(fx.mailbox, fx.stage)), 0o755),
    planTransform: (plan, { fx }) => { plan.agent.create = plan.agent.create.map(item => (item.endsWith(`target=${fx.mailbox},readonly`) ? item.replace(/,readonly$/, '') : item)); return plan; },
    alter: (kind, name, info, { fx }) => { if (kind === 'container' && isAgent(name)) for (const mount of info.Mounts) if (mount.Destination === fx.mailbox) mount.RW = false; return info; },
  }, async run => { assertNotStarted(run, 'P7', 'readonly_writable'); assert.equal(run.check('H2').result, 'pass'); });
});

t('gate-adverse-P8: one extra environment variable in the agent container (inspect altered) fails P8', async () => {
  await withContainerRun({
    planTransform: plan => { plan.agent.create = insertBeforeImage(plan.agent.create, ['--env', 'EXTRA_PROBE_VAR=1']); return plan; },
    alter: (kind, name, info) => { if (kind === 'container' && isAgent(name)) info.Config.EnvNames = info.Config.EnvNames.filter(item => item !== 'EXTRA_PROBE_VAR'); return info; },
  }, async run => { assertNotStarted(run, 'P8', 'env_names'); assert.equal(run.check('H2').result, 'pass'); });
});

t('gate-adverse-P8: the agent container with seccomp unconfined (test only; inspect altered to mask H2) fails P8', async () => {
  await withContainerRun({
    planTransform: plan => { plan.agent.create = insertBeforeImage(plan.agent.create, ['--security-opt', 'seccomp=unconfined']); return plan; },
    alter: (kind, name, info) => { if (kind === 'container' && isAgent(name)) info.HostConfig.SecurityOpt = info.HostConfig.SecurityOpt.filter(item => !item.startsWith('seccomp')); return info; },
  }, async run => { assertNotStarted(run, 'P8', 'seccomp'); assert.equal(run.check('H2').result, 'pass'); });
});
