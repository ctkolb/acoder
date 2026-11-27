import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodeTest from 'node:test';
import { listing, withFixture, parseJson } from './helpers/fixtures.mjs';
import { PLACEHOLDER_KEY } from '../lib/plan.mjs';
import { LAUNCHER_VERSION as CLI_VERSION } from '../lib/cli.mjs';
import { LAUNCHER_VERSION as RUN_VERSION } from '../lib/run.mjs';

// G11: every test has a finite time limit of its own. The test is registered from this file, so that the mutation runner can count it per module.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, async (...args) => {
  // A failure that is not an assertion (a TypeError from a broken module) is reported as an assertion failure.
  try { return await fn(...args); } catch (error) { if (error?.code === 'ERR_ASSERTION') throw error; assert.fail(`threw: ${String(error?.message ?? error)}`); }
});

// S2-AC18 (skeleton): --dry-run performs states V and S, prints the plan as JSON, exits 0, removes the staging directory,
// creates nothing in the mailbox and prints no key value. The image and runtime checks are not_run until stage S4.
t('dry-run: prints one JSON plan, exits 0 and leaves nothing behind', () => withFixture({}, async fx => {
  const before = listing(fx.base);
  const result = await fx.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trimEnd().split('\n').filter(line => line.startsWith('ACODER LAUNCH')).length, 0);
  const plan = parseJson(result.stdout);
  assert.equal(plan.dry_run, true);
  assert.equal(plan.tag, fx.tag);
  assert.equal(plan.image.check, 'not_run');
  assert.equal(plan.runtime.check, 'not_run');
  assert.equal(plan.image.ref, `sha256:${'b'.repeat(64)}`);
  assert.equal(plan.agent, 'opencode');
  assert.equal(plan.provider, 'openai');
  assert.equal(plan.model, 'gpt-6-luna');
  assert.equal(plan.effort, 'high');
  assert.equal(plan.endpoint, 'https://models.example.org/v1');
  assert.deepEqual(plan.limits, { wall_seconds: 300, calls: 10, tokens: 1000, max_in_flight: 4, scratch_max_bytes: 4294967296 });
  assert.equal(plan.key.env, 'ACODER_MODEL_API_KEY');
  assert.ok(!result.stdout.includes(fx.key) && !result.stderr.includes(fx.key), 'no key value is printed');
  assert.deepEqual(listing(fx.base), before, 'the mailbox, the exports and the staging directory are unchanged');
  assert.equal(fs.existsSync(fx.writable.scratch), false);
  assert.equal(fs.existsSync(fx.writable.reportMd), false);
}));

// DoD 1 (rule R-A): --model z-ai/glm-5.3 with --provider openai is kept whole in the plan and reaches opencode as openai/z-ai/glm-5.3.
t('dry-run: --model z-ai/glm-5.3 is the plan model and the agent command passes -m openai/z-ai/glm-5.3', () => withFixture({}, async fx => {
  const result = await fx.run({ add: [['--provider', 'openai'], ['--model', 'z-ai/glm-5.3']] });
  assert.equal(result.code, 0, result.stderr);
  const plan = parseJson(result.stdout);
  assert.equal(plan.model, 'z-ai/glm-5.3');
  assert.deepEqual(JSON.parse(plan.launch.payload_files.agent['agent-command.json']).argv.slice(8, 10), ['-m', 'openai/z-ai/glm-5.3']);
  const content = plan.launch.agent.create.find(entry => entry.startsWith('OPENCODE_CONFIG_CONTENT='));
  const config = JSON.parse(content.slice('OPENCODE_CONFIG_CONTENT='.length));
  assert.equal(config.small_model, 'openai/z-ai/glm-5.3');
  assert.deepEqual(Object.keys(config.provider.openai.models), ['z-ai/glm-5.3']);
  assert.equal(config.provider.openai.models['z-ai/glm-5.3'].name, 'z-ai/glm-5.3');
}));

// v0.2.1: the launcher version of the dry-run plan and of the run record is the release version.
t('dry-run: the launcher version is 0.2.1 in both modules and in the plan\'s run.json', () => withFixture({}, async fx => {
  assert.deepEqual([CLI_VERSION, RUN_VERSION], ['0.2.1', '0.2.1']);
  const result = await fx.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(parseJson(result.stdout).launch.payload_files.agent['run.json']).launcher_version, '0.2.1');
}));

const mountValues = args => args.flatMap((arg, index) => (args[index - 1] === '--mount' ? [arg] : []));
const values = (args, flag) => args.flatMap((arg, index) => (args[index - 1] === flag ? [arg] : []));

// S2-AC18 with S2-AC15: the plan of a dry run holds the real arguments of both containers, the volume and the network.
t('dry-run: the plan holds the complete runtime arguments of both containers, the volume and the network (Docker by default), and nothing else is created', () => withFixture({ exports: [{ role: 'code' }, { role: 'docs', place: 'inside' }] }, async fx => {
  const before = listing(fx.base);
  const result = await fx.run();
  assert.equal(result.code, 0, result.stderr);
  const plan = parseJson(result.stdout);
  const launch = plan.launch;
  assert.ok(launch, 'the plan holds the launch arguments');
  assert.equal(launch.runtime, 'docker');
  assert.equal(plan.runtime.check, 'not_run');
  assert.equal(plan.image.check, 'not_run');
  assert.match(launch.run_id, /^\d{8}T\d{6}Z-[0-9a-f]{6}$/);
  assert.deepEqual(launch.names, { agent: `acoder-agent-${launch.run_id}`, egress: `acoder-sidecar-${launch.run_id}`, volume: `acoder-egress-${launch.run_id}`, network: `acoder-ext-${launch.run_id}` });
  const uid = process.getuid();
  const gid = process.getgid();
  const agent = launch.agent.create;
  assert.equal(agent[0], 'create');
  assert.deepEqual(values(agent, '--network'), ['none']);
  assert.deepEqual(values(agent, '--workdir'), [fx.writable.scratch]);
  assert.deepEqual(values(agent, '--user'), [`${uid}:${gid}`]);
  assert.equal(agent.at(-1), '/acoder/container/entry.mjs');
  assert.equal(agent.at(-2), `sha256:${'b'.repeat(64)}`, 'a dry run names the image as given: the check is not run');
  const mounts = mountValues(agent);
  const stagingOf = mount => /source=([^,]+)/.exec(mount)[1];
  assert.equal(mounts.length, 9, 'M1, M2, one export outside the mailbox, M4 to M6, the socket volume and the two /etc files');
  assert.match(mounts[0], new RegExp(`^type=bind,source=[^,]+/agent-payload,target=/acoder,readonly$`));
  assert.match(mounts[1], new RegExp(`^type=bind,source=[^,]+/mailbox,target=${fx.mailbox},readonly$`));
  assert.match(mounts[2], new RegExp(`^type=bind,source=[^,]+/export-code,target=${fx.export('code').dir},readonly$`));
  assert.equal(mounts[3], `type=bind,source=${fx.writable.scratch},target=${fx.writable.scratch}`);
  assert.equal(mounts[4], `type=bind,source=${fx.writable.reportMd},target=${fx.writable.reportMd}`);
  assert.equal(mounts[5], `type=bind,source=${fx.writable.reportJson},target=${fx.writable.reportJson}`);
  assert.equal(mounts[6], `type=volume,source=${launch.names.volume},target=/run/acoder-egress,readonly`);
  assert.ok(stagingOf(mounts[0]).startsWith(fx.staging) && stagingOf(mounts[1]).startsWith(fx.staging), 'the mounted sources are in the staging directory');
  assert.equal(mounts.some(mount => mount.includes('export-docs')), false, 'an export inside the mailbox has no mount of its own');
  assert.deepEqual(values(launch.egress.create, '--network'), [launch.names.network]);
  assert.deepEqual(values(launch.egress.create, '--env'), [`ACODER_RUN_ID=${launch.run_id}`, 'ACODER_UPSTREAM_KEY']);
  assert.equal(launch.egress.create.at(-1), '/acoder/container/proxy.mjs');
  assert.equal(launch.volume.create.at(-1), launch.names.volume);
  assert.equal(launch.network.create.at(-1), launch.names.network);
  const env = values(agent, '--env');
  assert.ok(env.includes(`ACODER_TAG=${fx.tag}`) && env.includes('ACODER_CONTAINER=1') && env.includes(`ACODER_TICKET_SHA256=${fx.ticketSha}`));
  assert.ok(env.some(entry => entry.startsWith('OPENCODE_CONFIG_CONTENT=') && entry.includes('http://models.example.org:8080/v1') && entry.includes(PLACEHOLDER_KEY)), 'the agent is configured with the relay address and the placeholder');
  assert.ok(env.every(entry => !entry.includes(fx.key)), 'no key in the agent environment');
  const command = JSON.parse(launch.payload_files.agent['agent-command.json']);
  assert.deepEqual(command.argv.slice(0, 9), ['opencode', 'run', '--format', 'json', '--auto', '--pure', '--dir', fx.writable.scratch, '-m']);
  assert.equal(command.argv[9], 'openai/gpt-6-luna');
  assert.match(command.argv[10], new RegExp(`acoder container launch.*TICKET ${fx.tag}.*${fx.ticket}`));
  assert.equal(JSON.parse(launch.payload_files.agent['run.json']).skill_sha256, plan.snapshot.skill_sha256);
  assert.match(plan.snapshot.skill_sha256, /^[0-9a-f]{64}$/);
  assert.equal(launch.payload_files.agent['etc/hosts'], '127.0.0.1 localhost\n127.0.0.1 models.example.org\n');
  assert.ok(!result.stdout.includes(fx.key) && !result.stderr.includes(fx.key), 'no key value is printed');
  assert.deepEqual(listing(fx.base), before, 'a dry run creates nothing and removes its staging directory');
}));

t('dod11-podman-args: --runtime podman gives the Podman variant in the dry-run plan; --extra-ca-cert adds the certificate variable to the sidecar only', () => withFixture({}, async fx => {
  const ca = `${fx.base}/ca.pem`;
  fs.writeFileSync(ca, 'pem\n');
  const result = await fx.run({ add: [['--runtime', 'podman'], ['--extra-ca-cert', ca]] });
  assert.equal(result.code, 0, result.stderr);
  const plan = parseJson(result.stdout);
  assert.ok(plan.launch, 'the plan holds the launch arguments');
  assert.equal(plan.runtime.name, 'podman');
  assert.equal(plan.launch.runtime, 'podman');
  for (const args of [plan.launch.agent.create, plan.launch.egress.create]) assert.deepEqual(values(args, '--userns'), ['keep-id']);
  assert.ok(values(plan.launch.egress.create, '--env').includes('NODE_EXTRA_CA_CERTS=/acoder/ca.pem'));
  assert.ok(!values(plan.launch.agent.create, '--env').some(entry => entry.startsWith('NODE_EXTRA_CA_CERTS')));
  assert.equal(JSON.parse(plan.launch.payload_files.egress['egress.json']).extra_ca, true);
  assert.deepEqual(plan.launch.egress.env_names, ['ACODER_RUN_ID', 'ACODER_UPSTREAM_KEY', 'NODE_EXTRA_CA_CERTS']);
  const stubRun = await fx.run({ add: [['--agent', 'stub']] });
  assert.equal(stubRun.code, 0, stubRun.stderr);
  assert.equal(JSON.parse(parseJson(stubRun.stdout).launch.payload_files.agent['agent-command.json']).argv[0], 'node', 'the stub adapter builds the command');
  assert.ok(!stubRun.stdout.includes(fx.key));
}));

t('dry-run: the plan carries the flags (--scratch-size, the limits), a fresh run id and event prefix per run, and the probe input of A8.3', () => withFixture({}, async fx => {
  const first = parseJson((await fx.run({ add: [['--scratch-size', '512m']] })).stdout);
  const second = parseJson((await fx.run()).stdout);
  assert.ok(first.launch.agent.create.includes('/work:rw,exec,size=512m,mode=1777'), '--scratch-size is the size of /work');
  assert.ok(second.launch.agent.create.includes('/work:rw,exec,size=2g,mode=1777'));
  assert.notEqual(first.launch.run_id, second.launch.run_id, 'a run id per run');
  const prefix = launch => values(launch.agent.create, '--env').find(entry => entry.startsWith('ACODER_EVENT_PREFIX=')).slice('ACODER_EVENT_PREFIX='.length);
  assert.match(prefix(first.launch), /^[0-9a-f]{32}$/);
  assert.notEqual(prefix(first.launch), prefix(second.launch), 'an event prefix per run');
  assert.deepEqual(JSON.parse(first.launch.payload_files.agent['run.json']).limits, first.limits);
  assert.equal(JSON.parse(first.launch.payload_files.egress['egress.json']).limits.calls, first.limits.calls);
  const probe = JSON.parse(values(first.launch.agent.create, '--env').find(entry => entry.startsWith('ACODER_PROBE_INPUT=')).slice('ACODER_PROBE_INPUT='.length));
  assert.deepEqual(probe.allowed_names, ['models.example.org']);
  assert.deepEqual(probe.env_names, first.launch.agent.env_names);
  assert.equal(probe.hashes.ticket_sha256, fx.ticketSha);
  assert.equal(probe.hashes.skill_sha256, first.snapshot.skill_sha256);
}));
