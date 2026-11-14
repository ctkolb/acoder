import assert from 'node:assert/strict';
import net from 'node:net';
import nodeTest from 'node:test';
import { invalidEvents, waitFor, withSidecar } from './helpers/sidecar-harness.mjs';
import { errorCode, request } from './helpers/socket-client.mjs';
import { ENDPOINT_HOST, OPENSSL_MISSING } from './helpers/stub-endpoint.mjs';

// G11: every test has a finite time limit of its own and is registered from this file (the mutation runner counts tests per module);
// a test that needs the stub certificate is skipped with the reason when `openssl` is absent.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout, skip: OPENSSL_MISSING }, fn);

// S3-AC7 (spec14-phase): the phase is the sidecar's own state; only the first PHASE line changes it, once.
const PROBE = '0123456789abcdef0123456789abcdef';
const deadline = () => Date.now() + 600000;
const post = (ctx, headers = {}, path = '/v1/responses') => request(ctx.socket, { path, headers, body: '{}' });
const refusal = answer => [answer.status, errorCode(answer)];

t('spec14-phase: in phase probe the host and path refusals keep their codes; a forwardable request is acoder_not_released; the stub receives nothing', () => withSidecar({ release: false }, async ctx => {
  assert.deepEqual(refusal(await post(ctx, { host: 'denied.invalid', 'x-acoder-probe': PROBE })), [403, 'acoder_host_not_allowed']);
  assert.deepEqual(refusal(await post(ctx, { 'x-acoder-probe': PROBE }, '/v1/models')), [403, 'acoder_path_not_allowed']);
  assert.deepEqual(refusal(await post(ctx, { 'x-acoder-probe': PROBE })), [403, 'acoder_not_released']);
  const events = await ctx.requestEvents(3);
  assert.deepEqual(events.map(event => [event.phase, event.decision, event.reason, event.probe]), [
    ['probe', 'refused', 'acoder_host_not_allowed', PROBE], ['probe', 'refused', 'acoder_path_not_allowed', PROBE], ['probe', 'refused', 'acoder_not_released', PROBE],
  ]);
  assert.equal(ctx.stub.requests.length, 0);
  assert.equal(ctx.recorder.connects.length, 0);
  assert.deepEqual(invalidEvents(ctx.events), []);
}));

t('spec14-phase: the probe header is echoed only when it is 32 lower-case hex characters', () => withSidecar({ release: false }, async ctx => {
  const values = [PROBE, PROBE.slice(1), `${PROBE}0`, PROBE.toUpperCase(), `${PROBE.slice(1)}g`, ''];
  for (const value of values) await post(ctx, { 'x-acoder-probe': value });
  const events = await ctx.requestEvents(values.length);
  assert.deepEqual(events.map(event => event.probe), [PROBE, null, null, null, null, null]);
}));

t('spec14-phase: no header changes the phase; a request that claims phase agent in phase probe is still not released', () => withSidecar({ release: false }, async ctx => {
  assert.deepEqual(refusal(await post(ctx, { 'x-acoder-phase': 'agent', 'x-acoder-release': '1', phase: 'agent' })), [403, 'acoder_not_released']);
  assert.equal(ctx.sidecar.phase(), 'probe');
  assert.equal(ctx.stub.requests.length, 0);
  const [event] = await ctx.requestEvents(1);
  assert.equal(event.phase, 'probe');
}));

t('spec14-phase: after PHASE agent a refused or forwarded request carries phase agent and probe null even with the probe header', () => withSidecar({ release: false }, async ctx => {
  ctx.control(`PHASE agent ${deadline()}`);
  assert.deepEqual(refusal(await post(ctx, { host: 'denied.invalid', 'x-acoder-probe': PROBE })), [403, 'acoder_host_not_allowed']);
  assert.equal((await post(ctx, { 'x-acoder-probe': PROBE, 'x-acoder-phase': 'probe' })).status, 200);
  const events = await ctx.requestEvents(2);
  assert.deepEqual(events.map(event => [event.phase, event.probe, event.decision]), [['agent', null, 'refused'], ['agent', null, 'forwarded']]);
  assert.deepEqual(invalidEvents(ctx.events), []);
}));

for (const [name, first, second] of [
  ['a second valid PHASE', `PHASE agent ${Date.now() + 600000}`, `PHASE agent ${Date.now() + 900000}`],
  ['a malformed second PHASE', `PHASE agent ${Date.now() + 600000}`, 'PHASE agent x'],
  ['a valid PHASE after a rejected one', 'PHASE agent -1', `PHASE agent ${Date.now() + 600000}`],
  ['a PHASE probe line after the release', `PHASE agent ${Date.now() + 600000}`, `PHASE probe ${Date.now()}`],
]) {
  t(`spec14-phase: ${name} is a fatal event (code only) and exit 70; the phase does not change again`, () => withSidecar({ release: false }, async ctx => {
    ctx.control(first);
    const phase = ctx.sidecar.phase();
    ctx.control(second);
    assert.deepEqual(ctx.ofKind('fatal'), [{ event: 'fatal', code: 'internal_error' }]);
    assert.deepEqual(ctx.exits, [70]);
    assert.equal(ctx.sidecar.phase(), phase);
    assert.ok(ctx.ofKind('phase').length <= 1);
    const answer = await post(ctx);
    assert.equal(answer.status, undefined, 'nothing is answered after the fatal event');
    assert.equal(ctx.stub.requests.length, 0);
    assert.equal(ctx.events.at(-1).event, 'fatal', 'no event after the fatal event');
    assert.deepEqual(invalidEvents(ctx.events), []);
  }));
}

t('spec14-phase: every client connection open at the switch is destroyed before the phase event', () => {
  const atPhase = [];
  const onEvent = (event, sidecar) => { if (event.event === 'phase') atPhase.push(sidecar.stats().connections); };
  return withSidecar({ release: false, onEvent }, async ctx => {
    // An idle keep-alive connection that already had an answer, and one whose request headers are not complete.
    const idle = net.connect(ctx.socket);
    const partial = net.connect(ctx.socket);
    const closed = [idle, partial].map(socket => new Promise(resolve => { socket.on('close', () => resolve(true)); socket.on('error', () => {}); }));
    let answered = '';
    idle.on('data', chunk => { answered += chunk.toString('latin1'); });
    idle.write(`GET /__acoder/probe HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\n\r\n`);
    partial.write(`POST /v1/responses HTTP/1.1\r\nHost: ${ENDPOINT_HOST}\r\n`);
    assert.ok(await waitFor(() => answered.includes('200 OK') && ctx.sidecar.stats().connections === 2, 4000), 'both connections are open');
    ctx.control(`PHASE agent ${deadline()}`);
    assert.deepEqual(atPhase, [0], 'no client connection is open when the phase event is printed');
    const results = await Promise.race([Promise.all(closed), new Promise(resolve => setTimeout(() => resolve('timeout'), 3000))]);
    assert.deepEqual(results, [true, true], 'both client connections were closed by the sidecar');
    assert.equal((await post(ctx)).status, 200, 'a new connection after the switch is served in phase agent');
    const events = ctx.ofKind('request');
    assert.deepEqual(events.map(event => event.phase), ['probe', 'agent']);
  });
});
