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

const leftIn = dir => { const out = []; const walk = d => { let names = []; try { names = fs.readdirSync(d); } catch { return; } for (const n of names) { const f = path.join(d, n); const i = fs.lstatSync(f); out.push(`${path.relative(dir, f)} ${(i.mode & 0o7777).toString(8)} ${i.isDirectory() ? 'd' : 'f'}`); if (i.isDirectory()) walk(f); } }; walk(dir); return out; };
export const ENDPOINT = 'https://model.stub.test/v1';
export const MARKER = 'stub-agent-marker.json';
const uidgid = `${process.getuid()}:${process.getgid()}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// The stub endpoint program inside its container: HTTPS on 443 with the test certificate. It counts every request in /out/count when its
// body has arrived, the answers still open in /out/open, and records each request's headers in /out/requests.jsonl. /srv/scenario.json
// names the answer of each request in order ({sequence: [...], default}); the modes: ok (JSON with usage), big (JSON with a large usage),
// no-usage (JSON without usage), fail (500), hold (an event stream that is never ended), usage-hold (an event stream that carries the final
// usage and is then held open), echo-key (the received authorization value in a header value, in a header NAME and in the body, plain and
// base64). The forbidden server (/srv/forbidden.mjs) counts the connections it accepts in /out/forbidden-count.
const ENDPOINT_PROGRAM = `import https from 'node:https';
import fs from 'node:fs';
const plan = fs.existsSync('/srv/scenario.json') ? JSON.parse(fs.readFileSync('/srv/scenario.json', 'utf8')) : {};
let count = 0;
let open = 0;
const json = (res, value, status = 200, headers = {}) => { const body = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers }); res.end(body); };
const usage = { input_tokens: 11, output_tokens: 7 };
const server = https.createServer({ key: fs.readFileSync('/srv/key.pem'), cert: fs.readFileSync('/srv/cert.pem') }, (req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    count += 1;
    const mode = (plan.sequence ?? [])[count - 1] ?? plan.default ?? 'ok';
    fs.appendFileSync('/out/requests.jsonl', JSON.stringify({ n: count, mode, url: req.url, rawHeaders: req.rawHeaders }) + '\\n');
    fs.writeFileSync('/out/count', String(count));
    open += 1;
    fs.writeFileSync('/out/open', String(open));
    res.on('close', () => { open -= 1; fs.writeFileSync('/out/open', String(open)); });
    if (mode === 'ok') return json(res, { id: 'resp_stub', model: 'stub-model', usage });
    if (mode === 'big') return json(res, { id: 'resp_stub', model: 'stub-model', usage: { input_tokens: 600, output_tokens: 400 } });
    if (mode === 'no-usage') return json(res, { id: 'resp_stub', model: 'stub-model' });
    if (mode === 'fail') return json(res, { error: { message: 'stub failure' } }, 500);
    if (mode === 'echo-key') {
      const value = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      const body = JSON.stringify({ id: 'resp_stub', model: 'stub-model', usage, plain: value, b64: Buffer.from(value).toString('base64') });
      res.writeHead(200, [['content-type', 'application/json'], ['x-echo', value], ['x-' + value, 'named'], ['content-length', String(Buffer.byteLength(body))]].flat());
      return res.end(body);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': ' + 'p'.repeat(2048) + '\\n\\n');
    if (mode === 'usage-hold') res.write('data: ' + JSON.stringify({ type: 'response.completed', response: { model: 'stub-model', usage } }) + '\\n\\n');
    return undefined;
  });
});
server.listen(443, '0.0.0.0', () => fs.writeFileSync('/out/ready', 'ready'));
`;
const FORBIDDEN_PROGRAM = `import net from 'node:net';
import fs from 'node:fs';
let count = 0;
const server = net.createServer(socket => { count += 1; fs.writeFileSync('/out/forbidden-count', String(count)); socket.end('forbidden server\\n'); });
server.listen(80, '0.0.0.0', () => fs.writeFileSync('/out/forbidden-ready', 'ready'));
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

// The runtime seam of a container test: every creating call also carries the test label; inspect answers can be altered (options.alter);
// a call can be failed without running it (options.failCall(args) true: code 1); and the timeline records, with host times, every
// control line written to a container's standard input, the receipt of the sidecar's summary event and every runtime call (S4-AC13), and
// for the gate order (F-38-05) every inspect answer the launcher received, every attached start, the sidecar's ready, upstream, clock and
// phase events and the supervisor's probes and clock events, in the order they arrived.
function testRuntimeSeam(options, context) {
  const timeline = context.timeline;
  return real => ({
    ...real,
    call: async (args, extra) => {
      timeline.push({ t: Date.now(), kind: 'call', args: [...args] });
      if (options.failCall?.(args) === true) return { code: 1, stdout: '', stderr: 'failed by the test' };
      return real.call(labelled(args, context.ids.id), extra);
    },
    attach: (name, extra) => {
      const to = isAgent(name) ? 'agent' : 'sidecar';
      timeline.push({ t: Date.now(), kind: 'attach', to, name });
      const child = real.attach(name, extra);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...rest) => { timeline.push({ t: Date.now(), kind: 'control', to, line: String(chunk).trim() }); return write(chunk, ...rest); };
      let pending = '';
      child.stdout.on('data', chunk => {
        pending += String(chunk);
        for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
          const line = pending.slice(0, at);
          pending = pending.slice(at + 1);
          if (to === 'sidecar' && /^\{"event":"(summary|limit)"/.test(line)) timeline.push({ t: Date.now(), kind: JSON.parse(line).event, to, line });
          const gate = to === 'sidecar' ? /^\{"event":"(ready|upstream|clock|phase)"/.exec(line) : /"event":"(probes|clock)"/.exec(line);
          if (gate !== null) timeline.push({ t: Date.now(), kind: `${to}-${gate[1]}`, to });
        }
      });
      child.on('close', () => timeline.push({ t: Date.now(), kind: 'exit', to }));
      return child;
    },
    inspect: async (kind, name) => {
      const info = await real.inspect(kind, name);
      timeline.push({ t: Date.now(), kind: 'inspect', what: kind, name });
      context.inspected = [...(context.inspected ?? []), { kind, name, text: JSON.stringify(info) }];
      return options.alter && info !== null ? options.alter(kind, name, structuredClone(info), context) : info;
    },
  });
}

// The test topology of a container test (A11): the fixture, the internal network EXT with the stub endpoint (alias model.stub.test) and,
// with options.forbidden, the forbidden server (alias forbidden.stub.test, TCP port 80). fn(context) runs the test; everything labelled
// is removed afterwards and the test asserts that nothing labelled remains (S4-AC18). options: tag, scenario, steps (stub-steps.json),
// skillFiles, endpoint ('good' | 'untrusted' | 'stopped'), answers ({sequence, default} of the stub endpoint), forbidden, fixture.
export async function withContainerEnv(options, fn) {
  const ids = testIds();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fixtureBase(), 'acr-')));
  const fx = makeFixture({ tag: options.tag ?? 'ct-S4-r1', ...(options.fixture ?? {}) });
  Object.assign(fx.writable, { startedRecord: path.join(fx.stage, `run-${fx.tag}.started.json`), runRecord: path.join(fx.stage, `run-${fx.tag}.json`) });
  const network = `acoder-test-ext-${ids.id}`;
  const out = path.join(base, 'out');
  const context = { base, fx, network, ids, out, timeline: [] };
  try {
    fs.copyFileSync(path.join(LAUNCHER, 'test/helpers/stub-agent.mjs'), path.join(fx.skill, 'stub-agent.mjs'));
    for (const file of options.skillFiles ?? []) fs.writeFileSync(path.join(fx.skill, file.name), file.text);
    const certs = path.join(base, 'certs');
    for (const dir of [certs, out]) fs.mkdirSync(dir);
    certificates(certs);
    context.caCert = path.join(certs, 'ca.pem');
    const srv = path.join(base, 'srv');
    fs.mkdirSync(srv);
    fs.writeFileSync(path.join(srv, 'server.mjs'), ENDPOINT_PROGRAM);
    fs.writeFileSync(path.join(srv, 'forbidden.mjs'), FORBIDDEN_PROGRAM);
    fs.writeFileSync(path.join(srv, 'scenario.json'), JSON.stringify(options.answers ?? {}));
    const untrusted = options.endpoint === 'untrusted';
    fs.copyFileSync(path.join(certs, untrusted ? 'untrusted-key.pem' : 'key.pem'), path.join(srv, 'key.pem'));
    fs.copyFileSync(path.join(certs, untrusted ? 'untrusted-cert.pem' : 'cert.pem'), path.join(srv, 'cert.pem'));
    const made = await docker(['network', 'create', '--internal', ...ids.labels, network]);
    assert.equal(made.code, 0, made.stderr);
    const serve = async (name, alias, program, ready) => {
      const started = await docker(['run', '--detach', '--name', name, ...ids.labels, '--network', network, '--network-alias', alias, '--user', uidgid, '--read-only',
        '--cap-drop', 'ALL', '--pull', 'never', '--mount', `type=bind,source=${srv},target=/srv,readonly`, '--mount', `type=bind,source=${out},target=/out`, '--entrypoint', 'node', IMAGE_ID(), program]);
      assert.equal(started.code, 0, started.stderr);
      const end = Date.now() + 20000;
      while (!fs.existsSync(path.join(out, ready)) && Date.now() < end) await wait(100);
      assert.ok(fs.existsSync(path.join(out, ready)), `${alias} listens`);
      return JSON.parse((await docker(['container', 'inspect', name])).stdout)[0].NetworkSettings.Networks[network].IPAddress;
    };
    if (options.endpoint !== 'stopped') context.endpointAddress = await serve(`stub-${ids.id}`, 'model.stub.test', '/srv/server.mjs', 'ready');
    if (options.forbidden) context.forbiddenAddress = await serve(`forbidden-${ids.id}`, 'forbidden.stub.test', '/srv/forbidden.mjs', 'forbidden-ready');
    const netInfo = JSON.parse((await docker(['network', 'inspect', network])).stdout)[0];
    context.gateway = netInfo?.IPAM?.Config?.find(entry => typeof entry?.Gateway === 'string')?.Gateway ?? null;
    const steps = typeof options.steps === 'function' ? options.steps(context) : options.steps;
    if (steps) fs.writeFileSync(path.join(fx.skill, 'stub-steps.json'), JSON.stringify(steps));
    const counter = name => () => (fs.existsSync(path.join(out, name)) ? Number(fs.readFileSync(path.join(out, name), 'utf8')) : 0);
    context.endpointCount = counter('count');
    context.endpointOpen = counter('open');
    context.forbiddenCount = counter('forbidden-count');
    context.endpointRequests = () => (fs.existsSync(path.join(out, 'requests.jsonl')) ? fs.readFileSync(path.join(out, 'requests.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
    context.argv = (extra = []) => fx.argv({
      drop: ['--dry-run'], set: { '--image': IMAGE_ID(), '--model-endpoint': ENDPOINT },
      add: [['--agent', 'stub'], ['--model', options.scenario ?? 'marker'], ['--extra-ca-cert', context.caCert], ...extra],
    }).slice(2);
    context.runtimeSeam = testRuntimeSeam(options, context);
    return await fn(context);
  } finally {
    const left = await removeLabelled(ids.filter);
    // Docker Desktop's file sharing can still report an entry for a moment after the containers are gone: retry the removal.
    for (const remove of [() => forceRemove(base), () => fx.cleanup()]) {
      for (let attempt = 0; ; attempt += 1) {
        try { remove(); break; } catch (error) { if (attempt >= 120) throw new Error(`${error.message}; left: ${JSON.stringify(leftIn(fx.base))}`); await wait(250); }
      }
    }
    assert.deepEqual(left, { containers: [], volumes: [], networks: [] }, 'S4-AC18: no labelled resource of the test remains');
  }
}

// The test seams of runReview for a container test (A11): the stub adapter, EXT (unless options.ownNetwork), the runtime seam, the plan
// transform, the hooks and the gate limit.
export function containerDeps(options, context) {
  return {
    adapters: { ...adapters, stub }, providers, egressNetwork: options.ownNetwork ? undefined : context.network, runtime: context.runtimeSeam,
    sidecarProgram: options.sidecar ? sidecarDouble(context.base, options.sidecar) : undefined,
    planTransform: options.planTransform ? plan => options.planTransform(plan, context) : undefined,
    hooks: {
      beforeRelease: options.hooks?.beforeRelease ? info => options.hooks.beforeRelease(info, context) : undefined,
      afterStop: options.hooks?.afterStop ? info => options.hooks.afterStop(info, context) : undefined,
      afterSnapshot: options.afterSnapshot ? info => options.afterSnapshot(info, context) : undefined,
    },
    clock: { now: Date.now, gateMs: options.gateMs ?? 90000 },
  };
}

// options: scenario (stub agent), steps, wallSeconds, limits ({calls, tokens, max_in_flight, scratch_max_bytes}), gateMs, planTransform(plan,
// context), alter(kind, name, info, context) (inspect answers), failCall(args), sidecar ([[from, to]] for a double), hooks {beforeRelease,
// afterStop}(info, context), afterSnapshot(info, context), endpoint, answers, forbidden, ownNetwork (the launcher creates EXT itself; the
// stub endpoint is then out of its reach), skillFiles, tag, fixture.
export async function withContainerRun(options, fn) {
  // The run first: the context then carries what the run added to it (the inspect answers the launcher read).
  return withContainerEnv(options, async context => { const run = await runInContext(options, context); return fn({ ...context, ...run }); });
}

// One runReview in the topology of withContainerEnv (a test may launch twice in the same fixture); returns {result, record, runLeft,
// marker, check(id)}.
export async function runInContext(options, context) {
  const parsed = parseReviewRun(context.argv());
  const settings = resolveSettings({ options: parsed, owner: {}, defaults: loadDefaults(), adapters: { ...adapters, stub }, providers });
  settings.limits.wall_seconds = options.wallSeconds ?? 60;
  Object.assign(settings.limits, options.limits ?? {});
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ACODER_MODEL_API_KEY: context.fx.key, ...(options.env ?? {}) };
  const result = await mustAsync(() => runReview({ options: parsed, settings, env }, containerDeps(options, context)));
  const record = result.record !== '-' && fs.existsSync(result.record) ? JSON.parse(fs.readFileSync(result.record, 'utf8')) : null;
  const runLeft = await listLabelled(`label=acoder.run=${result.run_id}`);
  return { result, record, runLeft, marker: path.join(context.fx.writable.scratch, MARKER), check: id => record?.isolation_checks.find(entry => entry.id === id) };
}

// The agent's own output lines in the log of a run (each written as `<time> agent <line>`), parsed when they are JSON.
export function agentLines(record) {
  const text = fs.existsSync(record.log_path) ? fs.readFileSync(record.log_path, 'utf8') : '';
  return text.split('\n').map(line => /^\S+ agent (.*)$/.exec(line)?.[1]).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

// The stub agent's probe results (A11 proof of inside): they carry the nonce, arrive on the container's stream (the log) and include
// /acoder/run.json; returned as a map from a label to the result.
export function probeResults(record, nonce) {
  const found = agentLines(record).filter(line => line.stub === 'probe-results');
  assert.equal(found.length, 1, 'one probe result line arrived on the agent container\'s stream');
  assert.equal(found[0].nonce, nonce, 'the probe result carries the nonce of this test');
  assert.equal(found[0].run_json?.tag, record.tag, 'the probe result includes /acoder/run.json of this run');
  return Object.fromEntries(found[0].results.map(entry => [entry.label, entry]));
}

// The ordering of a launcher stop (A6.5): STOP is the first control line after RELEASE, the summary arrives before any runtime call that
// signals the agent container, and at least one such call was made. Returns the timeline entries.
export function assertStopOrder(timeline, { signalRequired = true } = {}) {
  const release = timeline.findIndex(entry => entry.kind === 'control' && entry.to === 'agent' && entry.line.startsWith('RELEASE '));
  assert.ok(release >= 0, 'RELEASE was written');
  const after = timeline.slice(release + 1);
  const stop = after.findIndex(entry => entry.kind === 'control' && entry.to === 'sidecar' && entry.line === 'STOP');
  assert.ok(stop >= 0, 'STOP was written to the sidecar');
  const signal = entry => entry.kind === 'call' && ['kill', 'stop'].includes(entry.args[0]) && isAgent(entry.args.at(-1));
  const firstSignal = after.findIndex(signal);
  const summary = after.findIndex(entry => entry.kind === 'summary');
  assert.ok(summary > stop, 'the summary arrived after STOP');
  if (signalRequired) assert.ok(firstSignal >= 0, 'a runtime call signalled the agent container');
  if (firstSignal >= 0) {
    assert.ok(stop < firstSignal, 'STOP was written before any signal to the agent container');
    assert.ok(summary < firstSignal, 'the summary arrived before any signal to the agent container');
  }
  return { stopAt: after[stop].t, summaryAt: after[summary].t, signalAt: firstSignal >= 0 ? after[firstSignal].t : null };
}

// The gate order of A6.6 E3 as built and accepted by the owner (D-R41 (1), F-38-05), from the timeline of the run: (a) the sidecar starts
// only after the inspect answers H3 and H4 are decided on (its container, the volume, EXT); (b) the agent container starts only after the
// answer H1 and H2 are decided on and after the sidecar started (and, in a run whose sidecar answered in time, after its ready event); (c)
// PHASE is written only after the supervisor's probe results and both clock answers arrived (the fourteen results), and RELEASE only after
// the sidecar acknowledged the phase. failed: the id of the check an adverse fixture fails (null for a healthy run): with H3 or H4 nothing
// starts; with H1 or H2 the agent container never starts and the sidecar is stopped (its attached start ends) and removed; with any failed
// check neither PHASE nor RELEASE is written.
export function assertGateSequence({ timeline, result }, failed = null) {
  const at = predicate => timeline.findIndex(predicate);
  const inspected = (what, match) => at(entry => entry.kind === 'inspect' && entry.what === what && match(entry.name));
  const start = to => at(entry => entry.kind === 'attach' && entry.to === to);
  const control = (to, prefix) => at(entry => entry.kind === 'control' && entry.to === to && entry.line.startsWith(prefix));
  const order = JSON.stringify(timeline.filter(entry => entry.kind !== 'call' || ['create', 'start', 'rm', 'kill', 'stop'].includes(entry.args[0])).map(entry => `${entry.kind}:${entry.to ?? entry.what ?? entry.args?.[0] ?? ''}`));
  const sidecarStart = start('sidecar');
  const agentStart = start('agent');
  const h3h4 = [inspected('container', isSidecar), inspected('volume', () => true), inspected('network', () => true)];
  if (sidecarStart >= 0) assert.ok(h3h4.every(index => index >= 0 && index < sidecarStart), `(a) H3 and H4 were decided before the sidecar started: ${order}`);
  if (agentStart >= 0) {
    const h1h2 = inspected('container', isAgent);
    assert.ok(h1h2 >= 0 && h1h2 < agentStart, `(b) H1 and H2 were decided before the agent container started: ${order}`);
    assert.ok(sidecarStart >= 0 && sidecarStart < agentStart, `(b) the sidecar started before the agent container: ${order}`);
    if (!['U1', 'U2'].includes(failed)) {
      const ready = at(entry => entry.kind === 'sidecar-ready');
      assert.ok(ready >= 0 && ready < agentStart, `(b) the sidecar was ready before the agent container started: ${order}`);
    }
  }
  const phase = control('sidecar', 'PHASE ');
  const release = control('agent', 'RELEASE ');
  if (phase >= 0) {
    for (const kind of ['agent-probes', 'sidecar-clock', 'agent-clock']) {
      const index = at(entry => entry.kind === kind);
      assert.ok(index >= 0 && index < phase, `(c) ${kind} arrived before PHASE: ${order}`);
    }
  }
  if (release >= 0) {
    const ack = at(entry => entry.kind === 'sidecar-phase');
    assert.ok(phase >= 0 && ack > phase && ack < release, `(c) the sidecar acknowledged PHASE before RELEASE: ${order}`);
  }
  if (failed === null) {
    assert.ok(sidecarStart >= 0 && agentStart >= 0 && phase >= 0 && release >= 0, `a healthy run starts both containers, writes PHASE and RELEASE: ${order}`);
    return;
  }
  assert.equal(phase, -1, `no PHASE after a failed check: ${order}`);
  assert.equal(release, -1, `no RELEASE after a failed check: ${order}`);
  if (failed === 'H3' || failed === 'H4') {
    assert.equal(sidecarStart, -1, `${failed} failed: the sidecar never started: ${order}`);
    assert.equal(agentStart, -1, `${failed} failed: the agent container never started: ${order}`);
    assert.equal(at(entry => entry.kind === 'call' && entry.args[0] === 'create' && entry.args.some(isAgentArg)), -1, `${failed} failed: the agent container was never created: ${order}`);
  }
  if (failed === 'H1' || failed === 'H2') {
    assert.equal(agentStart, -1, `${failed} failed: the agent container never started: ${order}`);
    assert.ok(sidecarStart >= 0, `${failed} is decided after the sidecar started (E3 as built): ${order}`);
    assert.ok(at(entry => entry.kind === 'exit' && entry.to === 'sidecar') > sidecarStart, `${failed} failed: the sidecar's attached start ended: ${order}`);
    assert.ok(at(entry => entry.kind === 'call' && entry.args[0] === 'rm' && isSidecar(String(entry.args.at(-1)))) > sidecarStart, `${failed} failed: the sidecar was removed: ${order}`);
  }
  assert.equal(result.outcome, 'not-started');
}
const isAgentArg = item => typeof item === 'string' && item.startsWith('acoder-agent-');

// The not-started outcome of an adverse fixture (S4-AC5): that check fails in the record, agent_started false, no started file, no agent
// marker in scratch, a not-started record, no runtime resource of the run, and the gate order of assertGateSequence.
export function assertNotStarted({ result, record, fx, marker, runLeft, check, timeline }, id, detail = undefined) {
  assertGateSequence({ timeline, result }, id);
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
  assertStagingGone({ fx, record });
  for (const file of [fx.writable.reportMd, fx.writable.reportJson, fx.writable.scratch]) assert.equal(fs.existsSync(file), false, `${path.basename(file)} (empty, created by this attempt) is removed`);
}

// S4-AC18: the staging directory is gone, or the record's cleanup field names exactly what remained (Docker Desktop can hold a nested
// mount point of the snapshot for a while after the containers are removed, when many containers run at once).
export function assertStagingGone({ fx, record }) {
  const left = fs.readdirSync(fx.staging).map(name => path.join(fx.staging, name));
  if (left.length === 0) { assert.deepEqual(record.cleanup, { status: 'complete', leftovers: [] }); return; }
  assert.deepEqual(record.cleanup, { status: 'incomplete', leftovers: left }, 'what remained is named in the record');
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
