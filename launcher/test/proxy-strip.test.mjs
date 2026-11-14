import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import * as proxy from '../container/proxy.mjs';
import { PLACEHOLDER_KEY } from '../lib/plan.mjs';
import { parseJson } from './helpers/fixtures.mjs';
import { expectedForms } from './helpers/key-forms.mjs';
import { invalidEvents, withSidecar } from './helpers/sidecar-harness.mjs';
import { errorCode, raw, rawStatuses, request } from './helpers/socket-client.mjs';
import { ENDPOINT_HOST, jsonAnswer, OPENSSL_MISSING } from './helpers/stub-endpoint.mjs';

// G11: every test has a finite time limit of its own and is registered from this file (the mutation runner counts tests per module);
// a test that needs the stub certificate is skipped with the reason when `openssl` is absent.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout, skip: OPENSSL_MISSING }, fn);

const BODY = JSON.stringify({ model: 'm', input: 'hello' });
const REMOVED = ['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'cookie', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'x-hop'];

// S3-AC3 (dod8-proxy-strip): the stub's recorded headers.
t('dod8-proxy-strip: client credential and hop-by-hop headers are removed; the profile header with the key is added only upstream', () => withSidecar({}, async ctx => {
  const text = `POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nAUTHORIZATION: Bearer ${PLACEHOLDER_KEY}\r\nauthorization: Bearer client-sent\r\nApi-Key: ${PLACEHOLDER_KEY}\r\n`
    + `X-API-KEY: client-sent\r\nProxy-Authorization: Basic Y2xpZW50OnNlbnQ=\r\nCookie: session=client-sent\r\nAccept-Encoding: gzip, br\r\nConnection: keep-alive, X-Hop\r\nX-Hop: 1\r\n`
    + `Keep-Alive: timeout=5\r\nProxy-Connection: keep-alive\r\nTE: trailers\r\nTrailer: X-Later\r\nX-Custom: kept\r\nContent-Type: application/json\r\nContent-Length: ${BODY.length}\r\n\r\n${BODY}`;
  const answerText = await raw(ctx.socket, text, { waitMs: 4000 });
  assert.deepEqual(rawStatuses(answerText), [200], answerText.slice(0, 200));
  assert.equal(ctx.stub.requests.length, 1);
  const pairs = ctx.stub.headerPairs(ctx.stub.requests[0]);
  const named = name => pairs.filter(([header]) => header === name).map(([, value]) => value);
  assert.deepEqual(named('authorization'), [`Bearer ${ctx.key}`], 'exactly the profile header with the key');
  for (const name of REMOVED.filter(item => item !== 'authorization')) assert.deepEqual(named(name), [], `${name} is removed`);
  assert.deepEqual(named('connection'), ['close'], 'the client Connection header is removed; the upstream client sets its own');
  assert.deepEqual(named('accept-encoding'), ['identity']);
  assert.deepEqual(named('host'), [ENDPOINT_HOST]);
  assert.deepEqual(named('x-custom'), ['kept'], 'other headers pass');
  assert.deepEqual(named('content-type'), ['application/json']);
  assert.equal(ctx.stub.requests[0]?.bytes, BODY.length, 'the body is passed whole');
  const all = JSON.stringify(pairs);
  assert.ok(!all.includes(PLACEHOLDER_KEY), 'the placeholder never reaches the endpoint');
  assert.ok(!all.includes('client-sent'), 'no client credential reaches the endpoint');
  assert.ok(!answerText.includes(ctx.key), 'the key is not sent back to the client');
  await ctx.requestEvents(1);
  assert.ok(!JSON.stringify(ctx.events).includes(ctx.key), 'no event holds the key');
  assert.deepEqual(invalidEvents(ctx.events), []);
}));

t('dod8-proxy-strip: hop-by-hop request headers are removed (without a Trailer header, which the upstream client would refuse)', () => withSidecar({}, async ctx => {
  const text = `POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nKeep-Alive: timeout=5\r\nProxy-Connection: keep-alive\r\nTE: trailers\r\nContent-Length: ${BODY.length}\r\n\r\n${BODY}`;
  assert.deepEqual(rawStatuses(await raw(ctx.socket, text, { waitMs: 4000 })), [200]);
  const names = ctx.stub.headerPairs(ctx.stub.requests[0]).map(([name]) => name);
  for (const name of ['keep-alive', 'proxy-connection', 'te']) assert.ok(!names.includes(name), `${name} is removed`);
}));

t('dod8-proxy-strip: a chunked request body is streamed upstream without its transfer-encoding header', () => withSidecar({}, async ctx => {
  const text = `POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n`;
  assert.deepEqual(rawStatuses(await raw(ctx.socket, text, { waitMs: 4000 })), [200]);
  assert.equal(ctx.stub.requests[0]?.bytes, 11);
  const events = await ctx.requestEvents(1);
  assert.equal(events[0].bytes_up, 11);
}));

t('dod8-proxy-strip: several Set-Cookie and a Location holding the key are redacted; a 3xx is passed back and not followed', () => {
  let key;
  const scenario = (req, res) => {
    const forms = expectedForms(key);
    res.writeHead(302, [
      'Location', `https://${ENDPOINT_HOST}/next?k=${key}`, 'Set-Cookie', `a=${key}; Path=/`, 'Set-Cookie', `b=${forms['base64-1']}; Path=/`, 'Set-Cookie', 'c=plain',
      `X-${key}`, 'name-with-key', 'X-Hex', forms['hex-upper'], 'Content-Length', '0',
    ]);
    res.end();
  };
  return withSidecar({ scenario }, async ctx => {
    key = ctx.key;
    const answer = await request(ctx.socket, { body: BODY });
    assert.equal(answer.status, 302);
    assert.equal(ctx.stub.requests.length, 1, 'the redirect is not followed');
    assert.equal(answer.headers.location, `https://${ENDPOINT_HOST}/next?k=[REDACTED]`);
    assert.deepEqual(answer.headers['set-cookie'], ['a=[REDACTED]; Path=/', 'b=[REDACTED]; Path=/', 'c=plain']);
    assert.equal(answer.headers['x-hex'], '[REDACTED]');
    const head = JSON.stringify(answer.rawHeaders);
    for (const [name, form] of Object.entries(expectedForms(ctx.key))) assert.ok(!head.includes(form), `no ${name} form of the key in the answer headers`);
    assert.ok(!Object.values(answer.headers).includes('name-with-key'), 'a header named with the key is dropped');
    assert.equal(ctx.sidecar.stats().key_reflections, 5, 'each replacement and the dropped header are counted');
    const events = await ctx.requestEvents(1);
    assert.equal(events[0].status, 302);
    assert.equal(events[0].complete, true);
    assert.equal(events[0].usage, null);
    assert.deepEqual(invalidEvents(ctx.events), []);
  });
});

t('dod8-proxy-strip: every key form of A8.6 in a response header value is redacted', () => {
  let key;
  const scenario = (req, res) => {
    const pairs = Object.entries(expectedForms(key)).flatMap(([name, form]) => [`X-Form-${name}`, `<${form}>`]);
    res.writeHead(200, [...pairs, 'Content-Length', '0']);
    res.end();
  };
  return withSidecar({ scenario }, async ctx => {
    key = ctx.key;
    const answer = await request(ctx.socket, { body: BODY });
    for (const name of Object.keys(expectedForms(ctx.key))) assert.equal(answer.headers[`x-form-${name}`], '<[REDACTED]>', name);
  });
});

t('dod8-proxy-strip: hop-by-hop response headers are removed; other headers and the status pass back', () => {
  const scenario = (req, res) => {
    const body = JSON.stringify({ model: 'x', usage: { input_tokens: 1, output_tokens: 1 } });
    res.writeHead(201, ['Content-Type', 'application/json', 'Connection', 'X-Up-Hop', 'X-Up-Hop', '1', 'Keep-Alive', 'timeout=9', 'X-Request-Id', 'r1', 'Content-Length', String(body.length)]);
    res.end(body);
  };
  return withSidecar({ scenario }, async ctx => {
    const answer = await request(ctx.socket, { body: BODY });
    assert.equal(answer.status, 201);
    assert.equal(answer.headers['x-request-id'], 'r1');
    assert.equal(answer.headers['x-up-hop'], undefined);
    assert.notEqual(answer.headers['keep-alive'], 'timeout=9');
  });
});

t('dod8-proxy-strip: an untrusted certificate gives 502 acoder_upstream_tls and the stub receives no request', () => withSidecar({ cert: 'self' }, async ctx => {
  const answer = await request(ctx.socket, { body: BODY });
  assert.equal(answer.status, 502);
  assert.equal(errorCode(answer), 'acoder_upstream_tls');
  assert.equal(ctx.stub.requests.length, 0);
  assert.equal(ctx.stub.counts.tls, 0, 'no TLS session was established');
  assert.deepEqual(ctx.recorder.connects, [{ host: ENDPOINT_HOST, port: 443, servername: ENDPOINT_HOST }]);
  const events = await ctx.requestEvents(1);
  assert.deepEqual([events[0].decision, events[0].status, events[0].complete], ['forwarded', 502, false]);
  assert.deepEqual(invalidEvents(ctx.events), []);
}));

t('dod8-proxy-strip: a certificate for another name gives 502 acoder_upstream_tls and the stub receives no request', () => withSidecar({ cert: 'other' }, async ctx => {
  const answer = await request(ctx.socket, { body: BODY });
  assert.equal(answer.status, 502);
  assert.equal(errorCode(answer), 'acoder_upstream_tls');
  assert.equal(ctx.stub.requests.length, 0);
}));

t('dod8-proxy-strip: an answer with a content encoding gives 502 acoder_upstream_encoding and its body is not passed back', () => {
  const scenario = (req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': 11 }); res.end('secret-body'); };
  return withSidecar({ scenario }, async ctx => {
    const answer = await request(ctx.socket, { body: BODY });
    assert.equal(answer.status, 502);
    assert.equal(errorCode(answer), 'acoder_upstream_encoding');
    assert.ok(!answer.body.toString().includes('secret-body'));
    assert.equal(answer.headers['content-encoding'], undefined);
    const events = await ctx.requestEvents(1);
    assert.deepEqual([events[0].decision, events[0].status, events[0].complete, events[0].bytes_down], ['forwarded', 502, false, 0]);
  });
});

t('dod8-proxy-strip: content-encoding identity is passed back', () => {
  const scenario = (req, res) => jsonAnswer(res, { headers: { 'content-encoding': 'Identity' } });
  return withSidecar({ scenario }, async ctx => {
    const answer = await request(ctx.socket, { body: BODY });
    assert.equal(answer.status, 200);
    assert.equal(parseJson(answer.body.toString())?.model, 'stub-model');
  });
});

t('dod8-proxy-strip: a declared body above 32 MiB is refused 413 before any connect', () => withSidecar({}, async ctx => {
  const text = `POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nContent-Length: ${proxy.MAX_BODY + 1}\r\n\r\nabc`;
  const answerText = await raw(ctx.socket, text);
  assert.deepEqual(rawStatuses(answerText), [413]);
  assert.match(answerText, /"acoder_body_too_large"/);
  assert.equal(ctx.recorder.connects.length, 0);
  const events = await ctx.requestEvents(1);
  assert.deepEqual([events[0].decision, events[0].reason, events[0].status], ['refused', 'acoder_body_too_large', 413]);
  assert.equal(ctx.sidecar.accounting.snapshot().forwarded, 0);
}));

t('dod8-proxy-strip: a declared body of exactly 32 MiB is forwarded whole', () => withSidecar({}, async ctx => {
  const answer = await request(ctx.socket, { body: Buffer.alloc(proxy.MAX_BODY, 0x61), timeoutMs: 20000 });
  assert.equal(answer.status, 200);
  assert.equal(ctx.stub.requests[0]?.bytes, proxy.MAX_BODY);
}), 40000);

t('dod8-proxy-strip: a streamed body that grows above 32 MiB is cut off with 413 and never sent whole', () => withSidecar({}, async ctx => {
  const head = `POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nTransfer-Encoding: chunked\r\n\r\n`;
  const chunk = Buffer.alloc(1024 * 1024, 0x62);
  const frame = Buffer.concat([Buffer.from(`${chunk.length.toString(16)}\r\n`), chunk, Buffer.from('\r\n')]);
  const body = Buffer.concat([Buffer.from(head), ...Array(33).fill(frame), Buffer.from('1\r\nx\r\n0\r\n\r\n')]);
  const answerText = await raw(ctx.socket, body, { waitMs: 15000 });
  const events = await ctx.requestEvents(1, 15000);
  assert.deepEqual([events[0].decision, events[0].status, events[0].complete], ['forwarded', 413, false]);
  assert.ok(events[0].bytes_up <= proxy.MAX_BODY, 'no byte above the limit was sent');
  if (answerText !== '') assert.deepEqual(rawStatuses(answerText), [413]);
  assert.ok((ctx.stub.requests[0]?.bytes ?? 0) <= proxy.MAX_BODY, 'the stub never received more than the limit');
}), 40000);
