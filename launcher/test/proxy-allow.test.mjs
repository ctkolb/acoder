import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import * as proxy from '../container/proxy.mjs';
import { containerBaseUrl } from '../lib/plan.mjs';
import { RUN_ID, invalidEvents, withSidecar } from './helpers/sidecar-harness.mjs';
import { errorCode, raw, rawStatuses, request } from './helpers/socket-client.mjs';
import { ENDPOINT_HOST, OPENSSL_MISSING } from './helpers/stub-endpoint.mjs';

// G11: every test has a finite time limit of its own and is registered from this file (the mutation runner counts tests per module);
// a test that needs the stub certificate is skipped with the reason when `openssl` is absent.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout, skip: OPENSSL_MISSING }, fn);
const plainTest = (name, fn, timeout = 10000) => nodeTest(name, { timeout }, fn);

const BODY = JSON.stringify({ model: 'm', input: 'hello' });
// The body of the stub's default answer (jsonAnswer).
const STUB_BODY = JSON.stringify({ id: 'resp_stub', model: 'stub-model', usage: { input_tokens: 11, output_tokens: 7 } });
const post = (socket, headers = {}, extra = {}) => request(socket, { headers: { 'content-type': 'application/json', ...headers }, body: BODY, ...extra });

// One forwarded request: the stub received it, the recorder saw one connect to the endpoint host on port 443 with the TLS server name.
const assertForwarded = (ctx, answer, count, label) => {
  assert.equal(answer.status, 200, `${label}: ${JSON.stringify(answer.error ?? answer.body?.toString())}`);
  assert.equal(ctx.stub.requests.length, count, `${label}: the stub received it`);
  assert.equal(ctx.recorder.connects.length, count, `${label}: one upstream connection per forward`);
  assert.deepEqual(ctx.recorder.connects.at(-1), { host: ENDPOINT_HOST, port: 443, servername: ENDPOINT_HOST }, label);
};
// A refusal: the fixed status and code, and nothing reached the stub (its own count) and no upstream connection was made.
const assertRefused = (ctx, answer, status, code, label) => {
  assert.equal(answer.status, status, `${label}: ${JSON.stringify(answer.error ?? answer.body?.toString())}`);
  assert.equal(errorCode(answer), code, label);
  assert.equal(answer.headers['content-type'], 'application/json', label);
  assert.equal(ctx.stub.requests.length, 0, `${label}: not received by the stub`);
  assert.equal(ctx.stub.counts.tcp, 0, `${label}: no connection reached the stub`);
  assert.equal(ctx.recorder.connects.length, 0, `${label}: zero connects`);
};

// S3-AC2 (dod3-proxy-allow).
t('dod3-proxy-allow: the allowed host and both profile paths are forwarded to the endpoint host, port 443, with its TLS server name', () => withSidecar({}, async ctx => {
  let count = 0;
  for (const [path, host] of [['/v1/responses', ENDPOINT_HOST], ['/v1/chat/completions', ENDPOINT_HOST], ['/v1/responses', 'MODELS.Test'], ['/v1/responses', `${ENDPOINT_HOST}:8080`]]) {
    count += 1;
    const answer = await post(ctx.socket, { host }, { path });
    assertForwarded(ctx, answer, count, `${host} ${path}`);
    assert.equal(ctx.stub.requests.at(-1).url, path, 'the target is passed as it is');
    assert.equal(ctx.stub.requests.at(-1).method, 'POST');
    assert.equal(JSON.parse(answer.body.toString()).model, 'stub-model', 'the answer is passed back');
  }
  const events = await ctx.requestEvents(4);
  assert.deepEqual(invalidEvents(ctx.events), []);
  for (const [index, event] of events.entries()) {
    assert.equal(event.seq, index + 1);
    assert.equal(event.decision, 'forwarded');
    assert.equal(event.reason, null);
    assert.equal(event.host, ENDPOINT_HOST);
    assert.equal(event.status, 200);
    assert.equal(event.complete, true);
    assert.equal(event.phase, 'agent');
    assert.equal(event.bytes_up, Buffer.byteLength(BODY), 'bytes_up is the request body sent to the stub');
    assert.equal(event.bytes_down, Buffer.byteLength(STUB_BODY), 'bytes_down is the answer body passed back');
    assert.deepEqual(event.usage, { input: 11, output: 7, reasoning: 0, cached_input: 0 });
    assert.equal(event.response_model, 'stub-model');
    assert.equal(event.probe, null);
  }
  assert.equal(ctx.sidecar.accounting.snapshot().forwarded, 4);
}));

t('dod3-proxy-allow: another host, the allowed name as prefix or suffix, another port and a missing or odd host are refused 403 acoder_host_not_allowed', () => withSidecar({}, async ctx => {
  const hosts = ['other.test', `${ENDPOINT_HOST}.evil`, `evil${ENDPOINT_HOST}`, `x.${ENDPOINT_HOST}`, `${ENDPOINT_HOST}:9999`, `${ENDPOINT_HOST}:443`, `${ENDPOINT_HOST}:`, `${ENDPOINT_HOST}.`, `${ENDPOINT_HOST}:8080:8080`, '127.0.0.1', ''];
  for (const host of hosts) assertRefused(ctx, await post(ctx.socket, { host }), 403, 'acoder_host_not_allowed', JSON.stringify(host));
  const events = await ctx.requestEvents(hosts.length);
  assert.deepEqual(invalidEvents(ctx.events), []);
  for (const event of events) {
    assert.equal(event.decision, 'refused');
    assert.equal(event.reason, 'acoder_host_not_allowed');
    assert.equal(event.host, null, 'the refused host is never in an event');
    assert.equal(event.status, 403);
    assert.equal(event.bytes_up, 0);
    assert.equal(event.bytes_down, 0);
  }
  assert.equal(ctx.sidecar.accounting.snapshot().forwarded, 0, 'a refusal is not a call');
}));

t('dod3-proxy-allow: a path outside the profile, a query string and GET on a POST path are refused 403 acoder_path_not_allowed', () => withSidecar({}, async ctx => {
  const cases = [['POST', '/v1/models'], ['POST', '/v1/responses?stream=true'], ['POST', '/responses'], ['POST', '/v1/files'], ['GET', '/v1/responses'], ['DELETE', '/v1/responses'], ['PUT', '/v1/chat/completions'], ['post', '/v1/responses']];
  for (const [method, path] of cases) {
    const answer = method === 'post' ? rawAnswer(await raw(ctx.socket, `post /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nContent-Length: 0\r\n\r\n`)) : await request(ctx.socket, { method, path, body: method === 'GET' ? null : BODY });
    if (method === 'post') { assert.ok([400, 403].includes(answer.status), `lower-case method: ${answer.status}`); continue; }
    assertRefused(ctx, answer, 403, 'acoder_path_not_allowed', `${method} ${path}`);
  }
  const events = await ctx.requestEvents(cases.length - 1);
  assert.deepEqual(invalidEvents(ctx.events), []);
  for (const event of events.filter(item => item.reason === 'acoder_path_not_allowed')) assert.equal(event.host, ENDPOINT_HOST, 'the matched allowlist entry');
  assert.equal(ctx.stub.requests.length, 0);
}));

// A raw answer text as {status, headers, body} (the first answer only).
function rawAnswer(text) {
  const [head, ...rest] = text.split('\r\n\r\n');
  const status = rawStatuses(text)[0] ?? null;
  const headers = {};
  for (const line of head.split('\r\n').slice(1)) { const at = line.indexOf(':'); if (at > 0) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim(); }
  return { status, headers, body: Buffer.from(rest.join('\r\n\r\n'), 'latin1') };
}

t('dod3-proxy-allow: CONNECT and an Upgrade request are refused 405 and the connection is closed', () => withSidecar({}, async ctx => {
  const texts = {
    connect: `CONNECT ${ENDPOINT_HOST}:443 HTTP/1.1\r\nHost: ${ENDPOINT_HOST}:443\r\n\r\n`,
    upgrade: `POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nContent-Length: 0\r\n\r\n`,
    'upgrade without connection': `POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nUpgrade: h2c\r\nContent-Length: 0\r\n\r\n`,
  };
  for (const [name, text] of Object.entries(texts)) {
    const answer = rawAnswer(await raw(ctx.socket, text, { waitMs: 3000 }));
    assert.equal(answer.status, 405, name);
    assert.equal(JSON.parse(answer.body.toString().split('\r\n')[0]).error.code, 'acoder_method_not_allowed', name);
    assert.equal(answer.headers.connection, 'close', name);
  }
  assert.equal(ctx.stub.requests.length, 0);
  assert.equal(ctx.recorder.connects.length, 0);
  const events = await ctx.requestEvents(3);
  assert.deepEqual(invalidEvents(ctx.events), []);
  assert.deepEqual(events.map(event => event.reason), Array(3).fill('acoder_method_not_allowed'));
}));

t('dod3-proxy-allow: the local probe path is answered by the sidecar, never forwarded or counted', () => withSidecar({ release: false }, async ctx => {
  for (const host of [ENDPOINT_HOST, 'anything.invalid']) {
    const answer = await request(ctx.socket, { method: 'GET', path: '/__acoder/probe', headers: { host } });
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.body.toString()), { run_id: RUN_ID, phase: 'probe' });
  }
  ctx.sidecar.release(Date.now() + 60000);
  const answer = await request(ctx.socket, { method: 'GET', path: '/__acoder/probe' });
  assert.deepEqual(JSON.parse(answer.body.toString()), { run_id: RUN_ID, phase: 'agent' });
  assertRefused(ctx, await request(ctx.socket, { method: 'POST', path: '/__acoder/probe', body: '' }), 403, 'acoder_path_not_allowed', 'POST on the probe path');
  const events = await ctx.requestEvents(4);
  assert.deepEqual(invalidEvents(ctx.events), []);
  assert.deepEqual(events.slice(0, 3).map(event => [event.decision, event.reason, event.status, event.phase]), [['local', null, 200, 'probe'], ['local', null, 200, 'probe'], ['local', null, 200, 'agent']]);
  assert.equal(ctx.sidecar.accounting.snapshot().forwarded, 0);
}));

t('dod3-proxy-allow: in phase probe a forwardable request is refused 403 acoder_not_released after the host and path checks', () => withSidecar({ release: false }, async ctx => {
  const probe = '0123456789abcdef0123456789abcdef';
  assertRefused(ctx, await post(ctx.socket, { 'x-acoder-probe': probe }), 403, 'acoder_not_released', 'forwardable');
  assertRefused(ctx, await post(ctx.socket, { host: 'denied.invalid' }), 403, 'acoder_host_not_allowed', 'host first');
  assertRefused(ctx, await request(ctx.socket, { path: '/v1/models', body: BODY }), 403, 'acoder_path_not_allowed', 'path first');
  const events = await ctx.requestEvents(3);
  assert.deepEqual(invalidEvents(ctx.events), []);
  assert.deepEqual(events.map(event => [event.phase, event.reason]), [['probe', 'acoder_not_released'], ['probe', 'acoder_host_not_allowed'], ['probe', 'acoder_path_not_allowed']]);
  assert.equal(events[0].probe, probe);
  assert.equal(ctx.sidecar.accounting.snapshot().forwarded, 0);
}));

plainTest('dod3-proxy-allow: the relay port accepted in the Host header is the port of the agent base URL', () => {
  assert.equal(String(proxy.RELAY_PORT), new URL(containerBaseUrl('https://models.test/v1')).port);
});

// S3-AC2 (confused-deputy-http): each request is refused before connect with its fixed code, or rejected by Node before the handler;
// the stub's counters stay still.
t('confused-deputy-http: absolute-form targets, duplicate and conflicting Host headers', () => withSidecar({}, async ctx => {
  const cases = [
    [`POST http://${ENDPOINT_HOST}/v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nContent-Length: 0\r\n\r\n`, 403, 'acoder_path_not_allowed'],
    [`POST http://other.test/v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nContent-Length: 0\r\n\r\n`, 403, 'acoder_path_not_allowed'],
    [`POST https://${ENDPOINT_HOST}:443/v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nContent-Length: 0\r\n\r\n`, 403, 'acoder_path_not_allowed'],
    [`POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nHost: ${ENDPOINT_HOST}\r\nContent-Length: 0\r\n\r\n`, 403, 'acoder_host_not_allowed'],
    [`POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nHost: other.test\r\nContent-Length: 0\r\n\r\n`, 403, 'acoder_host_not_allowed'],
    [`POST /v1/responses HTTP/1.1\r\nHost: other.test\r\nhost: ${ENDPOINT_HOST}\r\nContent-Length: 0\r\n\r\n`, 403, 'acoder_host_not_allowed'],
  ];
  for (const [text, status, code] of cases) {
    const answer = rawAnswer(await raw(ctx.socket, text));
    assert.equal(answer.status, status, text);
    assert.equal(JSON.parse(answer.body.toString().split('\r\n')[0]).error.code, code, text);
  }
  assert.equal(ctx.stub.counts.tcp, 0);
  assert.equal(ctx.recorder.connects.length, 0);
}));

t('confused-deputy-http: Content-Length with Transfer-Encoding, HTTP/1.0 and 0.9, Expect: 100-continue, HEAD and OPTIONS', () => withSidecar({}, async ctx => {
  const cases = {
    'content-length with transfer-encoding': [`POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`, [400, null], null],
    'two content-lengths': [`POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nab`, [400, null], null],
    'http/1.0': [`POST /v1/responses HTTP/1.0\r\nHost: ${ENDPOINT_HOST}\r\nContent-Length: 0\r\n\r\n`, [405], 'acoder_method_not_allowed'],
    'http/0.9': ['GET /v1/responses\r\n\r\n', [405, 400, null], 'acoder_method_not_allowed'],
    'expect 100-continue': [`POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nContent-Length: 2\r\nExpect: 100-continue\r\n\r\n`, [405], 'acoder_method_not_allowed'],
    'expect other': [`POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nContent-Length: 2\r\nExpect: something\r\n\r\nab`, [417, 405], null],
    head: [`HEAD /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\n\r\n`, [403], null],
    options: [`OPTIONS /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\n\r\n`, [403], 'acoder_path_not_allowed'],
    'options asterisk': [`OPTIONS * HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\n\r\n`, [403], 'acoder_path_not_allowed'],
  };
  for (const [name, [text, statuses, code]] of Object.entries(cases)) {
    const answer = rawAnswer(await raw(ctx.socket, text));
    assert.ok(statuses.includes(answer.status), `${name}: status ${answer.status}`);
    if (code !== null && answer.status !== null && answer.status !== 400) assert.equal(JSON.parse(answer.body.toString().split('\r\n')[0]).error.code, code, name);
  }
  assert.equal(ctx.stub.counts.tcp, 0, 'nothing reached the stub');
  assert.equal(ctx.recorder.connects.length, 0);
  assert.deepEqual(invalidEvents(ctx.events), []);
  assert.equal(ctx.sidecar.accounting.snapshot().forwarded, 0);
}));

t('confused-deputy-http: pipelining an allowed request and one for a denied host forwards only the first', () => withSidecar({}, async ctx => {
  const text = `POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nContent-Length: ${BODY.length}\r\n\r\n${BODY}`
    + `POST /v1/responses HTTP/1.1\r\nHost: other.test\r\nContent-Length: ${BODY.length}\r\n\r\n${BODY}`;
  const answers = rawStatuses(await raw(ctx.socket, text, { waitMs: 4000 }));
  assert.deepEqual(answers, [200, 403]);
  assert.equal(ctx.stub.requests.length, 1);
  assert.equal(ctx.recorder.connects.length, 1);
  const events = await ctx.requestEvents(2);
  assert.deepEqual(events.sort((a, b) => a.seq - b.seq).map(event => event.decision), ['forwarded', 'refused']);
}));

t('confused-deputy-http: //, /./, /.., percent-encoded letters, a trailing slash and an empty query are refused acoder_path_not_allowed', () => withSidecar({}, async ctx => {
  const paths = ['//v1/responses', '/v1//responses', '/v1/./responses', '/v1/x/../responses', '/v1/../v1/responses', '/v1/respon%73es', '/v1/%72esponses', '/v1/responses/', '/v1/responses?', '/v1/responses#x', '/v1/responses%00', '/V1/responses', '/v1/chat/completions/'];
  for (const path of paths) assertRefused(ctx, await request(ctx.socket, { path, body: BODY }), 403, 'acoder_path_not_allowed', path);
  await ctx.requestEvents(paths.length);
  assert.deepEqual(invalidEvents(ctx.events), []);
}));

// The order of A3.2: a request that fails several steps is refused by the first one.
t('dod3-proxy-allow: the steps are evaluated in the order of A3.2 (method before host, host before path, path and size before admission)', () => withSidecar({ limits: { calls: 1 } }, async ctx => {
  const first = await post(ctx.socket);
  assert.equal(first.status, 200, 'the one call');
  const cases = [
    [`POST /v1/models HTTP/1.0\r\nHost: other.test\r\nContent-Length: 0\r\n\r\n`, 405, 'acoder_method_not_allowed'],
    [`POST /v1/models HTTP/1.1\r\nHost: other.test\r\nContent-Length: 0\r\n\r\n`, 403, 'acoder_host_not_allowed'],
    [`POST /v1/models HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nContent-Length: 0\r\n\r\n`, 403, 'acoder_path_not_allowed'],
    [`POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nContent-Length: ${32 * 1024 * 1024 + 1}\r\n\r\n`, 413, 'acoder_body_too_large'],
    [`POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nContent-Length: 0\r\n\r\n`, 429, 'acoder_budget_calls'],
  ];
  for (const [text, status, code] of cases) {
    const answer = rawAnswer(await raw(ctx.socket, text));
    assert.equal(answer.status, status, text);
    assert.equal(JSON.parse(answer.body.toString().split('\r\n')[0]).error.code, code, text);
  }
  const events = (await ctx.requestEvents(6)).sort((a, b) => a.seq - b.seq);
  assert.deepEqual(events.map(event => event.host), [ENDPOINT_HOST, null, null, ENDPOINT_HOST, ENDPOINT_HOST, ENDPOINT_HOST]);
  assert.equal(ctx.stub.requests.length, 1);
}));

t('dod3-proxy-allow: a finished request leaves the in-flight count; the call limit refuses with 429 and one limit event', () => withSidecar({ limits: { calls: 3, max_in_flight: 1 } }, async ctx => {
  for (let n = 1; n <= 3; n += 1) assert.equal((await post(ctx.socket)).status, 200, `request ${n} after the previous one finished`);
  for (let n = 0; n < 2; n += 1) {
    const answer = await post(ctx.socket);
    assert.equal(answer.status, 429);
    assert.equal(errorCode(answer), 'acoder_budget_calls');
  }
  await ctx.requestEvents(5);
  assert.deepEqual(ctx.events.filter(event => event.event === 'limit'), [{ event: 'limit', kind: 'calls' }]);
  assert.ok(ctx.events.findIndex(event => event.event === 'limit') < ctx.events.findIndex(event => event.reason === 'acoder_budget_calls'), 'the limit event comes with the first refusal for it');
  assert.equal(ctx.stub.requests.length, 3);
  assert.equal(ctx.sidecar.accounting.snapshot().in_flight, 0);
  assert.deepEqual(invalidEvents(ctx.events), []);
}));
