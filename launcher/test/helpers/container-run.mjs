// Runs runReview on real containers for the container tests (A11): an internal test network EXT with the stub model endpoint as a
// container under the alias model.stub.test (certificates made at test time by openssl), a synthetic mailbox whose reviewer skill folder
// carries the stub agent, the stub adapter, and the test seams of runReview. Every resource carries the test label (the runtime seam adds
// it to every creating call of the run); everything is removed afterwards and the test asserts that nothing labelled remains (S4-AC18).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { adapters } from '../../adapters/index.mjs';
import { parseReviewRun } from '../../lib/args.mjs';
import { loadDefaults, resolveSettings } from '../../lib/config.mjs';
import { runReview } from '../../lib/run.mjs';
import { providers } from '../../providers/index.mjs';
import { docker, IMAGE_ID, listLabelled, removeLabelled, TEST_LABEL_KEY, testIds } from './container-env.mjs';
import { fixtureBase, forceRemove, LAUNCHER, makeFixture, mustAsync } from './fixtures.mjs';
import * as stub from './stub-adapter.mjs';

export const ENDPOINT = 'https://model.stub.test/v1';
export const MARKER = 'stub-agent-marker.json';
const uidgid = `${process.getuid()}:${process.getgid()}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// The stub endpoint program inside its container: HTTPS on 443 with the test certificate; it counts requests in /out/count.
const ENDPOINT_PROGRAM = `import https from 'node:https';
import fs from 'node:fs';
let count = 0;
const server = https.createServer({ key: fs.readFileSync('/srv/key.pem'), cert: fs.readFileSync('/srv/cert.pem') }, (req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    count += 1;
    fs.writeFileSync('/out/count', String(count));
    const body = JSON.stringify({ id: 'resp_stub', model: 'stub-model', usage: { input_tokens: 11, output_tokens: 7 } });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
});
server.listen(443, '0.0.0.0', () => fs.writeFileSync('/out/ready', 'ready'));
`;

function certificates(dir) {
  const run = args => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2'];
  run(['req', '-x509', ...ec, '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=acoder container test ca', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign']);
  run(['req', '-x509', ...ec, '-keyout', 'key.pem', '-out', 'cert.pem', '-subj', '/CN=model.stub.test', '-addext', 'subjectAltName=DNS:model.stub.test', '-addext', 'basicConstraints=CA:FALSE', '-CA', 'ca.pem', '-CAkey', 'ca.key']);
  run(['req', '-x509', ...ec, '-keyout', 'untrusted-key.pem', '-out', 'untrusted-cert.pem', '-subj', '/CN=model.stub.test', '-addext', 'subjectAltName=DNS:model.stub.test']);
}

// A sidecar double: the real proxy.mjs with exact text replacements [[from, to], ...]; each `from` must occur exactly once.
export function sidecarDouble(dir, replacements) {
  let text = fs.readFileSync(path.join(LAUNCHER, 'container/proxy.mjs'), 'utf8');
  for (const [from, to] of replacements) {
    assert.equal(text.split(from).length - 1, 1, `the double's anchor occurs once: ${from}`);
    text = text.replace(from, () => to);
  }
  const file = path.join(dir, 'sidecar-double.mjs');
  fs.writeFileSync(file, text);
  return file;
}

// The creating calls of the run also carry the test label, so `test:container:cleanup` finds them.
function labelled(args, id) {
  const at = args[0] === 'create' || args[0] === 'run' ? 1 : (['volume', 'network'].includes(args[0]) && args[1] === 'create') ? 2 : -1;
  return at < 0 ? args : [...args.slice(0, at), '--label', `${TEST_LABEL_KEY}=${id}`, ...args.slice(at)];
}

// options: scenario (stub agent), wallSeconds, gateMs, planTransform(plan, context), alter(kind, name, info, context) (inspect answers),
// sidecar ([[from, to]] for a double), hooks {beforeRelease(info, context)}, afterSnapshot(info, context), endpoint ('good' | 'untrusted' |
// 'stopped'), ownNetwork (the launcher creates EXT itself; the stub endpoint is then out of its reach), skillFiles.
export async function withContainerRun(options, fn) {
  const ids = testIds();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fixtureBase(), 'acr-')));
  const fx = makeFixture({ tag: options.tag ?? 'ct-S4-r1' });
  Object.assign(fx.writable, { startedRecord: path.join(fx.stage, `run-${fx.tag}.started.json`), runRecord: path.join(fx.stage, `run-${fx.tag}.json`) });
  const network = `acoder-test-ext-${ids.id}`;
  const context = { base, fx, network, ids };
  try {
    fs.copyFileSync(path.join(LAUNCHER, 'test/helpers/stub-agent.mjs'), path.join(fx.skill, 'stub-agent.mjs'));
    for (const file of options.skillFiles ?? []) fs.writeFileSync(path.join(fx.skill, file.name), file.text);
    const certs = path.join(base, 'certs');
    const out = path.join(base, 'out');
    for (const dir of [certs, out]) fs.mkdirSync(dir);
    certificates(certs);
    const srv = path.join(base, 'srv');
    fs.mkdirSync(srv);
    fs.writeFileSync(path.join(srv, 'server.mjs'), ENDPOINT_PROGRAM);
    const untrusted = options.endpoint === 'untrusted';
    fs.copyFileSync(path.join(certs, untrusted ? 'untrusted-key.pem' : 'key.pem'), path.join(srv, 'key.pem'));
    fs.copyFileSync(path.join(certs, untrusted ? 'untrusted-cert.pem' : 'cert.pem'), path.join(srv, 'cert.pem'));
    const made = await docker(['network', 'create', '--internal', ...ids.labels, network]);
    assert.equal(made.code, 0, made.stderr);
    if (options.endpoint !== 'stopped') {
      const endpoint = await docker(['run', '--detach', '--name', `stub-${ids.id}`, ...ids.labels, '--network', network, '--network-alias', 'model.stub.test', '--user', uidgid, '--read-only',
        '--cap-drop', 'ALL', '--pull', 'never', '--mount', `type=bind,source=${srv},target=/srv,readonly`, '--mount', `type=bind,source=${out},target=/out`, '--entrypoint', 'node', IMAGE_ID(), '/srv/server.mjs']);
      assert.equal(endpoint.code, 0, endpoint.stderr);
      const end = Date.now() + 20000;
      while (!fs.existsSync(path.join(out, 'ready')) && Date.now() < end) await wait(100);
      assert.ok(fs.existsSync(path.join(out, 'ready')), 'the stub endpoint listens');
      const info = JSON.parse((await docker(['container', 'inspect', `stub-${ids.id}`])).stdout)[0];
      context.endpointAddress = info.NetworkSettings.Networks[network].IPAddress;
    }
    context.endpointCount = () => (fs.existsSync(path.join(out, 'count')) ? Number(fs.readFileSync(path.join(out, 'count'), 'utf8')) : 0);
    const argv = fx.argv({
      drop: ['--dry-run'], set: { '--image': IMAGE_ID(), '--model-endpoint': ENDPOINT },
      add: [['--agent', 'stub'], ['--model', options.scenario ?? 'marker'], ['--extra-ca-cert', path.join(certs, 'ca.pem')]],
    }).slice(2);
    const parsed = parseReviewRun(argv);
    const registry = { ...adapters, stub };
    const settings = resolveSettings({ options: parsed, owner: {}, defaults: loadDefaults(), adapters: registry, providers });
    settings.limits.wall_seconds = options.wallSeconds ?? 60;
    const sidecarProgram = options.sidecar ? sidecarDouble(base, options.sidecar) : undefined;
    const wrap = real => ({
      ...real,
      call: (args, extra) => real.call(labelled(args, ids.id), extra),
      inspect: async (kind, name) => {
        const info = await real.inspect(kind, name);
        context.inspected = [...(context.inspected ?? []), { kind, name, text: JSON.stringify(info) }];
        return options.alter && info !== null ? options.alter(kind, name, structuredClone(info), context) : info;
      },
    });
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, ACODER_MODEL_API_KEY: fx.key };
    const deps = {
      adapters: registry, providers, egressNetwork: options.ownNetwork ? undefined : network, runtime: wrap, sidecarProgram,
      planTransform: options.planTransform ? plan => options.planTransform(plan, context) : undefined,
      hooks: {
        beforeRelease: options.hooks?.beforeRelease ? info => options.hooks.beforeRelease(info, context) : undefined,
        afterSnapshot: options.afterSnapshot ? info => options.afterSnapshot(info, context) : undefined,
      },
      clock: { now: Date.now, gateMs: options.gateMs ?? 90000 },
    };
    const result = await mustAsync(() => runReview({ options: parsed, settings, env }, deps));
    const record = result.record !== '-' && fs.existsSync(result.record) ? JSON.parse(fs.readFileSync(result.record, 'utf8')) : null;
    const runLeft = await listLabelled(`label=acoder.run=${result.run_id}`);
    return await fn({ ...context, result, record, runLeft, marker: path.join(fx.writable.scratch, MARKER), check: id => record?.isolation_checks.find(entry => entry.id === id) });
  } finally {
    const left = await removeLabelled(ids.filter);
    forceRemove(base);
    fx.cleanup();
    assert.deepEqual(left, { containers: [], volumes: [], networks: [] }, 'S4-AC18: no labelled resource of the test remains');
  }
}

// The not-started outcome of an adverse fixture (S4-AC5): that check fails in the record, agent_started false, no started file, no agent
// marker in scratch, a not-started record, and no runtime resource of the run.
export function assertNotStarted({ result, record, fx, marker, runLeft, check }, id, detail = undefined) {
  assert.equal(result.outcome, 'not-started', `the attempt is not started (${result.state} ${result.detail})`);
  assert.equal(result.exit_code, 1);
  assert.ok(record !== null, 'a not-started record was written');
  assert.match(path.basename(result.record), new RegExp(`^run-${fx.tag}\\.notstarted-\\d{8}T\\d{6}Z-[0-9a-f]{6}\\.json$`));
  assert.equal(check(id)?.result, 'fail', `${id} fails: ${JSON.stringify(record.isolation_checks)}`);
  if (detail !== undefined) assert.equal(check(id).detail, detail);
  assert.equal(record.agent_started, false);
  assert.equal(record.exit_reason, null);
  assert.equal(record.error_detail, 'gate_failed');
  assert.equal(fs.existsSync(fx.writable.startedRecord), false, 'no started file');
  assert.equal(fs.existsSync(marker), false, 'the stub agent marker is absent');
  assert.deepEqual(runLeft, { containers: [], volumes: [], networks: [] }, 'all resources of the run are gone');
  assert.deepEqual(fs.readdirSync(fx.staging), [], 'the staging directory is removed');
  for (const file of [fx.writable.reportMd, fx.writable.reportJson, fx.writable.scratch]) assert.equal(fs.existsSync(file), false, `${path.basename(file)} (empty, created by this attempt) is removed`);
  assert.equal(record.cleanup.status, 'complete');
}

// Plan transforms and inspect masks of the adverse fixtures.
export const agentArgs = plan => plan.agent.create;
export function insertBeforeImage(args, extra) {
  const at = args.length - 2;
  return [...args.slice(0, at), ...extra, ...args.slice(at)];
}
export const isAgent = name => name.startsWith('acoder-agent-');
export const isSidecar = name => name.startsWith('acoder-sidecar-');

// The shared plan transforms and inspect masks of the adverse fixtures.
export const replaceIn = (args, from, to) => { const at = args.indexOf(from); assert.ok(at >= 0, `${from} is in the arguments`); return [...args.slice(0, at), to, ...args.slice(at + 1)]; };
export const agentNetworkExt = (plan, { network }) => { const at = plan.agent.create.indexOf('none'); assert.equal(plan.agent.create[at - 1], '--network'); plan.agent.create[at] = network; return plan; };
export const maskAgentNetwork = (kind, name, info) => {
  if (kind === 'container' && isAgent(name)) { info.HostConfig.NetworkMode = 'none'; info.Networks = { none: {} }; }
  return info;
};
export const pushSecurity = (match, option) => (kind, name, info) => {
  if (kind === 'container' && match(name)) info.HostConfig.SecurityOpt = [...(info.HostConfig.SecurityOpt ?? []), option];
  return info;
};

// P2: a DNS responder on 127.0.0.1:53 inside the agent container, started before the supervisor by a wrapper program; the inspect answer
// shows the planned command so that H2 passes. It answers "no such name" for example.com and an address for every other name.
export const DNS_WRAPPER = `import dgram from 'node:dgram';
const socket = dgram.createSocket('udp4');
socket.on('message', (query, remote) => {
  let at = 12; const labels = [];
  while (query[at] > 0) { labels.push(query.subarray(at + 1, at + 1 + query[at]).toString()); at += query[at] + 1; }
  const head = Buffer.from(query.subarray(0, 12));
  const question = query.subarray(12, at + 5);
  if (labels.join('.') === 'example.com') { head[2] = 0x81; head[3] = 0x83; socket.send(Buffer.concat([head, question]), remote.port, remote.address); return; }
  head[2] = 0x81; head[3] = 0x80; head[6] = 0; head[7] = 1;
  const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 10, 9, 8, 7]);
  socket.send(Buffer.concat([head, question, answer]), remote.port, remote.address);
});
socket.bind(53, '127.0.0.1', async () => { const entry = await import('/acoder/container/entry.mjs'); entry.main(); });
`;
export const dropRequest = condition => [['    totals.bytes_down += record.bytes_down;\n    emit(record);', `    totals.bytes_down += record.bytes_down;\n    if (!(${condition})) emit(record);`]];
