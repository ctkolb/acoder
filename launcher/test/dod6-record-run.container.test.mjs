import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { CHECK_IDS } from '../lib/run.mjs';
import { validateRecord } from '../lib/record.mjs';
import { docker, IMAGE_ID, SKIP } from './helpers/container-env.mjs';
import { assertStagingGone, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// The mounts of a container as the runtime reports them (the test's own read of `inspect`, Mounts and Tmpfs only).
async function mountsOf(name, container) {
  const answer = JSON.parse((await docker(['container', 'inspect', '--format', '{"Mounts":{{json .Mounts}},"Tmpfs":{{json .HostConfig.Tmpfs}}}', name])).stdout);
  const strip = source => (typeof source === 'string' && source.startsWith('/host_mnt/') ? source.slice('/host_mnt'.length) : source);
  return [
    ...answer.Mounts.map(mount => ({ container, target: mount.Destination, kind: mount.Type === 'volume' ? 'volume' : mount.Type, mode: mount.RW ? 'rw' : 'ro', source: mount.Type === 'volume' ? mount.Name : strip(mount.Source) })),
    ...Object.keys(answer.Tmpfs ?? {}).map(target => ({ container, target, kind: 'tmpfs', mode: 'rw', source: null })),
  ];
}
const key = mount => `${mount.container} ${mount.target} ${mount.kind} ${mount.mode} ${mount.source}`;

// S4-AC15 (DoD 6) dod6-record-run: after a started run the record validates against schema 2 and its values equal the run's inputs and
// observations: image id, each mount from inspect with kind and mode, mount_summary, limits, hashes, checks; the call count and token totals
// equal the stub endpoint's own; usage.advisory holds the stub agent's own numbers; every forwarded egress entry has host, bytes, times and
// the sanitized response model; inputs.scratch_git_entries counts the Git entries the agent made. S4-AC19: the runtime block is filled.
t('dod6-record-run: the record of a real run validates and equals the run\'s inputs and observations, the endpoint\'s counts and the agent\'s own numbers', async () => {
  const observed = [];
  await withContainerRun({
    scenario: 'script', limits: { calls: 7, tokens: 900 },
    steps: [{ do: 'request' }, { do: 'request' }, { do: 'git-dirs' }, { do: 'reports' }, { do: 'exit', code: 0 }],
    hooks: { beforeRelease: async ({ names }) => { observed.push(...await mountsOf(names.agent, 'agent'), ...await mountsOf(names.egress, 'egress')); } },
  }, async ({ record, fx, endpointCount }) => {
    assert.deepEqual(validateRecord(record), [], 'the record validates against schema 2');
    assert.equal(record.exit_reason, 'done', JSON.stringify(record.conditions));
    assert.equal(record.image.id, IMAGE_ID());
    assert.equal(record.image.ref, IMAGE_ID());
    assert.deepEqual(record.mounts.map(key).sort(), observed.map(key).sort(), 'each mount as inspect reported it, with kind and mode');
    assert.deepEqual([...record.mount_summary.writable_host_paths].sort(), [fx.writable.scratch, fx.writable.reportMd, fx.writable.reportJson].sort());
    assert.deepEqual([...record.mount_summary.memory_mounts].sort(), ['/agent', '/run/acoder-egress', '/run/acoder-egress', '/tmp', '/work']);
    assert.ok(record.mount_summary.readonly_inputs.includes(fx.mailbox));
    assert.equal(record.mount_summary.equal_to_plan, true);
    assert.deepEqual(record.limits, { wall_seconds: 60, calls: 7, tokens: 900, scratch_max_bytes: 4294967296 });
    assert.deepEqual(record.ticket, { path: fx.ticket, sha256: fx.ticketSha });
    assert.deepEqual(record.exports.map(entry => [entry.role, entry.manifest_sha256]), fx.exports.map(entry => [entry.role, entry.manifestSha]));
    assert.deepEqual(record.isolation_checks.map(entry => [entry.id, entry.result]), CHECK_IDS.map(id => [id, 'pass']));
    assert.equal(record.usage.calls_forwarded, endpointCount(), 'calls_forwarded equals the endpoint\'s own count');
    assert.equal(endpointCount(), 2);
    assert.deepEqual(record.usage.tokens, { input: 22, output: 14, reasoning: 0, cached_input: 0, total: 36 }, 'the token totals equal the usage the endpoint answered');
    assert.deepEqual(record.usage.advisory, { calls: 3, tokens: null, counted_by: 'adapter:stub' }, 'the stub agent\'s own numbers (one step line at start and one per request)');
    const forwarded = record.egress_log.filter(entry => entry.decision === 'forwarded');
    assert.equal(forwarded.length, 2);
    for (const entry of forwarded) {
      assert.equal(entry.host, 'model.stub.test');
      assert.ok(entry.bytes_up > 0 && entry.bytes_down > 0);
      assert.ok(Date.parse(entry.opened) <= Date.parse(entry.closed));
      assert.equal(entry.response_model, 'stub-model');
    }
    assert.deepEqual([record.inputs.scratch_git_entries, record.inputs.scratch_git_entries_complete], [2, true], 'the Git entries the agent made in scratch');
    assert.equal(record.inputs.unchanged_at_end, true);
    assert.equal(record.runtime.name, 'docker', 'S4-AC19: the runtime block is filled on this host');
    const version = JSON.parse((await docker(['version', '--format', '{{json .}}'])).stdout);
    assert.deepEqual([record.runtime.server_version, record.runtime.client_version], [version.Server.Version, version.Client.Version]);
    assert.deepEqual([record.runtime.host_os, record.runtime.host_arch], [process.platform, process.arch]);
    assert.equal(record.log_path, path.join(fx.stage, `run-${fx.tag}.log`));
    assert.ok(fs.existsSync(record.log_path));
    assertStagingGone({ fx, record });
  });
});
