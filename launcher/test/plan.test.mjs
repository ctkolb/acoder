import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { PLACEHOLDER_KEY, UPSTREAM_KEY_ENV, buildPlan, checkImageConfig, containerBaseUrl as baseUrlRaw, endpointParts as endpointRaw, hostsFile as hostsRaw, resolvConf as resolvRaw } from '../lib/plan.mjs';
import { mountSummary } from '../lib/record.mjs';
import { must, thrownOf } from './helpers/fixtures.mjs';
import { syntheticKey } from './helpers/key-forms.mjs';

// G11: every test has a finite time limit of its own. The test is registered from this file, so that the mutation runner can count it per module.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, fn);

// The functions under test are called through must(): a failure is an assertion failure, never a bare error.
const hostsFile = (...args) => must(() => hostsRaw(...args));
const resolvConf = (...args) => must(() => resolvRaw(...args));
const endpointParts = (...args) => must(() => endpointRaw(...args));
const containerBaseUrl = (...args) => must(() => baseUrlRaw(...args));

const RUN = '20261112T101500Z-a1b2c3';
const IMAGE = `sha256:${'c'.repeat(64)}`;
const SCRATCH = '/m/run/S2/scratch-tg-1';
const MD = '/m/run/S2/report-tg-1.md';
const JSON_REPORT = '/m/run/S2/report-tg-1.json';
const input = (over = {}) => ({
  runtime: 'docker', runId: RUN, tag: 'tg-1', ticketSha256: 'a'.repeat(64), skillSha256: 'b'.repeat(64), launcherVersion: '0.1.0', uid: 501, gid: 20, image: IMAGE,
  imageEnvNames: ['PATH', 'NODE_VERSION'], mailbox: '/m/run', exports: [{ role: 'code', dir: '/m/exp/code', insideMailbox: false }],
  staging: { dir: '/s/stg', mailbox: '/s/stg/mailbox', agentPayload: '/s/stg/agent-payload', egressPayload: '/s/stg/egress-payload', exports: { code: '/s/stg/export-code' } },
  writable: { scratch: SCRATCH, reportMd: MD, reportJson: JSON_REPORT }, scratchSize: '2g', limits: { wall_seconds: 300, calls: 10, tokens: 1000, max_in_flight: 4, scratch_max_bytes: 4294967296 },
  endpoint: 'https://models.example.org/v1', provider: { id: 'openai' }, agent: { argv: ['agentcli', 'run', 'go'], env: { A_ENV: '1', B_ENV: 'two words' } }, extraCa: false,
  eventPrefix: 'd'.repeat(32), probeInput: { hashes: { ticket_sha256: 'a'.repeat(64) }, allowed_names: ['models.example.org'], env_names: ['A_ENV'], p6_addresses: [] }, ...over,
});
const plan = (over, deepFreeze) => must(() => buildPlan(deepFreeze ? freeze(input(over)) : input(over)));
const freeze = value => { if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

const mount = (source, target, readonly = true) => ['--mount', `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`];
const agentArgs = (over = {}) => [
  'create', '--name', `acoder-agent-${RUN}`, '--label', `acoder.run=${RUN}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '501:20',
  ...(over.podman ? ['--userns', 'keep-id'] : []), '--pids-limit', '512', '--pull', 'never', '--log-driver', 'none', '--rm', '--no-healthcheck', '--interactive', '--entrypoint', 'node', '--workdir', SCRATCH,
  ...mount('/s/stg/agent-payload', '/acoder'), ...mount('/s/stg/mailbox', '/m/run'), ...mount('/s/stg/export-code', '/m/exp/code'),
  ...mount(SCRATCH, SCRATCH, false), ...mount(MD, MD, false), ...mount(JSON_REPORT, JSON_REPORT, false),
  '--tmpfs', '/work:rw,exec,size=2g,mode=1777', '--tmpfs', '/tmp:rw,size=64m', '--tmpfs', '/agent:rw,size=256m',
  '--mount', `type=volume,source=acoder-egress-${RUN},target=/run/acoder-egress,readonly`,
  ...mount('/s/stg/agent-payload/etc/hosts', '/etc/hosts'), ...mount('/s/stg/agent-payload/etc/resolv.conf', '/etc/resolv.conf'),
  '--env', 'ACODER_CONTAINER=1', '--env', `ACODER_RUN_ID=${RUN}`, '--env', 'ACODER_TAG=tg-1', '--env', `ACODER_TICKET_SHA256=${'a'.repeat(64)}`, '--env', `ACODER_EVENT_PREFIX=${'d'.repeat(32)}`,
  '--env', `ACODER_PROBE_INPUT=${JSON.stringify(input().probeInput)}`, '--env', 'A_ENV=1', '--env', 'B_ENV=two words',
  IMAGE, '/acoder/container/entry.mjs',
];
const sidecarArgs = (over = {}) => [
  'create', '--name', `acoder-sidecar-${RUN}`, '--label', `acoder.run=${RUN}`, '--network', `acoder-ext-${RUN}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '501:20',
  ...(over.podman ? ['--userns', 'keep-id'] : []), '--pids-limit', '128', '--pull', 'never', '--log-driver', 'none', '--rm', '--no-healthcheck', '--interactive', '--entrypoint', 'node',
  ...mount('/s/stg/egress-payload', '/acoder'), '--mount', `type=volume,source=acoder-egress-${RUN},target=/run/acoder-egress`,
  '--env', `ACODER_RUN_ID=${RUN}`, '--env', 'ACODER_UPSTREAM_KEY', ...(over.extraCa ? ['--env', 'NODE_EXTRA_CA_CERTS=/acoder/ca.pem'] : []),
  IMAGE, '/acoder/container/proxy.mjs',
];
const VOLUME = ['volume', 'create', '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', 'o=size=1m,uid=501,gid=20,mode=0750', '--label', `acoder.run=${RUN}`, `acoder-egress-${RUN}`];
const NETWORK = ['network', 'create', '--label', `acoder.run=${RUN}`, `acoder-ext-${RUN}`];

t('dod11-podman-args: the complete argument lists for Docker: both containers, the volume and the network', () => {
  const p = plan();
  assert.equal(p.runtime, 'docker');
  assert.equal(p.run_id, RUN);
  assert.deepEqual(p.names, { agent: `acoder-agent-${RUN}`, egress: `acoder-sidecar-${RUN}`, volume: `acoder-egress-${RUN}`, network: `acoder-ext-${RUN}` });
  assert.deepEqual(p.agent.create, agentArgs());
  assert.deepEqual(p.egress.create, sidecarArgs());
  assert.deepEqual(p.volume.create, VOLUME);
  assert.deepEqual(p.network.create, NETWORK);
  assert.equal(p.label, `acoder.run=${RUN}`);
});

t('dod11-podman-args: the complete argument lists for Podman (rootless adds --userns keep-id to both containers)', () => {
  const p = plan({ runtime: 'podman' });
  assert.equal(p.runtime, 'podman');
  assert.deepEqual(p.agent.create, agentArgs({ podman: true }));
  assert.deepEqual(p.egress.create, sidecarArgs({ podman: true }));
  assert.deepEqual(p.volume.create, VOLUME);
  assert.deepEqual(p.network.create, NETWORK);
  const docker = plan();
  assert.deepEqual(p.agent.create.filter((_, index) => !(p.agent.create[index - 1] === '--userns' || p.agent.create[index] === '--userns')), docker.agent.create);
  for (const runtime of ['', 'Docker', 'nerdctl', undefined]) assert.notEqual(thrownOf(() => buildPlan(input({ runtime }))), null, String(runtime));
});

t('dod11-podman-args: the extra CA certificate adds one environment entry to the sidecar and nothing to the agent container', () => {
  const p = plan({ extraCa: true });
  assert.deepEqual(p.egress.create, sidecarArgs({ extraCa: true }));
  assert.deepEqual(p.agent.create, agentArgs());
  assert.deepEqual(p.egress.env_names, ['ACODER_RUN_ID', 'ACODER_UPSTREAM_KEY', 'NODE_EXTRA_CA_CERTS']);
  assert.deepEqual(plan().egress.env_names, ['ACODER_RUN_ID', 'ACODER_UPSTREAM_KEY']);
  assert.equal(p.network.agent_network, 'none');
});

const withExports = exportsList => {
  const staging = { dir: '/s/stg', mailbox: '/s/stg/mailbox', agentPayload: '/s/stg/agent-payload', egressPayload: '/s/stg/egress-payload', exports: {} };
  for (const entry of exportsList) staging.exports[entry.role] = entry.insideMailbox ? `/s/stg/mailbox${entry.dir.slice('/m/run'.length)}` : `/s/stg/export-${entry.role}`;
  return { exports: exportsList, staging };
};

t('spec12-mount-summary (plan): the mounts are exactly M1 to M12 and E1 and E2 with the modes and kinds of A2.1 and A2.2; M3 only for an export outside the mailbox', () => {
  const p = plan();
  const expected = [
    { container: 'agent', target: '/acoder', source: '/s/stg/agent-payload', kind: 'bind', mode: 'ro', persistent: true, role: 'payload' },
    { container: 'agent', target: '/m/run', source: '/s/stg/mailbox', kind: 'bind', mode: 'ro', persistent: true, role: 'mailbox' },
    { container: 'agent', target: '/m/exp/code', source: '/s/stg/export-code', kind: 'bind', mode: 'ro', persistent: true, role: 'export' },
    { container: 'agent', target: SCRATCH, source: SCRATCH, kind: 'bind', mode: 'rw', persistent: true, role: 'scratch' },
    { container: 'agent', target: MD, source: MD, kind: 'bind', mode: 'rw', persistent: true, role: 'report' },
    { container: 'agent', target: JSON_REPORT, source: JSON_REPORT, kind: 'bind', mode: 'rw', persistent: true, role: 'report' },
    { container: 'agent', target: '/work', source: null, kind: 'tmpfs', mode: 'rw', persistent: false, role: 'work' },
    { container: 'agent', target: '/tmp', source: null, kind: 'tmpfs', mode: 'rw', persistent: false, role: 'work' },
    { container: 'agent', target: '/agent', source: null, kind: 'tmpfs', mode: 'rw', persistent: false, role: 'work' },
    { container: 'agent', target: '/run/acoder-egress', source: `acoder-egress-${RUN}`, kind: 'volume', mode: 'ro', persistent: false, role: 'socket' },
    { container: 'agent', target: '/etc/hosts', source: '/s/stg/agent-payload/etc/hosts', kind: 'bind', mode: 'ro', persistent: true, role: 'etc' },
    { container: 'agent', target: '/etc/resolv.conf', source: '/s/stg/agent-payload/etc/resolv.conf', kind: 'bind', mode: 'ro', persistent: true, role: 'etc' },
    { container: 'egress', target: '/acoder', source: '/s/stg/egress-payload', kind: 'bind', mode: 'ro', persistent: true, role: 'payload' },
    { container: 'egress', target: '/run/acoder-egress', source: `acoder-egress-${RUN}`, kind: 'volume', mode: 'rw', persistent: false, role: 'socket' },
  ];
  assert.deepEqual(p.mounts, expected);
  assert.deepEqual(must(() => mountSummary(p.mounts, p.mounts)), {
    writable_host_paths: [SCRATCH, MD, JSON_REPORT], readonly_inputs: ['/m/run', '/m/exp/code'], memory_mounts: ['/work', '/tmp', '/agent', '/run/acoder-egress', '/run/acoder-egress'], equal_to_plan: true,
  });
  // M3 only for an export outside the mailbox: none, one inside, two outside, in the order of the flags, after the mailbox and before the writable paths.
  const none = plan({ ...withExports([]) });
  assert.deepEqual(none.mounts.filter(entry => entry.role === 'export'), []);
  assert.deepEqual(none.mounts.slice(0, 2).map(entry => entry.role), ['payload', 'mailbox']);
  const inside = plan({ ...withExports([{ role: 'docs', dir: '/m/run/S2/export-docs', insideMailbox: true }]) });
  assert.deepEqual(inside.mounts.filter(entry => entry.role === 'export'), [], 'an export inside the mailbox is covered by the mailbox mount');
  assert.equal(inside.agent.create.some(arg => arg.includes('export-docs')), false);
  const two = plan({ ...withExports([{ role: 'a', dir: '/m/exp/a', insideMailbox: false }, { role: 'b', dir: '/m/exp/b', insideMailbox: false }, { role: 'docs', dir: '/m/run/S2/export-docs', insideMailbox: true }]) });
  assert.deepEqual(two.mounts.map(entry => `${entry.role}:${entry.target}`).slice(0, 6), ['payload:/acoder', 'mailbox:/m/run', 'export:/m/exp/a', 'export:/m/exp/b', `scratch:${SCRATCH}`, `report:${MD}`]);
  assert.deepEqual(two.mounts.filter(entry => entry.role === 'export').map(entry => entry.source), ['/s/stg/export-a', '/s/stg/export-b']);
  for (const entry of two.mounts.filter(candidate => candidate.role === 'export')) assert.equal(entry.mode, 'ro');
});

t('dod11-podman-args: the settings of A2.1 and A2.2 and nothing else: no network for the agent, EXT only for the sidecar, no privilege, device, socket, port or namespace option', () => {
  const p = plan();
  const next = (args, flag) => args[args.indexOf(flag) + 1];
  assert.equal(next(p.agent.create, '--network'), 'none');
  assert.equal(next(p.egress.create, '--network'), `acoder-ext-${RUN}`);
  assert.equal(p.egress.create.filter(arg => arg === '--network').length, 1);
  const forbidden = ['--privileged', '--device', '-v', '--volume', '--volumes-from', '-p', '--publish', '-P', '--publish-all', '--pid', '--ipc', '--uts', '--userns=host', '--cap-add', '--add-host', '--dns', '--hostname', '--net', '--network=host', '--init', '--restart'];
  for (const args of [p.agent.create, p.egress.create]) {
    for (const flag of forbidden) assert.equal(args.includes(flag), false, flag);
    for (const arg of args) assert.ok(!/seccomp|unconfined|docker\.sock|podman\.sock|host$/i.test(arg) || arg === `acoder-egress-${RUN}`, arg);
    assert.equal(args.filter(arg => arg === '--security-opt').length, 1);
    assert.equal(next(args, '--security-opt'), 'no-new-privileges');
    assert.equal(next(args, '--cap-drop'), 'ALL');
    assert.equal(next(args, '--user'), '501:20');
    assert.equal(next(args, '--pull'), 'never');
    assert.equal(next(args, '--log-driver'), 'none');
    assert.equal(next(args, '--entrypoint'), 'node');
    assert.ok(args.includes('--read-only') && args.includes('--rm') && args.includes('--no-healthcheck') && args.includes('--interactive'));
    assert.equal(next(args, '--label'), `acoder.run=${RUN}`);
    assert.equal(args.at(-2), IMAGE, 'the image is the resolved image id, then the program');
  }
  assert.equal(next(p.agent.create, '--pids-limit'), '512');
  assert.equal(next(p.egress.create, '--pids-limit'), '128');
  assert.equal(next(p.agent.create, '--workdir'), SCRATCH);
  assert.equal(p.agent.create.at(-1), '/acoder/container/entry.mjs');
  assert.equal(p.egress.create.at(-1), '/acoder/container/proxy.mjs');
  // Every bind is a --mount with the explicit syntax, never the -v shorthand; the tmpfs mounts are exactly three.
  assert.equal(p.agent.create.filter(arg => arg === '--tmpfs').length, 3);
  assert.equal(p.egress.create.includes('--tmpfs'), false, 'the sidecar has no tmpfs');
  for (const args of [p.agent.create, p.egress.create]) for (const [index, arg] of args.entries()) if (arg === '--mount') assert.match(args[index + 1], /^type=(bind|volume),source=[^,"\n]+,target=[^,"\n]+(,readonly)?$/);
  // The sidecar has no mailbox, export, scratch, report: its mounts are the payload and the socket volume only.
  assert.deepEqual(p.mounts.filter(entry => entry.container === 'egress').map(entry => entry.role), ['payload', 'socket']);
  assert.equal(p.egress.create.filter(arg => arg === '--mount').length, 2);
  assert.equal(p.agent.create.filter(arg => arg === '--mount').length, 9);
  assert.equal(p.network.agent_network, 'none');
});

t('dod11-podman-args: the environment names are exactly those of A8.3, the key is passed by name only and never reaches the agent container', () => {
  const p = plan({ imageEnvNames: ['PATH', 'NODE_VERSION', 'TZ'] });
  assert.deepEqual(p.agent.env_names, ['A_ENV', 'ACODER_CONTAINER', 'ACODER_EVENT_PREFIX', 'ACODER_PROBE_INPUT', 'ACODER_RUN_ID', 'ACODER_TAG', 'ACODER_TICKET_SHA256', 'B_ENV', 'NODE_VERSION', 'PATH', 'TZ'].sort());
  assert.deepEqual(p.egress.env_names, ['ACODER_RUN_ID', 'ACODER_UPSTREAM_KEY', 'NODE_VERSION', 'PATH', 'TZ'].sort());
  const names = args => args.flatMap((arg, index) => (args[index - 1] === '--env' ? [arg.split('=')[0]] : []));
  assert.deepEqual(names(p.agent.create), ['ACODER_CONTAINER', 'ACODER_RUN_ID', 'ACODER_TAG', 'ACODER_TICKET_SHA256', 'ACODER_EVENT_PREFIX', 'ACODER_PROBE_INPUT', 'A_ENV', 'B_ENV'], 'image-defined names are not passed, only expected');
  assert.deepEqual(names(p.egress.create), ['ACODER_RUN_ID', 'ACODER_UPSTREAM_KEY']);
  assert.equal(UPSTREAM_KEY_ENV, 'ACODER_UPSTREAM_KEY');
  assert.ok(p.egress.create.includes('ACODER_UPSTREAM_KEY') && !p.egress.create.some(arg => arg.startsWith('ACODER_UPSTREAM_KEY=')), 'the key is passed by name without a value');
  assert.equal(p.agent.create.some(arg => /UPSTREAM|KEY/.test(arg)), false, 'no key name in the agent container');
  assert.equal(p.egress.key_env, 'ACODER_UPSTREAM_KEY');
  assert.equal(PLACEHOLDER_KEY, 'acoder-placeholder-not-a-key');
  // An adapter variable may not shadow a variable of the launcher, repeat, or hold a name or a value that cannot be passed.
  for (const env of [{ ACODER_TAG: 'x' }, { ACODER_UPSTREAM_KEY: 'x' }, { 'A=B': 'x' }, { '': 'x' }, { lower: 'x' }, { A_ENV: 'x\0y' }, { A_ENV: 7 }]) {
    assert.notEqual(thrownOf(() => buildPlan(input({ agent: { argv: ['x'], env } }))), null, JSON.stringify(env));
  }
  assert.notEqual(thrownOf(() => buildPlan(input({ imageEnvNames: ['A_ENV'] }))), null, 'an image name that the adapter also sets');
});

t('dod11-podman-args: the key never appears in an argument, a payload file or any field of the plan; the placeholder does', () => {
  const key = syntheticKey();
  for (const runtime of ['docker', 'podman']) {
    for (const extraCa of [false, true]) {
      const p = plan({ runtime, extraCa });
      const text = JSON.stringify(p);
      assert.ok(!text.includes(key) && !text.includes(Buffer.from(key).toString('hex')), 'no key form in the whole plan');
      for (const arg of [...p.agent.create, ...p.egress.create, ...p.volume.create, ...p.network.create]) assert.ok(!arg.includes(key), arg);
    }
  }
  // The plan function has no parameter that could carry the key: an unknown input field is an error.
  assert.notEqual(thrownOf(() => buildPlan(input({ key }))), null);
  assert.notEqual(thrownOf(() => buildPlan(input({ apiKey: key }))), null);
  // The adapter's inline configuration holds the placeholder and it is the only key-like value.
  const withPlaceholder = plan({ agent: { argv: ['x'], env: { CONFIG: JSON.stringify({ apiKey: PLACEHOLDER_KEY }) } } });
  assert.ok(withPlaceholder.agent.create.some(arg => arg.includes(PLACEHOLDER_KEY)));
});

t('dod11-podman-args: the hosts and resolv files have exactly the content of M11 and M12, and the payload files are the plan\'s', () => {
  assert.equal(hostsFile(['models.example.org']), '127.0.0.1 localhost\n127.0.0.1 models.example.org\n');
  assert.equal(hostsFile(['a.example.org', 'b.example.org']), '127.0.0.1 localhost\n127.0.0.1 a.example.org\n127.0.0.1 b.example.org\n');
  assert.equal(hostsFile([]), '127.0.0.1 localhost\n');
  for (const bad of ['', 'a b', 'a\nb', '127.0.0.1', '::1', 'A.example.org', 'a_b.example.org', 'models.example.org.']) assert.notEqual(thrownOf(() => hostsFile([bad])), null, bad);
  const resolv = resolvConf();
  assert.equal(resolv.split('\n').length, 2, 'one line and the final newline');
  assert.match(resolv, /^# [^\n]+\n$/, 'one comment line');
  assert.ok(!/nameserver/i.test(resolv), 'no name server');
  const p = plan();
  assert.deepEqual(Object.keys(p.payload_files.agent).sort(), ['agent-command.json', 'etc/hosts', 'etc/resolv.conf', 'run.json']);
  assert.equal(p.payload_files.agent['etc/hosts'], '127.0.0.1 localhost\n127.0.0.1 models.example.org\n');
  assert.equal(p.payload_files.agent['etc/resolv.conf'], resolv);
  assert.deepEqual(JSON.parse(p.payload_files.agent['run.json']), {
    run_id: RUN, tag: 'tg-1', ticket_sha256: 'a'.repeat(64), limits: input().limits, launcher_version: '0.1.0', skill_sha256: 'b'.repeat(64),
  });
  assert.deepEqual(Object.keys(JSON.parse(p.payload_files.agent['run.json'])), ['run_id', 'tag', 'ticket_sha256', 'limits', 'launcher_version', 'skill_sha256']);
  assert.deepEqual(JSON.parse(p.payload_files.agent['agent-command.json']), { argv: ['agentcli', 'run', 'go'] });
  assert.deepEqual(Object.keys(p.payload_files.egress), ['egress.json']);
  assert.deepEqual(JSON.parse(p.payload_files.egress['egress.json']), {
    run_id: RUN, provider: { id: 'openai', module: '/acoder/providers/openai.mjs' }, endpoint: { host: 'models.example.org', path: '/v1' }, allowlist: ['models.example.org'], key_env: 'ACODER_UPSTREAM_KEY',
    limits: { calls: 10, tokens: 1000, max_in_flight: 4 }, extra_ca: false,
  });
  assert.equal(JSON.parse(plan({ extraCa: true }).payload_files.egress['egress.json']).extra_ca, true);
  assert.deepEqual(p.allowlist, ['models.example.org']);
  for (const file of [...Object.values(p.payload_files.agent), ...Object.values(p.payload_files.egress)]) assert.equal(typeof file, 'string');
});

t('dod11-podman-args: the endpoint gives the allowed host, the path and the base URL inside the container (A3.1.5)', () => {
  assert.deepEqual(endpointParts('https://models.example.org/v1'), { host: 'models.example.org', path: '/v1' });
  assert.deepEqual(endpointParts('https://Models.Example.org'), { host: 'models.example.org', path: '' });
  assert.deepEqual(endpointParts('https://models.example.org/'), { host: 'models.example.org', path: '' });
  assert.deepEqual(endpointParts('https://models.example.org:443/a/b'), { host: 'models.example.org', path: '/a/b' });
  assert.equal(containerBaseUrl('https://models.example.org/v1'), 'http://models.example.org:8080/v1');
  assert.equal(containerBaseUrl('https://models.example.org'), 'http://models.example.org:8080');
  for (const bad of ['http://models.example.org', 'https://1.2.3.4/v1', 'https://models.example.org:8443/v1', 'https://u@models.example.org/v1', 'https://models.example.org/v1?x=1', 'https://models.example.org/v1#f', 'models', '']) {
    assert.notEqual(thrownOf(() => endpointParts(bad)), null, bad);
  }
});

t('dod11-podman-args: the plan is a pure function of validated inputs, and refuses an input it cannot pass safely to the runtime', () => {
  const frozen = input();
  freeze(frozen);
  assert.deepEqual(must(() => buildPlan(frozen)), must(() => buildPlan(input())));
  const first = plan();
  first.agent.create.push('x');
  assert.deepEqual(plan().agent.create, agentArgs(), 'every call returns fresh lists');
  const refused = over => assert.notEqual(thrownOf(() => buildPlan(input(over))), null, JSON.stringify(over).slice(0, 80));
  for (const comma of [',', '"', '\n', '\\', '\t']) {
    refused({ mailbox: `/m/ru${comma}n` });
    refused({ writable: { scratch: `/m/S2/sc${comma}ratch`, reportMd: MD, reportJson: JSON_REPORT } });
    refused({ exports: [{ role: 'code', dir: `/m/e${comma}xp`, insideMailbox: false }] });
    refused({ staging: { ...input().staging, dir: `/s/st${comma}g` } });
  }
  refused({ runId: 'bad id' });
  refused({ runId: '../x' });
  refused({ runId: '' });
  refused({ image: 'name:tag' });
  refused({ image: '' });
  refused({ uid: -1 });
  refused({ gid: 1.5 });
  refused({ uid: '501' });
  refused({ mailbox: 'relative' });
  refused({ eventPrefix: 'short' });
  refused({ scratchSize: '2 g' });
  refused({ scratchSize: '0g' });
  refused({ tag: 'a b' });
  refused({ ticketSha256: 'abc' });
  refused({ staging: { ...input().staging, exports: {} } });
  refused({ agent: { argv: [], env: {} } });
  refused({ agent: { argv: [7], env: {} } });
  refused({ limits: { wall_seconds: 0, calls: 10, tokens: 1000, max_in_flight: 4, scratch_max_bytes: 1 } });
  refused({ extraCa: 'yes' });
  refused({ provider: { id: 'Bad Id' } });
  refused({ exports: [{ role: 'code', dir: '/m/exp/code', insideMailbox: false }, { role: 'code', dir: '/m/exp/other', insideMailbox: false }] });
  refused({ endpoint: 'http://models.example.org/v1' });
});

const OK = { image: IMAGE };
const inspectOf = (over = {}) => ({ Id: IMAGE, RepoDigests: [`registry.example.org/team/ref@sha256:${'d'.repeat(64)}`], Config: { Env: ['PATH=/usr/bin', 'LANG=C.UTF-8', 'NODE_VERSION=22.1.0'], Volumes: null }, ...over });
const check = (inspect, over = {}) => must(() => checkImageConfig(inspect, { ...OK, allowImageEnv: [], ...over }));
const refusalOf = (inspect, over = {}) => thrownOf(() => checkImageConfig(inspect, { ...OK, allowImageEnv: [], ...over }));

t('spec07-env: the image is accepted by id or by a digest of the image, its environment names are recorded, and an allowed extra name is recorded', () => {
  assert.deepEqual(check(inspectOf()), { ref: IMAGE, id: IMAGE, repo_digests: [`registry.example.org/team/ref@sha256:${'d'.repeat(64)}`], env_names: ['LANG', 'NODE_VERSION', 'PATH'], allowed_env_names: [] });
  assert.deepEqual(check([inspectOf()]).id, IMAGE, 'the answer of `image inspect` is a list of one');
  const named = `registry.example.org/team/ref@sha256:${'d'.repeat(64)}`;
  assert.equal(check(inspectOf(), { image: named }).ref, named, 'a name with the digest of a repository digest');
  assert.equal(check(inspectOf(), { image: `other.example.org/x@sha256:${'d'.repeat(64)}` }).ref, `other.example.org/x@sha256:${'d'.repeat(64)}`, 'the digest decides, the name is as the owner wrote it');
  assert.equal(check(inspectOf(), { image: `name@${IMAGE}` }).ref, `name@${IMAGE}`, 'a name with the image id');
  assert.equal(check(inspectOf(), { image: `sha256:${'d'.repeat(64)}` }).ref, `sha256:${'d'.repeat(64)}`, 'a bare digest of a repository digest');
  for (const name of ['YARN_VERSION', 'TZ', 'LC_ALL', 'LANGUAGE']) assert.equal(check(inspectOf({ Config: { Env: [`${name}=x`], Volumes: {} } })).env_names[0], name);
  const extra = inspectOf({ Config: { Env: ['PATH=/x', 'MY_SETTING=abc', 'OTHER=1'], Volumes: null } });
  const accepted = check(extra, { allowImageEnv: ['OTHER', 'MY_SETTING'] });
  assert.deepEqual(accepted.allowed_env_names, ['MY_SETTING', 'OTHER'], 'recorded, sorted');
  assert.deepEqual(accepted.env_names, ['MY_SETTING', 'OTHER', 'PATH']);
  assert.deepEqual(check(inspectOf({ Config: { Env: [], Volumes: null } })).env_names, []);
  assert.deepEqual(check(inspectOf({ Config: { Volumes: null } })).env_names, [], 'no Env at all');
  assert.deepEqual(check(inspectOf({ RepoDigests: null })).repo_digests, [], 'no repository digests');
  assert.deepEqual(check(inspectOf({ RepoDigests: [] })).repo_digests, []);
});

t('spec07-env: a tag, a bare name, a digest that matches neither the id nor a repository digest, an unlisted environment name and a declared volume are refusals; no message holds a value', () => {
  for (const image of ['name:latest', 'name', 'registry.example.org/team/ref:1.0', `name@sha256:${'d'.repeat(63)}`, `name@sha256:${'D'.repeat(64)}`, `sha256:${'d'.repeat(63)}`, `@sha256:${'d'.repeat(64)}`, '', 'name@md5:abc', `${IMAGE}x`]) {
    assert.match(refusalOf(inspectOf(), { image }) ?? 'no refusal', /image/i, `${image}`);
  }
  assert.match(refusalOf(inspectOf(), { image: `sha256:${'e'.repeat(64)}` }) ?? 'no refusal', /neither|digest/i, 'a digest that matches nothing');
  assert.match(refusalOf(inspectOf(), { image: `name@sha256:${'e'.repeat(64)}` }) ?? 'no refusal', /neither|digest/i);
  assert.match(refusalOf(inspectOf({ RepoDigests: null }), { image: `name@sha256:${'d'.repeat(64)}` }) ?? 'no refusal', /neither|digest/i);
  // An environment variable name outside the list, with a value that must not appear in the message.
  const secret = syntheticKey();
  const withSecret = inspectOf({ Config: { Env: ['PATH=/usr/bin', `API_TOKEN=${secret}`, `OTHER=${secret}`], Volumes: null } });
  const message = refusalOf(withSecret) ?? 'no refusal';
  assert.match(message, /API_TOKEN/, 'the name is named');
  assert.ok(!message.includes(secret) && !message.includes('=') , 'the value is not in the message');
  assert.match(refusalOf(withSecret, { allowImageEnv: ['API_TOKEN'] }) ?? 'no refusal', /OTHER/, 'one allowed name does not allow another');
  assert.equal(refusalOf(withSecret, { allowImageEnv: ['API_TOKEN', 'OTHER'] }), null);
  assert.match(refusalOf(inspectOf({ Config: { Env: ['path=/x'], Volumes: null } })) ?? 'no refusal', /path/, 'names are case sensitive');
  assert.match(refusalOf(inspectOf({ Config: { Env: ['PATH2=/x'], Volumes: null } })) ?? 'no refusal', /PATH2/, 'the list holds names, not prefixes');
  assert.match(refusalOf(inspectOf({ Config: { Env: ['=value'], Volumes: null } })) ?? 'no refusal', /malformed/i);
  assert.ok(!(refusalOf(inspectOf({ Config: { Env: [`=${secret}`], Volumes: null } })) ?? '').includes(secret));
  assert.match(refusalOf(inspectOf({ Config: { Env: [42], Volumes: null } })) ?? 'no refusal', /malformed|environment/i);
  // A declared volume.
  assert.match(refusalOf(inspectOf({ Config: { Env: ['PATH=/x'], Volumes: { '/data': {} } } })) ?? 'no refusal', /volume/i);
  assert.equal(refusalOf(inspectOf({ Config: { Env: ['PATH=/x'], Volumes: {} } })), null, 'an empty volume list declares none');
  // The shape of the answer.
  for (const bad of [null, [], [inspectOf(), inspectOf()], 'text', 7, {}, { Id: 7 }, inspectOf({ Id: 'no-digest' }), inspectOf({ Config: null }), inspectOf({ Config: 'x' })]) {
    assert.match(refusalOf(bad) ?? 'no refusal', /inspect|image|answer/i, JSON.stringify(bad)?.slice(0, 50));
  }
  // Every message is one line and names no value, whatever the input.
  for (const text of [refusalOf(inspectOf(), { image: 'name:tag' }), message]) assert.ok(!/\n/.test(text));
  assert.notEqual(thrownOf(() => checkImageConfig(inspectOf(), { image: IMAGE })), null, 'allowImageEnv is a list');
});
