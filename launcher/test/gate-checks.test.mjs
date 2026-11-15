import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { adapters } from '../adapters/index.mjs';
import { checkH1, checkH2, checkH3, checkH4, checkU1, checkU2, corroborate, planFor } from '../lib/run.mjs';
import { providers } from '../providers/index.mjs';
import * as stub from './helpers/stub-adapter.mjs';

// G11: every test has a finite time limit of its own and is registered from this file.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, fn);

// A plan without a file system: the inputs planFor reads from a prepared snapshot are given directly.
const IDS = { uid: 501, gid: 20 };
const RUN_ID = '20261115T101500Z-a1b2c3';
function makePlan() {
  const stage = '/m/run/S4';
  const prepared = {
    tag: 't', ticket: { sha256: 'd'.repeat(64) }, writable: { stage, scratch: `${stage}/scratch-t`, reportMd: `${stage}/report-t.md`, reportJson: `${stage}/report-t.json` },
    staging: { dir: '/s', mailbox: '/s/mailbox', skill: null }, exports: {},
  };
  const options = { ticket: `${stage}/ticket-t.md`, mailbox: '/m/run', exports: [], scratchSize: '2g', extraCaCert: null };
  const settings = { agent: 'stub', provider: 'openai', model: 'marker', effort: 'high', endpoint: 'https://model.stub.test/v1', limits: { wall_seconds: 60, calls: 5, tokens: 1000, max_in_flight: 4, scratch_max_bytes: 4096 } };
  const image = { id: `sha256:${'e'.repeat(64)}`, env_names: ['NODE_VERSION', 'PATH', 'YARN_VERSION'] };
  return planFor({ options, settings, prepared: { ...prepared, staging: { ...prepared.staging, skill: new URL('./helpers', import.meta.url).pathname } }, adapters: { ...adapters, stub }, providers, image, runtimeName: 'docker', runId: RUN_ID, eventPrefix: 'a'.repeat(32), nonce: 'b'.repeat(32), uid: 501, gid: 20 });
}
const PLAN = makePlan();
const NETWORK = 'acoder-ext-x';

// The inspect answer of a container created exactly as planned (the shape of the runtime wrapper's names-only format).
function infoFor(container) {
  const create = PLAN[container].create;
  const mounts = PLAN.mounts.filter(mount => mount.container === container && mount.kind !== 'tmpfs')
    .map(mount => ({ Type: mount.kind, Destination: mount.target, RW: mount.mode === 'rw', ...(mount.kind === 'volume' ? { Name: mount.source } : { Source: mount.source }) }));
  const tmpfs = {};
  create.forEach((item, index) => { if (item === '--tmpfs') { const value = create[index + 1]; tmpfs[value.slice(0, value.indexOf(':'))] = value.slice(value.indexOf(':') + 1); } });
  return {
    HostConfig: {
      NetworkMode: container === 'agent' ? 'none' : NETWORK, ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'], Privileged: false, PidMode: '', IpcMode: 'private',
      UTSMode: '', Devices: [], PortBindings: {}, PublishAllPorts: false, LogConfig: { Type: 'none', Config: {} }, Tmpfs: tmpfs, PidsLimit: container === 'agent' ? 512 : 128, VolumesFrom: null,
    },
    Mounts: mounts, Networks: container === 'agent' ? { none: {} } : { [NETWORK]: {} },
    Config: { User: '501:20', Entrypoint: ['node'], Cmd: [container === 'agent' ? '/acoder/container/entry.mjs' : '/acoder/container/proxy.mjs'], EnvNames: [...PLAN[container].env_names] },
  };
}
const broken = (container, change) => { const info = structuredClone(infoFor(container)); change(info); return info; };

t('gate checks: a container created as planned passes H1, H2 and H3', () => {
  assert.deepEqual(checkH1(infoFor('agent')), { result: 'pass', detail: null });
  assert.deepEqual(checkH2(infoFor('agent'), PLAN, IDS), { result: 'pass', detail: null });
  assert.deepEqual(checkH3(infoFor('egress'), PLAN, IDS, NETWORK), { result: 'pass', detail: null });
});

t('gate checks: H1 fails for another network mode, an attached network, or no answer', () => {
  assert.equal(checkH1(broken('agent', info => { info.HostConfig.NetworkMode = NETWORK; })).result, 'fail');
  assert.equal(checkH1(broken('agent', info => { info.Networks[NETWORK] = {}; })).result, 'fail');
  assert.equal(checkH1(null).result, 'fail');
});

const H2_CASES = [
  ['an extra bind', info => info.Mounts.push({ Type: 'bind', Source: '/x', Destination: '/extra', RW: true }), 'mounts'],
  ['the mailbox read-write', info => { info.Mounts.find(mount => mount.Destination === '/m/run').RW = true; }, 'mounts'],
  ['a missing tmpfs', info => { delete info.HostConfig.Tmpfs['/tmp']; }, 'mounts'],
  ['other tmpfs options', info => { info.HostConfig.Tmpfs['/work'] = 'rw,exec,size=4g,mode=1777'; }, 'mounts'],
  ['a writable root', info => { info.HostConfig.ReadonlyRootfs = false; }, 'root_writable'],
  ['a capability kept', info => { info.HostConfig.CapDrop = []; }, 'capabilities'],
  ['a capability added', info => { info.HostConfig.CapAdd = ['NET_ADMIN']; }, 'capabilities'],
  ['a seccomp profile', info => info.HostConfig.SecurityOpt.push('seccomp=/p.json'), 'seccomp_option'],
  ['seccomp unconfined', info => info.HostConfig.SecurityOpt.push('seccomp=unconfined'), 'seccomp_option'],
  ['no no-new-privileges', info => { info.HostConfig.SecurityOpt = []; }, 'security_options'],
  ['privileged', info => { info.HostConfig.Privileged = true; }, 'privileged'],
  ['the host PID namespace', info => { info.HostConfig.PidMode = 'host'; }, 'host_namespace'],
  ['the host IPC namespace', info => { info.HostConfig.IpcMode = 'host'; }, 'host_namespace'],
  ['the host UTS namespace', info => { info.HostConfig.UTSMode = 'host'; }, 'host_namespace'],
  ['a device', info => { info.HostConfig.Devices = [{ PathOnHost: '/dev/kvm' }]; }, 'device'],
  ['a published port', info => { info.HostConfig.PortBindings = { '80/tcp': [{}] }; }, 'published_port'],
  ['the default log driver', info => { info.HostConfig.LogConfig.Type = 'json-file'; }, 'log_driver'],
  ['volumes from another container', info => { info.HostConfig.VolumesFrom = ['x']; }, 'volumes_from'],
  ['another user', info => { info.Config.User = '0:0'; }, 'user'],
  ['another entry point', info => { info.Config.Entrypoint = ['sh']; }, 'entry_point'],
  ['other arguments', info => { info.Config.Cmd = ['/acoder/skill/x.mjs']; }, 'entry_point'],
  ['an extra variable name', info => info.Config.EnvNames.push('EXTRA'), 'env_names'],
  ['a missing variable name', info => { info.Config.EnvNames = info.Config.EnvNames.slice(1); }, 'env_names'],
  ['another pids limit', info => { info.HostConfig.PidsLimit = 0; }, 'pids_limit'],
];
for (const [what, change, detail] of H2_CASES) {
  t(`gate checks: H2 fails for ${what} (${detail})`, () => assert.deepEqual(checkH2(broken('agent', change), PLAN, IDS), { result: 'fail', detail }));
}

t('gate checks: H3 fails for another network, a second network, other mounts, a seccomp option, a published port, the default log driver, other names', () => {
  const cases = [
    [info => { info.HostConfig.NetworkMode = 'bridge'; }, 'network'], [info => { info.Networks.bridge = {}; }, 'network'],
    [info => info.Mounts.push({ Type: 'bind', Source: '/m/run', Destination: '/m/run', RW: false }), 'mounts'], [info => info.HostConfig.SecurityOpt.push('seccomp=unconfined'), 'seccomp_option'],
    [info => { info.HostConfig.PortBindings = { '443/tcp': [{}] }; }, 'published_port'], [info => { info.HostConfig.LogConfig.Type = 'local'; }, 'log_driver'],
    [info => info.Config.EnvNames.push('SSH_AUTH_SOCK'), 'env_names'], [info => { info.Config.Cmd = ['/x.mjs']; }, 'entry_point'],
  ];
  for (const [change, detail] of cases) assert.deepEqual(checkH3(broken('egress', change), PLAN, IDS, NETWORK), { result: 'fail', detail });
  assert.equal(checkH3(null, PLAN, IDS, NETWORK).result, 'fail');
});

t('gate checks: H4 passes the planned volume and EXT; fails other options, a missing label, a shared EXT', () => {
  const volume = () => ({ Driver: 'local', Labels: { 'acoder.run': RUN_ID }, Options: { device: 'tmpfs', o: 'size=1m,uid=501,gid=20,mode=0750', type: 'tmpfs' } });
  const network = (containers = {}) => ({ Labels: { 'acoder.run': RUN_ID }, Containers: containers });
  const facts = { networkCreated: true, sidecarId: 'sid' };
  assert.deepEqual(checkH4(volume(), network({ sid: {} }), PLAN, facts), { result: 'pass', detail: null });
  assert.deepEqual(checkH4({ ...volume(), Options: { ...volume().Options, o: 'size=2m,uid=501,gid=20,mode=0750' } }, network(), PLAN, facts), { result: 'fail', detail: 'volume_options' });
  assert.deepEqual(checkH4({ ...volume(), Driver: 'other' }, network(), PLAN, facts), { result: 'fail', detail: 'volume_options' });
  assert.deepEqual(checkH4({ ...volume(), Labels: {} }, network(), PLAN, facts), { result: 'fail', detail: 'volume_label' });
  assert.deepEqual(checkH4(volume(), { ...network(), Labels: {} }, PLAN, facts), { result: 'fail', detail: 'network_label' });
  assert.deepEqual(checkH4(volume(), network({ sid: {}, other: {} }), PLAN, facts), { result: 'fail', detail: 'network_shared' });
  assert.deepEqual(checkH4(null, network(), PLAN, facts), { result: 'fail', detail: 'volume_missing' });
  assert.deepEqual(checkH4(volume(), null, PLAN, facts), { result: 'fail', detail: 'network_missing' });
});

// U1 with D-R32 and the clock bracket of A3.6 (the boundaries of dod5-release-deadline's unit part are in part 2; these pin the gate).
const READY = { event: 'ready', config_sha256: 'c'.repeat(64), env_names: ['ACODER_RUN_ID', 'ACODER_UPSTREAM_KEY', 'HOSTNAME', 'PATH'], clock_epoch_ms: 1 };
const u1 = (over = {}) => checkU1(
  { ready: READY, readyCount: 1, firstLocal: { phase: 'probe' }, clocks: [{ start: 100000, end: 100500, sample: 100200 }, { start: 101000, end: 101100, sample: 101050 }], ...over },
  { configSha256: 'c'.repeat(64), envNames: ['ACODER_RUN_ID', 'ACODER_UPSTREAM_KEY', 'PATH'], allowance: ['HOME', 'HOSTNAME', 'TERM'] },
);

t('gate checks: U1 passes the expected hash, names, phase and clock samples; each difference fails', () => {
  assert.deepEqual(u1(), { result: 'pass', detail: null });
  assert.deepEqual(u1({ ready: { ...READY, config_sha256: 'f'.repeat(64) } }), { result: 'fail', detail: 'config_hash' });
  assert.deepEqual(u1({ ready: { ...READY, env_names: [...READY.env_names, 'SSH_AUTH_SOCK'] } }), { result: 'fail', detail: 'env_names' });
  assert.deepEqual(u1({ ready: { ...READY, env_names: ['ACODER_RUN_ID', 'PATH'] } }), { result: 'fail', detail: 'env_names' });
  assert.deepEqual(u1({ firstLocal: { phase: 'agent' } }), { result: 'fail', detail: 'phase' });
  assert.deepEqual(u1({ firstLocal: null }), { result: 'fail', detail: 'phase' });
  assert.deepEqual(u1({ ready: null, readyCount: 0 }), { result: 'fail', detail: 'ready_missing' });
  assert.deepEqual(u1({ readyCount: 2 }), { result: 'fail', detail: 'ready_missing' });
  assert.deepEqual(u1({ clocks: [null, { start: 1, end: 2, sample: 1 }] }), { result: 'fail', detail: 'clock_protocol' });
});

t('gate checks: U1 accepts a sample within the bracket widened by 1000 ms (inclusive) and a bracket of at most 10000 ms; it refuses 1001 ms outside and 10001 ms', () => {
  const clock = (start, end, sample) => u1({ clocks: [{ start, end, sample }, { start, end, sample: start }] }).detail;
  assert.equal(clock(10000, 11000, 10000 - 999), null);
  assert.equal(clock(10000, 11000, 10000 - 1000), null);
  assert.equal(clock(10000, 11000, 10000 - 1001), 'clock_skew');
  assert.equal(clock(10000, 11000, 11000 + 999), null);
  assert.equal(clock(10000, 11000, 11000 + 1000), null);
  assert.equal(clock(10000, 11000, 11000 + 1001), 'clock_skew');
  assert.equal(clock(10000, 20000, 15000), null);
  assert.equal(clock(10000, 20001, 15000), 'clock_skew');
  assert.equal(clock(10000, 9999, 10000), 'clock_skew', 'a reversed bracket');
  assert.equal(clock(10000, 11000, 10000 + 60000), 'clock_skew');
});

t('gate checks: U2 needs exactly one successful handshake with an address for the endpoint host', () => {
  const event = { event: 'upstream', host: 'model.stub.test', handshake: 'ok', address: '172.18.0.2' };
  assert.deepEqual(checkU2([event], 'model.stub.test'), { result: 'pass', detail: null });
  assert.deepEqual(checkU2([{ ...event, handshake: 'failed' }], 'model.stub.test'), { result: 'fail', detail: 'handshake' });
  assert.deepEqual(checkU2([{ ...event, address: null }], 'model.stub.test'), { result: 'fail', detail: 'handshake' });
  assert.deepEqual(checkU2([], 'model.stub.test'), { result: 'fail', detail: 'upstream_missing' });
  assert.deepEqual(checkU2([event, event], 'model.stub.test'), { result: 'fail', detail: 'upstream_duplicate' });
});

t('gate checks: P4 and P5 pass only with the four matching sidecar events and no forwarded request', () => {
  const nonce = 'b'.repeat(32);
  const event = (decision, reason, over = {}) => ({ event: 'request', phase: 'probe', probe: nonce, decision, reason, status: decision === 'local' ? 200 : 403, ...over });
  const all = [event('refused', 'acoder_host_not_allowed'), event('refused', 'acoder_path_not_allowed'), event('local', null), event('refused', 'acoder_not_released')];
  const results = [{ id: 'P4', result: 'pass', detail: null }, { id: 'P5', result: 'pass', detail: null }];
  const status = requests => corroborate(results, requests, nonce).map(entry => entry.result);
  assert.deepEqual(status(all), ['pass', 'pass']);
  for (const index of [0, 1]) assert.deepEqual(status(all.filter((unused, at) => at !== index)), ['fail', 'pass']);
  for (const index of [2, 3]) assert.deepEqual(status(all.filter((unused, at) => at !== index)), ['pass', 'fail']);
  assert.deepEqual(status([...all, { ...event('forwarded', null), status: 200 }]), ['pass', 'fail'], 'a forwarded request in the probe phase');
  assert.deepEqual(status(all.map(entry => ({ ...entry, probe: 'c'.repeat(32) }))), ['fail', 'fail'], 'another probe value');
  assert.deepEqual(status(all.map(entry => ({ ...entry, phase: 'agent' }))), ['fail', 'fail'], 'phase agent');
  assert.deepEqual(corroborate([{ id: 'P4', result: 'fail', detail: 'host_not_refused' }], all, nonce), [{ id: 'P4', result: 'fail', detail: 'host_not_refused' }]);
});
