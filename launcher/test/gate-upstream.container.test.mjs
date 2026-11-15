import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { docker, IMAGE_ID, SKIP } from './helpers/container-env.mjs';
import { agentNetworkExt, assertNotStarted, DNS_WRAPPER, dropRequest, insertBeforeImage, isAgent, isSidecar, maskAgentNetwork, pushSecurity, replaceIn, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// gate-adverse-<ID> for the sidecar checks U1 and U2 (S4-AC5, D-R32).
t('gate-adverse-U1: a sidecar double reporting another configuration hash fails U1', async () => {
  await withContainerRun({ sidecar: [["config_sha256: createHash('sha256').update(text).digest('hex')", "config_sha256: 'f'.repeat(64)"]] }, async run => assertNotStarted(run, 'U1', 'config_hash'));
});

t('gate-adverse-U1: a sidecar double whose first probe answer is in another phase fails U1 (D-R32: the phase comes from the first probe answer)', async () => {
  await withContainerRun({ sidecar: [["let phase = 'probe';", "let phase = 'agent';"]] }, async run => assertNotStarted(run, 'U1', 'phase'));
});

t('gate-adverse-U2: the stub endpoint stopped fails U2', async () => {
  await withContainerRun({ endpoint: 'stopped' }, async run => assertNotStarted(run, 'U2', 'handshake'));
});

t('gate-adverse-U2: the stub endpoint serving an untrusted certificate fails U2', async () => {
  await withContainerRun({ endpoint: 'untrusted' }, async run => assertNotStarted(run, 'U2', 'handshake'));
});
