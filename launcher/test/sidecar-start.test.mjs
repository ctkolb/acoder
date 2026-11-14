import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { validateEvent } from '../lib/events.mjs';
import { fixtureBase, forceRemove, sha } from './helpers/fixtures.mjs';
import { expectedForms, syntheticKey } from './helpers/key-forms.mjs';
import { waitFor } from './helpers/sidecar-harness.mjs';
import { request, streaming } from './helpers/socket-client.mjs';
import { ENDPOINT_HOST, jsonAnswer, makeCertificates, OPENSSL_MISSING, ssePad, sseText, startStub } from './helpers/stub-endpoint.mjs';

// G11: every test has a finite time limit of its own and is registered from this file (the mutation runner counts tests per module);
// a test that needs the stub certificate is skipped with the reason when `openssl` is absent.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout, skip: OPENSSL_MISSING }, fn);

// S3-AC9 (start-up), the process side of S3-AC6 (STOP and end of input) and of S3-AC8 (fatal): main() runs as its own process.
const HELPER = new URL('./helpers/sidecar-main.mjs', import.meta.url).pathname;
const PROFILE = new URL('../providers/openai.mjs', import.meta.url).pathname;
const RUN_ID = 'b'.repeat(32);
const KEY_ENV = 'ACODER_UPSTREAM_KEY';
const baseConfig = () => ({
  run_id: RUN_ID, provider: { id: 'openai', module: PROFILE }, endpoint: { host: ENDPOINT_HOST, path: '/v1' }, allowlist: [ENDPOINT_HOST], key_env: KEY_ENV,
  limits: { calls: 50, tokens: 1000000, max_in_flight: 4 }, extra_ca: false,
});

// options: config (fields merged into the valid configuration), configText (the file as given), noConfig, env, key, cert, scenario,
// before(base, socketPath).
async function withMain(options, fn) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fixtureBase(), 'acm-')));
  let stub = null;
  let child = null;
  let exited = null;
  try {
    const certs = makeCertificates(base);
    stub = await startStub({ tls: certs[options.cert ?? 'good'], scenario: options.scenario });
    fs.writeFileSync(path.join(base, 'ca.pem'), certs.ca);
    const key = options.key ?? syntheticKey();
    const socket = path.join(base, 's');
    await options.before?.(base, socket);
    const configPath = path.join(base, 'egress.json');
    const fields = typeof options.config === 'function' ? options.config(base) : options.config;
    const configText = options.configText ?? `${JSON.stringify({ ...baseConfig(), ...fields }, null, 2)}\n`;
    if (!options.noConfig) fs.writeFileSync(configPath, configText);
    const env = options.env ?? { ACODER_RUN_ID: RUN_ID, [KEY_ENV]: key };
    child = spawn(process.execPath, [HELPER, JSON.stringify({ configPath, socketPath: socket, stubPort: stub.port, caPath: path.join(base, 'ca.pem') })], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    const events = [];
    let stderr = '';
    let pending = '';
    child.stdout.on('data', chunk => {
      pending += chunk.toString('utf8');
      for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        lines.push(line);
        try { events.push(JSON.parse(line)); } catch { events.push({ unparsed: line }); }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.stdin.on('error', () => {});
    exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal, at: Date.now() })));
    const ctx = {
      key, socket, stub, base, configText, lines, events, exited,
      stderr: () => stderr,
      send: line => child.stdin.write(`${line}\n`),
      endInput: () => child.stdin.end(),
      event: (kind, timeoutMs = 5000) => waitFor(() => events.find(event => event.event === kind), timeoutMs),
      exit: (timeoutMs = 5000) => Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(null), timeoutMs))]),
    };
    return await fn(ctx);
  } finally {
    if (child !== null && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await stub?.close();
    forceRemove(base);
  }
}

const allValid = events => events.map(event => validateEvent('sidecar', event, { allowlist: [ENDPOINT_HOST] })).filter(problems => problems.length > 0);
const formsIn = (text, key) => Object.entries(expectedForms(key)).filter(([, form]) => text.includes(form)).map(([name]) => name);

t('sidecar-start: ready (configuration hash, variable names, clock), socket mode 0600, then the U2 handshake and the upstream event; STOP: summary and exit 0 within 5 s', () => withMain({}, async ctx => {
  const before = Date.now();
  const ready = await ctx.event('ready');
  assert.ok(ready, `ready is printed; stderr: ${ctx.stderr().slice(0, 300)}`);
  assert.deepEqual(Object.keys(ready).sort(), ['clock_epoch_ms', 'config_sha256', 'env_names', 'event']);
  assert.equal(ready.config_sha256, sha(ctx.configText));
  // macOS adds __CF_USER_TEXT_ENCODING to the environment of every process it starts; no other name may appear.
  const platformNames = process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [];
  assert.deepEqual(ready.env_names.filter(name => !platformNames.includes(name)), ['ACODER_RUN_ID', KEY_ENV], 'the names of the environment, never a value');
  assert.ok(!ready.env_names.includes(ctx.key) && !ready.env_names.includes(RUN_ID));
  assert.ok(ready.clock_epoch_ms >= before - 10000 && ready.clock_epoch_ms <= Date.now());
  assert.equal(fs.lstatSync(ctx.socket).isSocket(), true);
  assert.equal(fs.statSync(ctx.socket).mode & 0o777, 0o600, 'the socket has mode 0600');
  const upstream = await ctx.event('upstream');
  assert.deepEqual(upstream, { event: 'upstream', host: ENDPOINT_HOST, handshake: 'ok', address: '127.0.0.1' });
  assert.ok(ctx.events.indexOf(ready) < ctx.events.indexOf(upstream));
  assert.ok(await waitFor(() => ctx.stub.counts.tcp >= 1, 3000), 'the handshake reached the endpoint (its own completion is the sidecar\'s verified secureConnect)');
  assert.equal(ctx.stub.requests.length, 0, 'the handshake sends no HTTP request and no key');
  const probe = await request(ctx.socket, { method: 'GET', path: '/__acoder/probe' });
  assert.deepEqual(JSON.parse(probe.body.toString('utf8')), { run_id: RUN_ID, phase: 'probe' });
  const stopped = Date.now();
  ctx.send('STOP');
  const exit = await ctx.exit(5000);
  assert.ok(exit !== null, 'the process exits within 5 s of STOP');
  assert.deepEqual([exit.code, exit.signal], [0, null]);
  assert.ok(exit.at - stopped < 5000);
  assert.equal(ctx.events.at(-1).event, 'summary');
  assert.deepEqual(allValid(ctx.events), []);
  assert.equal(ctx.stderr(), '');
  assert.deepEqual(formsIn(ctx.lines.join('\n'), ctx.key), []);
}));

t('sidecar-start: a key of exactly 16 characters is accepted', () => withMain({ key: randomBytes(12).toString('base64url') }, async ctx => {
  assert.ok(await ctx.event('ready'));
  ctx.send('STOP');
  assert.equal((await ctx.exit(5000))?.code, 0);
}));

t('sidecar-start: end of input is STOP: the request in flight is aborted, the summary is printed and the process exits 0 within 5 s', () => {
  const scenario = async (req, res) => {
    res.on('error', () => {});
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sseText([{ type: 'response.created', response: { model: 'm' } }]) + ssePad());
    await new Promise(resolve => { res.on('close', resolve); setTimeout(resolve, 8000); });
  };
  return withMain({ scenario }, async ctx => {
    assert.ok(await ctx.event('upstream'));
    ctx.send(`PHASE agent ${Date.now() + 600000}`);
    assert.ok(await ctx.event('phase'));
    const stream = streaming(ctx.socket);
    assert.ok(await waitFor(() => stream.chunks.length > 0, 4000));
    const ended = Date.now();
    ctx.endInput();
    const exit = await ctx.exit(5000);
    assert.ok(exit !== null && exit.at - ended < 5000, 'the process exits within 5 s of the end of input');
    assert.deepEqual([exit.code, exit.signal], [0, null]);
    assert.equal((await stream.done).complete, false);
    const kinds = ctx.events.map(event => event.event);
    assert.deepEqual(kinds.slice(-2), ['request', 'summary']);
    assert.equal(ctx.events.at(-2).complete, false);
    assert.deepEqual(allValid(ctx.events), []);
    assert.equal(ctx.stderr(), '');
  });
});

t('sidecar-start: U2 against an untrusted certificate reports a failed handshake and no request; the sidecar keeps running', () => withMain({ cert: 'other' }, async ctx => {
  const upstream = await ctx.event('upstream');
  assert.equal(upstream?.handshake, 'failed');
  assert.deepEqual(allValid([upstream]), []);
  assert.equal(ctx.stub.requests.length, 0);
  ctx.send('STOP');
  assert.equal((await ctx.exit(5000))?.code, 0);
}));

// Each start-up refusal: exactly one fatal event with its code, exit 70, no socket, nothing on standard error.
const refusals = {
  'the key variable is missing': [{ env: { ACODER_RUN_ID: RUN_ID } }, 'config_invalid'],
  'the key is empty': [{ key: '' }, 'config_invalid'],
  'the key is shorter than 16 characters': [{ key: randomBytes(12).toString('base64url').slice(0, 15) }, 'config_invalid'],
  'the key has a character outside [A-Za-z0-9_-]': [{ key: `${randomBytes(12).toString('base64url')}!` }, 'config_invalid'],
  'the configuration file is missing': [{ noConfig: true }, 'config_invalid'],
  'the configuration is not JSON': [{ configText: '{"run_id": ' }, 'config_invalid'],
  'the configuration is a list': [{ configText: '[]' }, 'config_invalid'],
  'run_id is missing': [{ config: { run_id: undefined } }, 'config_invalid'],
  'run_id is not a resource name': [{ config: { run_id: '../x' } }, 'config_invalid'],
  'an unknown field': [{ config: { extra: 1 } }, 'config_invalid'],
  'the endpoint host is not in the allowlist': [{ config: { allowlist: ['other.test'] } }, 'config_invalid'],
  'the endpoint host is not a DNS name': [{ config: { endpoint: { host: 'Models.Test:443', path: '/v1' }, allowlist: ['Models.Test:443'] } }, 'config_invalid'],
  'the endpoint path has a query': [{ config: { endpoint: { host: ENDPOINT_HOST, path: '/v1?x=1' } } }, 'config_invalid'],
  'key_env is not a variable name': [{ config: { key_env: 'acoder-key' } }, 'config_invalid'],
  'limits.calls is 0': [{ config: { limits: { calls: 0, tokens: 1000, max_in_flight: 4 } } }, 'config_invalid'],
  'limits.tokens is negative': [{ config: { limits: { calls: 1, tokens: -1, max_in_flight: 4 } } }, 'config_invalid'],
  'limits.max_in_flight is 0': [{ config: { limits: { calls: 1, tokens: 1000, max_in_flight: 0 } } }, 'config_invalid'],
  'extra_ca is not a boolean': [{ config: { extra_ca: 'no' } }, 'config_invalid'],
  'the profile module path is relative': [{ config: { provider: { id: 'openai', module: 'providers/openai.mjs' } } }, 'config_invalid'],
  'the profile module does not exist': [{ config: { provider: { id: 'openai', module: '/nonexistent/acoder/profile.mjs' } } }, 'config_invalid'],
  'the profile id differs from the configuration': [{ config: { provider: { id: 'other', module: PROFILE } } }, 'config_invalid'],
};
for (const [name, [options, code]] of Object.entries(refusals)) {
  t(`sidecar-start: ${name}: a fatal event ${code}, exit 70, no socket`, () => withMain(options, async ctx => {
    const exit = await ctx.exit(5000);
    assert.ok(exit !== null, 'the process ends');
    assert.equal(exit.code, 70);
    assert.deepEqual(ctx.events, [{ event: 'fatal', code }]);
    assert.equal(fs.existsSync(ctx.socket), false, 'nothing listens');
    assert.equal(ctx.stderr(), '');
  }));
}

t('sidecar-start: an existing socket path is a fatal listen_failed, exit 70; the existing entry is left as it was', () => withMain({ before: (base, socket) => fs.writeFileSync(socket, 'existing') }, async ctx => {
  const exit = await ctx.exit(5000);
  assert.equal(exit?.code, 70);
  assert.deepEqual(ctx.events, [{ event: 'fatal', code: 'listen_failed' }]);
  assert.equal(fs.readFileSync(ctx.socket, 'utf8'), 'existing');
  assert.equal(ctx.stderr(), '');
}));

// A profile module written at test time whose usage extractor throws an error that names the key.
const throwingProfile = base => {
  const file = path.join(base, 'throwing.mjs');
  fs.writeFileSync(file, [
    `import * as openai from ${JSON.stringify(new URL('../providers/openai.mjs', import.meta.url).href)};`,
    'export const { id, requests, authHeaders } = openai;',
    `export function createUsageExtractor() { throw new Error(\`internal failure \${process.env.${KEY_ENV}}\`); }`,
    '',
  ].join('\n'));
  return { provider: { id: 'openai', module: file } };
};

t('sidecar-start: an internal error while serving prints a fatal event with a code only, nothing on standard error, and exits 70', () => withMain({ config: throwingProfile, scenario: (req, res) => jsonAnswer(res) }, async ctx => {
  assert.ok(await ctx.event('upstream'), `stderr: ${ctx.stderr().slice(0, 300)}`);
  ctx.send(`PHASE agent ${Date.now() + 600000}`);
  assert.ok(await ctx.event('phase'));
  await request(ctx.socket, { body: '{}' });
  const exit = await ctx.exit(5000);
  assert.equal(exit?.code, 70);
  assert.deepEqual(ctx.events.at(-1), { event: 'fatal', code: 'internal_error' });
  assert.equal(ctx.stderr(), '');
  assert.deepEqual(formsIn(ctx.lines.join('\n'), ctx.key), []);
  assert.ok(!ctx.lines.join('\n').includes('internal failure'));
  assert.deepEqual(allValid(ctx.events), []);
}));
