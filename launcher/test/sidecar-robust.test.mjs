import assert from 'node:assert/strict';
import net from 'node:net';
import nodeTest from 'node:test';
import * as proxy from '../container/proxy.mjs';
import { waitFor, withSidecar } from './helpers/sidecar-harness.mjs';
import { raw, rawStatuses, request } from './helpers/socket-client.mjs';
import { ENDPOINT_HOST, jsonAnswer, OPENSSL_MISSING } from './helpers/stub-endpoint.mjs';

// G11: every test has a finite time limit of its own and is registered from this file (the mutation runner counts tests per module);
// a test that needs the stub certificate is skipped with the reason when `openssl` is absent.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout, skip: OPENSSL_MISSING }, fn);

// S3-AC10: slow headers, a body that never finishes, 200 connections and an endpoint that never answers do not stop other requests
// and do not grow without bound (header limit 16 KiB, header and idle limits 60 s, at most 64 client connections).
const SHORT = { headersTimeoutMs: 300, idleTimeoutMs: 400, checkIntervalMs: 50 };
// Opens a raw connection that records when the sidecar closes it; every socket is destroyed by the test's own cleanup.
function opener() {
  const sockets = [];
  return {
    sockets,
    open(socketPath) {
      const socket = net.connect(socketPath);
      const entry = { socket, closed: false, data: '' };
      socket.on('data', chunk => { entry.data += chunk.toString('latin1'); });
      socket.on('close', () => { entry.closed = true; });
      socket.on('error', () => {});
      sockets.push(entry);
      return entry;
    },
    destroyAll() { for (const { socket } of sockets) socket.destroy(); },
  };
}
const withOpener = async fn => { const clients = opener(); try { return await fn(clients); } finally { clients.destroyAll(); } };

t('sidecar-robust: the limits are 16 KiB of headers, 60 s for headers, 60 s idle and 64 client connections', () => withSidecar({}, async ctx => {
  assert.deepEqual([proxy.MAX_HEADER_BYTES, proxy.HEADERS_TIMEOUT_MS, proxy.IDLE_TIMEOUT_MS, proxy.MAX_CONNECTIONS], [16384, 60000, 60000, 64]);
  assert.equal(ctx.sidecar.server.headersTimeout, 60000);
  assert.equal(ctx.sidecar.server.timeout, 60000);
  assert.equal(ctx.sidecar.server.maxConnections, 64);
}));

t('sidecar-robust: headers above 16 KiB are refused by the parser (431) and nothing is forwarded; headers below it are served', () => withSidecar({}, async ctx => {
  const head = size => `POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nX-Pad: ${'p'.repeat(size)}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`;
  assert.deepEqual(rawStatuses(await raw(ctx.socket, head(16500), { waitMs: 3000 })), [431]);
  assert.equal(ctx.stub.requests.length, 0);
  assert.deepEqual(rawStatuses(await raw(ctx.socket, head(15000), { waitMs: 3000 })), [200]);
  assert.equal(ctx.stub.requests.length, 1);
}));

t('sidecar-robust: a client that sends its headers slowly is cut off at the header limit while other requests are served', () => withSidecar({ deps: SHORT }, ctx => withOpener(async clients => {
  const slow = clients.open(ctx.socket);
  slow.socket.write(`POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\n`);
  const trickle = setInterval(() => { if (!slow.closed) slow.socket.write('X-Slow: 1\r\n'); }, 40);
  try {
    assert.equal((await request(ctx.socket, { body: '{}' })).status, 200, 'served while the slow client is still sending headers');
    assert.ok(await waitFor(() => slow.closed, 3000), 'the slow client is cut off although it keeps sending');
  } finally {
    clearInterval(trickle);
  }
  assert.equal(ctx.stub.requests.length, 1);
})));

t('sidecar-robust: a client that never finishes its body is closed at the idle limit while other requests are served', () => withSidecar({ deps: SHORT, limits: { tokens: null } }, ctx => withOpener(async clients => {
  const stalled = clients.open(ctx.socket);
  stalled.socket.write(`POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nContent-Length: 100\r\n\r\n0123456789`);
  assert.equal((await request(ctx.socket, { body: '{}' })).status, 200);
  assert.ok(await waitFor(() => stalled.closed, 3000), 'the stalled connection is closed at the idle limit');
  const events = await ctx.requestEvents(2);
  const stalledEvent = events.find(event => event.bytes_up === 10);
  assert.ok(stalledEvent);
  assert.deepEqual([stalledEvent.decision, stalledEvent.complete], ['forwarded', false]);
  assert.equal((await request(ctx.socket, { body: '{}' })).status, 200);
})));

t('sidecar-robust: 200 connections at once: at most 64 are held, the rest are closed, and after the idle limit a request is served', () => withSidecar({ deps: SHORT }, ctx => withOpener(async clients => {
  let most = 0;
  const sample = setInterval(() => { most = Math.max(most, ctx.sidecar.stats().connections); }, 5);
  try {
    for (let index = 0; index < 200; index += 1) clients.open(ctx.socket);
    assert.ok(await waitFor(() => clients.sockets.filter(entry => entry.closed).length >= 136, 5000), 'the connections above the cap are closed');
    assert.ok(ctx.sidecar.stats().connections <= 64);
    assert.ok(await waitFor(() => clients.sockets.every(entry => entry.closed), 5000), 'the held idle connections are closed at the idle limit');
    assert.equal((await request(ctx.socket, { body: '{}' })).status, 200, 'a request is served although the 200 clients never closed');
  } finally {
    clearInterval(sample);
  }
  assert.ok(most <= 64, `at most 64 connections were held, saw ${most}`);
  assert.ok(most > 0);
}), 30000));

t('sidecar-robust: the cap counts open connections: the 65th is refused while 64 are held', () => withSidecar({}, ctx => withOpener(async clients => {
  for (let index = 0; index < 64; index += 1) clients.open(ctx.socket);
  assert.ok(await waitFor(() => ctx.sidecar.stats().connections === 64, 5000));
  const extra = clients.open(ctx.socket);
  assert.ok(await waitFor(() => extra.closed, 3000), 'the 65th connection is closed');
  assert.equal(clients.sockets.slice(0, 64).filter(entry => entry.closed).length, 0);
  clients.sockets[0].socket.destroy();
  assert.ok(await waitFor(() => ctx.sidecar.stats().connections === 63, 3000));
  assert.equal((await request(ctx.socket, { body: '{}' })).status, 200, 'a freed slot serves a request');
})));

t('sidecar-robust: an endpoint that never answers holds one slot; other requests are served; the idle limit ends it as incomplete', () => {
  const scenario = (req, res, record) => { if (record.bytes === 4) return; jsonAnswer(res); };
  return withSidecar({ scenario, deps: SHORT, limits: { tokens: null } }, async ctx => {
    const started = Date.now();
    const hung = request(ctx.socket, { body: 'hang', timeoutMs: 20000 });
    assert.ok(await waitFor(() => ctx.stub.requests.length === 1, 3000));
    for (let index = 0; index < 3; index += 1) assert.equal((await request(ctx.socket, { body: '{}' })).status, 200);
    const answer = await hung;
    assert.ok(Date.now() - started < 4000, 'the sidecar ended the hung request at its idle limit, not the client at its own time limit');
    assert.ok(answer.status === undefined || answer.error !== undefined, 'the hung request ends without a complete answer');
    const events = await ctx.requestEvents(4);
    const hungEvent = events.find(event => event.bytes_up === 4);
    assert.deepEqual([hungEvent.decision, hungEvent.complete, hungEvent.usage], ['forwarded', false, null]);
    assert.equal(ctx.sidecar.accounting.snapshot().in_flight, 0, 'the slot is released');
    assert.ok(await waitFor(() => ctx.stub.counts.open === 0, 3000), 'the upstream request is closed');
  });
});
