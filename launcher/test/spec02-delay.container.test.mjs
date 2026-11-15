import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { docker, IMAGE_ID, SKIP } from './helpers/container-env.mjs';
import { agentNetworkExt, assertNotStarted, DNS_WRAPPER, dropRequest, insertBeforeImage, isAgent, isSidecar, maskAgentNetwork, pushSecurity, replaceIn, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// spec02-corroboration (SPEC-02), the delay case in a module of its own: the sidecar's ready event comes later than the gate limit
// (shortened through deps.clock.gateMs); U1 fails and the agent marker never appears.
t('spec02-corroboration: ready delayed beyond the gate limit: U1 fails and the agent marker never appears', async () => {
  await withContainerRun({ sidecar: [["  print({ event: 'ready',", "  await new Promise(resolve => setTimeout(resolve, 20000));\n  print({ event: 'ready',"]], gateMs: 12000 }, async run => assertNotStarted(run, 'U1'));
});
