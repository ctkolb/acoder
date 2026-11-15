import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { docker, IMAGE_ID, SKIP } from './helpers/container-env.mjs';
import { agentNetworkExt, assertNotStarted, DNS_WRAPPER, dropRequest, insertBeforeImage, isAgent, isSidecar, maskAgentNetwork, pushSecurity, replaceIn, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// spec02-corroboration (SPEC-02): a sidecar double that serves the probe sockets correctly and drops, or delays beyond the limit, one
// event at a time; the agent marker never appears. The gate limit is shortened through the test seam deps.clock.gateMs.
for (const [what, replacements, id] of [
  ['ready dropped', [["  print({ event: 'ready',", "  if (false) print({ event: 'ready',"]], 'U1'],
  ['upstream dropped', [["if (!stopped) emit({ event: 'upstream',", "if (false) emit({ event: 'upstream',"]], 'U2'],
  ['the host refusal event dropped', dropRequest("record.reason === 'acoder_host_not_allowed'"), 'P4'],
  ['the path refusal event dropped', dropRequest("record.reason === 'acoder_path_not_allowed'"), 'P4'],
  ['the probe path event dropped', dropRequest("record.decision === 'local'"), 'P5'],
  ['the not-released event dropped', dropRequest("record.reason === 'acoder_not_released'"), 'P5'],
  ['the host refusal event reporting another reason (the supervisor reports P4 pass)', [['    totals.bytes_down += record.bytes_down;\n    emit(record);', "    totals.bytes_down += record.bytes_down;\n    if (record.reason === 'acoder_host_not_allowed') record.reason = 'acoder_path_not_allowed';\n    emit(record);"]], 'P4'],
]) {
  t(`spec02-corroboration: ${what}: ${id} fails and the agent marker never appears`, async () => {
    await withContainerRun({ sidecar: replacements, gateMs: 12000 }, async run => assertNotStarted(run, id));
  });
}
