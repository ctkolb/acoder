import assert from 'node:assert/strict';
import net from 'node:net';
import nodeTest from 'node:test';
import { fakeTimers, invalidEvents, waitFor, withSidecar } from './helpers/sidecar-harness.mjs';
import { errorCode, raw, rawStatuses, request, streaming } from './helpers/socket-client.mjs';
import { ENDPOINT_HOST, jsonAnswer, OPENSSL_MISSING, ssePad, sseText } from './helpers/stub-endpoint.mjs';

// G11: every test has a finite time limit of its own and is registered from this file (the mutation runner counts tests per module);
// a test that needs the stub certificate is skipped with the reason when `openssl` is absent.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout, skip: OPENSSL_MISSING }, fn);

// S3-AC5 (dod5-proxy-calls, spec08-silent-direct, spec08-parallel, spec08-inflight) and S3-AC6 (deadline, STOP, end of input, summary).
const kinds = ctx => ctx.ofKind('limit').map(event => event.kind);
const RAW_POST = `POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`;
const held = async (req, res) => {
  res.on('error', () => {});
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(sseText([{ type: 'response.created', response: { model: 'm' } }]) + ssePad());
  await new Promise(resolve => { res.on('close', resolve); setTimeout(resolve, 8000); });
};
// A request beyond the queue is answered 500 (the test then fails on its counts, not on an error in the stub).
const inOrder = queue => (req, res, record) => {
  const next = queue.shift();
  if (next === undefined) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"unexpected request"}'); return undefined; }
  return next(req, res, record);
};

t('dod5-proxy-calls: limit L and L+5 requests one after another: the endpoint counts exactly L, 5 answers are 429 acoder_budget_calls, one limit event', () => withSidecar({ limits: { calls: 3 } }, async ctx => {
  const answers = [];
  for (let index = 0; index < 8; index += 1) answers.push(await request(ctx.socket, { body: '{}' }));
  assert.deepEqual(answers.map(answer => answer.status), [200, 200, 200, 429, 429, 429, 429, 429]);
  assert.deepEqual(answers.slice(3).map(errorCode), Array(5).fill('acoder_budget_calls'));
  assert.equal(ctx.stub.requests.length, 3);
  assert.equal(ctx.recorder.connects.length, 3, 'a refused request opens no upstream connection');
  assert.deepEqual(kinds(ctx), ['calls']);
  assert.deepEqual(invalidEvents(ctx.events), []);
}));

t('spec08-silent-direct: the same with raw requests written to the socket and no other client output', () => withSidecar({ limits: { calls: 3 } }, async ctx => {
  const statuses = [];
  for (let index = 0; index < 8; index += 1) statuses.push(...rawStatuses(await raw(ctx.socket, RAW_POST, { waitMs: 4000 })));
  assert.deepEqual(statuses, [200, 200, 200, 429, 429, 429, 429, 429]);
  assert.equal(ctx.stub.requests.length, 3);
  assert.deepEqual(kinds(ctx), ['calls']);
  const events = await ctx.requestEvents(8);
  assert.deepEqual(events.slice(3).map(event => event.reason), Array(5).fill('acoder_budget_calls'));
}));

t('spec08-parallel: 3 x max_in_flight requests at once against a slow endpoint: never more than max_in_flight open; the rest are 429 acoder_in_flight and no calls', () => {
  const slow = (req, res) => { setTimeout(() => jsonAnswer(res), 400); };
  return withSidecar({ scenario: slow, limits: { max_in_flight: 4 } }, async ctx => {
    const answers = await Promise.all(Array.from({ length: 12 }, () => request(ctx.socket, { body: '{}' })));
    const refused = answers.filter(answer => answer.status === 429);
    assert.equal(ctx.stub.counts.maxOpen <= 4, true, `at most 4 open at the stub, saw ${ctx.stub.counts.maxOpen}`);
    assert.deepEqual([answers.filter(answer => answer.status === 200).length, refused.length], [4, 8]);
    assert.deepEqual(refused.map(errorCode), Array(8).fill('acoder_in_flight'));
    assert.equal(ctx.sidecar.accounting.snapshot().forwarded, 4, 'the refusals are not calls');
    assert.equal(ctx.stub.requests.length, 4);
    assert.deepEqual(kinds(ctx), [], 'acoder_in_flight is no limit and does not latch');
    assert.equal((await request(ctx.socket, { body: '{}' })).status, 200);
  });
});

t('spec08-inflight: a token limit crossed while other requests are in flight: no admission afterwards; STOP aborts them as lower-bound counts; admitted_after_token_limit 0', () => withSidecar({ scenario: inOrder([held, held, (req, res) => jsonAnswer(res)]), limits: { tokens: 18 } }, async ctx => {
  const streams = [streaming(ctx.socket), streaming(ctx.socket)];
  assert.ok(await waitFor(() => streams.every(stream => stream.chunks.length > 0), 4000));
  assert.equal((await request(ctx.socket, { body: '{}' })).status, 200);
  await ctx.requestEvents(1);
  const refused = await request(ctx.socket, { body: '{}' });
  assert.deepEqual([refused.status, errorCode(refused)], [429, 'acoder_budget_tokens']);
  assert.equal(ctx.stub.requests.length, 3, 'nothing is admitted after the crossing');
  ctx.control('STOP');
  const results = await Promise.all(streams.map(stream => stream.done));
  assert.deepEqual(results.map(result => result.complete), [false, false], 'STOP aborts the requests in flight');
  const summary = await waitFor(() => ctx.ofKind('summary')[0], 3000);
  assert.ok(summary);
  const aborted = ctx.ofKind('request').filter(event => event.complete === false);
  assert.equal(aborted.length, 2);
  assert.deepEqual(aborted.map(event => event.usage), [null, null]);
  assert.deepEqual([summary.forwarded, summary.usage_missing, summary.admitted_after_token_limit, summary.tokens?.total, summary.in_flight_at_limit], [3, 2, 0, 18, 2]);
  assert.equal(ctx.sidecar.accounting.snapshot().tokens_lower_bound, true);
  assert.deepEqual(kinds(ctx), ['tokens'], 'no usage_unreported');
  assert.deepEqual(ctx.exits, [0]);
  assert.deepEqual(invalidEvents(ctx.events), []);
}));

t('stop: STOP latches admissions, aborts the requests in flight, prints the summary last and asks for exit 0', () => withSidecar({ scenario: inOrder([held]) }, async ctx => {
  const stream = streaming(ctx.socket);
  assert.ok(await waitFor(() => stream.chunks.length > 0, 4000));
  const started = Date.now();
  ctx.control('STOP');
  const result = await stream.done;
  assert.equal(result.complete, false, 'the request in flight is aborted');
  assert.ok(Date.now() - started < 5000);
  assert.ok(await waitFor(() => ctx.exits.length > 0, 5000), 'the sidecar asks to exit within 5 s');
  assert.deepEqual(ctx.exits, [0]);
  assert.equal(ctx.sidecar.accounting.snapshot().latched, true);
  assert.equal(ctx.events.at(-1)?.event, 'summary', 'the summary is the last event');
  assert.deepEqual(ctx.ofKind('summary').length, 1);
  const [event] = ctx.ofKind('request');
  assert.deepEqual([event.complete, event.usage], [false, null]);
  assert.deepEqual(kinds(ctx), [], 'a stop-caused abort is no usage_unreported');
  assert.deepEqual([ctx.sidecar.accounting.snapshot().usage_missing, ctx.sidecar.accounting.snapshot().tokens_lower_bound], [1, true]);
  assert.deepEqual(invalidEvents(ctx.events), []);
}));

t('stop: a pending limit is printed before the post-latch abort and before the summary; a second STOP prints nothing more', () => withSidecar({ scenario: inOrder([held]), limits: { calls: 1 } }, async ctx => {
  const stream = streaming(ctx.socket);
  assert.ok(await waitFor(() => stream.chunks.length > 0, 4000));
  assert.deepEqual(kinds(ctx), []);
  ctx.control('STOP');
  await stream.done;
  assert.deepEqual(ctx.events.filter(event => event.event !== 'phase').map(event => event.event), ['limit', 'request', 'summary']);
  assert.deepEqual(kinds(ctx), ['calls']);
  const count = ctx.events.length;
  ctx.control('STOP');
  assert.equal(ctx.events.length, count);
  assert.deepEqual(ctx.exits, [0]);
}));

t('stop: D-S1.d a request after STOP gets no answer bytes and no request event, and nothing reaches the endpoint', () => withSidecar({}, async ctx => {
  assert.equal((await request(ctx.socket, { body: '{}' })).status, 200);
  await ctx.requestEvents(1);
  ctx.control('STOP');
  const count = ctx.events.length;
  const text = await raw(ctx.socket, RAW_POST, { waitMs: 1500 });
  assert.equal(text, '', 'the connection is closed without any response bytes');
  assert.equal(ctx.events.length, count, 'no request event and no other event');
  assert.equal(ctx.stub.requests.length, 1);
  assert.equal(ctx.recorder.connects.length, 1);
}));

t('stop: D-S1.d a request after STOP on a connection that was open before it gets no answer bytes and no request event', () => withSidecar({}, async ctx => {
  const KEEP = `POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\nContent-Length: 2\r\n\r\n{}`;
  const socket = net.connect(ctx.socket);
  let text = '';
  socket.on('data', chunk => { text += chunk.toString('latin1'); });
  const closed = new Promise(resolve => { socket.on('close', resolve); socket.on('error', () => {}); });
  try {
    socket.write(KEEP);
    assert.ok(await waitFor(() => rawStatuses(text).length === 1, 4000), 'the first request is answered on the kept-alive connection');
    await ctx.requestEvents(1);
    ctx.control('STOP');
    const count = ctx.events.length;
    const before = text.length;
    socket.write(KEEP);
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2000))]);
    assert.equal(text.length, before, 'no answer bytes after STOP');
    assert.equal(ctx.events.length, count, 'no request event');
    assert.equal(ctx.stub.requests.length, 1);
  } finally {
    socket.destroy();
  }
}));

t('summary: the totals of the run: forwarded, refusals by phase and by reason, bytes, reflections, usage counts and tokens', () => withSidecar({ release: false }, async ctx => {
  const denied = { headers: { host: 'denied.invalid' }, body: '{}' };
  assert.equal((await request(ctx.socket, denied)).status, 403);
  assert.equal((await request(ctx.socket, { path: '/v1/models', body: '{}' })).status, 403);
  assert.equal((await request(ctx.socket, { body: '{}' })).status, 403);
  assert.equal((await request(ctx.socket, { method: 'GET', path: '/__acoder/probe' })).status, 200);
  ctx.sidecar.release(Date.now() + 600000);
  assert.equal((await request(ctx.socket, { body: '{"a":1}' })).status, 200);
  assert.equal((await request(ctx.socket, denied)).status, 403);
  const events = await ctx.requestEvents(6);
  ctx.control('STOP');
  const summary = await waitFor(() => ctx.ofKind('summary')[0], 3000);
  assert.ok(summary);
  const sum = name => events.reduce((total, event) => total + event[name], 0);
  assert.deepEqual(summary, {
    event: 'summary', forwarded: 1, refused_probe: 3, refused_agent: 1,
    refused_by_reason: { acoder_host_not_allowed: 2, acoder_path_not_allowed: 1, acoder_not_released: 1 },
    bytes_up: sum('bytes_up'), bytes_down: sum('bytes_down'), key_reflections: 0, usage_missing: 0, admitted_after_token_limit: 0, in_flight_at_limit: null,
    tokens: { input: 11, output: 7, reasoning: 0, cached_input: 0, total: 18 },
  });
  assert.ok(summary.bytes_up >= 7 && summary.bytes_down > 0);
  assert.deepEqual(invalidEvents(ctx.events), []);
}));

t('deadline: after the deadline every request is refused 429 acoder_budget_wall_clock with one limit event and nothing is forwarded', () => withSidecar({ deadline: Date.now() - 1 }, async ctx => {
  for (let index = 0; index < 3; index += 1) {
    const answer = await request(ctx.socket, { body: '{}' });
    assert.deepEqual([answer.status, errorCode(answer)], [429, 'acoder_budget_wall_clock']);
  }
  assert.equal(ctx.stub.requests.length, 0);
  assert.deepEqual(kinds(ctx), ['wall_clock']);
}));

t('deadline: 30 s after the deadline the sidecar prints the pending wall_clock limit and the summary and asks for exit 0 (injected clock)', () => {
  const timers = fakeTimers();
  let clock = 1_800_000_000_000;
  const deadline = clock + 1000;
  return withSidecar({ deadline, deps: { now: () => clock, setTimer: timers.setTimer } }, async ctx => {
    const pending = timers.timers.filter(timer => !timer.cleared);
    assert.deepEqual(pending.map(timer => timer.ms), [31000], 'one timer for the deadline plus 30 s');
    assert.deepEqual(ctx.exits, []);
    clock = deadline + 30000;
    timers.fire();
    assert.deepEqual(ctx.events.filter(event => event.event !== 'phase').map(event => event.event), ['limit', 'summary']);
    assert.deepEqual(kinds(ctx), ['wall_clock']);
    assert.deepEqual(ctx.exits, [0]);
    const text = await raw(ctx.socket, RAW_POST, { waitMs: 1000 });
    assert.equal(text, '', 'after the exit decision no request is answered');
  });
});

t('deadline: STOP before the deadline clears the deadline timer', () => {
  const timers = fakeTimers();
  return withSidecar({ deps: { setTimer: timers.setTimer } }, async ctx => {
    assert.equal(timers.timers.length, 1);
    ctx.control('STOP');
    assert.equal(timers.timers[0].cleared, true);
    assert.deepEqual(ctx.exits, [0]);
  });
});
