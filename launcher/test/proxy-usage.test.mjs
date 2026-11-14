import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import * as openai from '../providers/openai.mjs';
import { invalidEvents, waitFor, withSidecar } from './helpers/sidecar-harness.mjs';
import { errorCode, request, streaming } from './helpers/socket-client.mjs';
import { gate, jsonAnswer, OPENSSL_MISSING, ssePad, sseText } from './helpers/stub-endpoint.mjs';

// G11: every test has a finite time limit of its own and is registered from this file (the mutation runner counts tests per module);
// a test that needs the stub certificate is skipped with the reason when `openssl` is absent.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout, skip: OPENSSL_MISSING }, fn);

// S3-AC4 (spec08-usage, spec08-abort, response-model).
const FULL_USAGE = { input_tokens: 100, output_tokens: 40, input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 25 } };
const streamHead = res => { res.on('error', () => {}); res.writeHead(200, { 'content-type': 'text/event-stream' }); };
const streamAnswer = (res, events) => { streamHead(res); res.end(sseText(events)); };
const created = (model = 'stub-model') => ({ type: 'response.created', response: { model } });
const completed = (usage = { input_tokens: 11, output_tokens: 7 }, model = 'stub-model') => ({ type: 'response.completed', response: { model, usage } });
// The stub answers the requests in arrival order with the scenarios of `queue`.
const inOrder = queue => (req, res, record) => queue.shift()(req, res, record);
const keyOf = req => String(req.headers.authorization).slice('Bearer '.length);
const kinds = ctx => ctx.ofKind('limit').map(event => event.kind);
const indexOf = (ctx, predicate) => ctx.events.findIndex(predicate);
async function stopForSummary(ctx) {
  ctx.control('STOP');
  const summary = await waitFor(() => ctx.ofKind('summary').at(-1), 3000);
  assert.ok(summary, 'STOP prints a summary event');
  return summary;
}
const usage4 = (input, output, reasoning = 0, cached = 0) => ({ input, output, reasoning, cached_input: cached });

t('spec08-usage: an event-stream answer reaches the client chunk by chunk: the first chunk arrives before the stub sends the last', () => {
  const last = gate();
  const sentLast = [];
  const scenario = async (req, res) => {
    streamHead(res);
    res.write(sseText([created()]) + ssePad());
    sentLast.push(await last.wait(5000));
    res.end(sseText([completed({ input_tokens: 3, output_tokens: 2 })]));
  };
  return withSidecar({ scenario }, async ctx => {
    const client = streaming(ctx.socket);
    const first = await waitFor(() => client.chunks.length > 0, 4000);
    const before = client.text();
    last.open();
    const result = await client.done;
    assert.ok(first, 'a chunk reached the client while the stub still held back the last one');
    assert.ok(before.includes('response.created') && !before.includes('response.completed'));
    assert.deepEqual(sentLast, [true], 'the stub sent the last chunk only after the client had the first');
    assert.equal(result.complete, true);
    assert.ok(client.text().includes('response.completed'));
    const [event] = await ctx.requestEvents(1);
    assert.equal(event.complete, true);
    assert.deepEqual(event.usage, usage4(3, 2));
  });
});

t('spec08-usage: usage is read from JSON and event-stream answers; the totals count cached input within input and reasoning within output (cached)', () => {
  const scenario = inOrder([
    (req, res) => jsonAnswer(res, { usage: FULL_USAGE }),
    (req, res) => streamAnswer(res, [created(), completed({ input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } })]),
    (req, res) => streamAnswer(res, [{ model: 'chat', choices: [] }, { model: 'chat', choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 2 } } }, '[DONE]']),
  ]);
  return withSidecar({ scenario }, async ctx => {
    for (const path of ['/v1/responses', '/v1/responses', '/v1/chat/completions']) assert.equal((await request(ctx.socket, { path, body: '{}' })).status, 200);
    const events = await ctx.requestEvents(3);
    assert.deepEqual(events.map(event => event.usage), [usage4(100, 40, 25, 30), usage4(10, 5, 0, 4), usage4(7, 3, 2, 0)]);
    const summary = await stopForSummary(ctx);
    assert.deepEqual(summary.tokens, { input: 117, output: 48, reasoning: 27, cached_input: 34, total: 165 }, 'total = input + output; reasoning and cached are recorded separately');
    assert.equal(summary.usage_missing, 0);
    assert.equal(summary.forwarded, 3);
    assert.deepEqual(kinds(ctx), []);
    assert.deepEqual(invalidEvents(ctx.events), []);
  });
});

t('spec08-usage: absent, malformed and oversized usage give usage null and never an exception; with tokens null they count only as missing usage', () => {
  const big = { id: 'x', model: 'm', pad: 'p'.repeat(9 * 1024 * 1024), usage: { input_tokens: 1, output_tokens: 1 } };
  const scenario = inOrder([
    (req, res) => jsonAnswer(res, { usage: null }),
    (req, res) => jsonAnswer(res, { usage: { input_tokens: 'x', output_tokens: 1 } }),
    (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"usage": {"input_tokens": 1,'); },
    (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(big)); },
    (req, res) => streamAnswer(res, ['{broken', completed()]),
    (req, res) => streamAnswer(res, [{ type: 'filler', pad: 'p'.repeat(1024 * 1024 + 10) }, completed()]),
    (req, res) => jsonAnswer(res),
  ]);
  return withSidecar({ scenario, limits: { tokens: null } }, async ctx => {
    for (let index = 0; index < 6; index += 1) assert.equal((await request(ctx.socket, { body: '{}', timeoutMs: 20000 })).status, 200, `answer ${index}`);
    const events = await ctx.requestEvents(6);
    assert.deepEqual(events.map(event => [event.usage, event.complete]), Array(6).fill([null, true]));
    assert.equal((await request(ctx.socket, { body: '{}' })).status, 200, 'the sidecar still serves');
    assert.deepEqual((await ctx.requestEvents(7))[6].usage, usage4(11, 7));
    assert.deepEqual(ctx.ofKind('fatal'), []);
    const summary = await stopForSummary(ctx);
    assert.equal(summary.usage_missing, 6);
    assert.equal(summary.tokens.total, 18);
    assert.equal(ctx.sidecar.accounting.snapshot().tokens_lower_bound, true);
    assert.deepEqual(kinds(ctx), [], 'tokens null: no usage_unreported');
    assert.deepEqual(ctx.exits, [0]);
    assert.deepEqual(invalidEvents(ctx.events), []);
  });
}, 60000);

t('spec08-usage: with a token limit, a completed 2xx answer without usage while admissions are open latches usage_unreported and refuses the next request', () => {
  const scenario = inOrder([(req, res) => jsonAnswer(res, { usage: null })]);
  return withSidecar({ scenario }, async ctx => {
    assert.equal((await request(ctx.socket, { body: '{}' })).status, 200);
    await ctx.requestEvents(1);
    assert.equal(ctx.sidecar.accounting.snapshot().reason, 'usage_unreported', 'latched at once; the limit event waits for the first refusal (A6.5)');
    const refused = await request(ctx.socket, { body: '{}' });
    assert.deepEqual([refused.status, errorCode(refused)], [429, 'acoder_usage_unreported']);
    assert.equal(ctx.stub.requests.length, 1);
    assert.deepEqual(kinds(ctx), ['usage_unreported'], 'one limit event');
  });
});

t('spec08-abort: a client closes after the first chunk while final usage is withheld: incomplete, usage_unreported, and no later request is forwarded', () => {
  const late = [];
  const scenario = inOrder([async (req, res) => {
    streamHead(res);
    res.write(sseText([created()]) + ssePad());
    const closed = new Promise(resolve => res.on('close', resolve));
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 5000))]);
    late.push(res.destroyed);
    try { res.end(sseText([completed()])); } catch { /* the endpoint emits usage after the client is gone */ }
  }]);
  return withSidecar({ scenario }, async ctx => {
    const client = streaming(ctx.socket);
    assert.ok(await waitFor(() => client.chunks.length > 0, 4000));
    client.abort();
    const [event] = await ctx.requestEvents(1);
    assert.deepEqual([event.decision, event.complete, event.usage, event.status], ['forwarded', false, null, 200]);
    assert.deepEqual(kinds(ctx), ['usage_unreported'], 'the limit event is printed at the latch, before any later request');
    assert.ok(indexOf(ctx, e => e.event === 'limit') < indexOf(ctx, e => e.event === 'request'));
    const refused = await request(ctx.socket, { body: '{}' });
    assert.deepEqual([refused.status, errorCode(refused)], [429, 'acoder_usage_unreported']);
    assert.equal(ctx.stub.requests.length, 1, 'no later request reaches the endpoint');
    assert.deepEqual(kinds(ctx), ['usage_unreported']);
    assert.ok(await waitFor(() => late.length === 1, 3000));
    assert.deepEqual(late, [true], 'the sidecar closed the upstream request');
    assert.deepEqual(invalidEvents(ctx.events), []);
  });
});

t('spec08-abort: a client closes after final usage but before the end: usage is counted and no usage_unreported occurs', () => {
  const scenario = inOrder([
    async (req, res) => {
      streamHead(res);
      res.write(sseText([created()]) + ssePad());
      res.write(sseText([completed()]) + ssePad());
      await new Promise(resolve => { res.on('close', resolve); setTimeout(resolve, 5000); });
    },
    (req, res) => jsonAnswer(res),
  ]);
  return withSidecar({ scenario }, async ctx => {
    const client = streaming(ctx.socket);
    assert.ok(await waitFor(() => client.text().includes('response.completed'), 4000));
    client.abort();
    const [event] = await ctx.requestEvents(1);
    assert.deepEqual([event.complete, event.usage], [false, usage4(11, 7)]);
    assert.deepEqual(kinds(ctx), []);
    assert.equal((await request(ctx.socket, { body: '{}' })).status, 200, 'admissions stay open');
    assert.equal(ctx.stub.requests.length, 2);
    assert.equal((await stopForSummary(ctx)).tokens.total, 36);
    assert.equal(ctx.sidecar.accounting.snapshot().usage_missing, 0);
  });
});

// A stream that sends its first chunk and then waits for the client to go away.
const held = async (req, res) => {
  streamHead(res);
  res.write(sseText([created()]) + ssePad());
  await new Promise(resolve => { res.on('close', resolve); setTimeout(resolve, 8000); });
};

t('spec08-abort: an abort after the L-th admission and before any refusal or STOP: latched, one calls limit event, lower-bound counts, no usage_unreported', () => withSidecar({ scenario: inOrder([held]), limits: { calls: 1 } }, async ctx => {
  const client = streaming(ctx.socket);
  assert.ok(await waitFor(() => client.chunks.length > 0, 4000));
  assert.equal(ctx.sidecar.accounting.snapshot().latched, true, 'the L-th admission latched before any refusal');
  client.abort();
  const [event] = await ctx.requestEvents(1);
  assert.equal(event.complete, false);
  assert.deepEqual(kinds(ctx), ['calls'], 'the pending limit is printed before the post-latch incomplete request is reported');
  assert.ok(indexOf(ctx, e => e.event === 'limit') < indexOf(ctx, e => e.event === 'request'));
  const refused = await request(ctx.socket, { body: '{}' });
  assert.deepEqual([refused.status, errorCode(refused)], [429, 'acoder_budget_calls']);
  assert.deepEqual(kinds(ctx), ['calls'], 'one limit event');
  const snapshot = ctx.sidecar.accounting.snapshot();
  assert.deepEqual([snapshot.reason, snapshot.usage_missing, snapshot.tokens_lower_bound], ['calls', 1, true]);
  assert.equal(ctx.stub.requests.length, 1);
  assert.deepEqual(invalidEvents(ctx.events), []);
}));

t('spec08-abort: a token total that reaches its limit before any refusal latches; an abort after it is a lower bound with one tokens limit event', () => withSidecar({ scenario: inOrder([held, (req, res) => jsonAnswer(res)]), limits: { tokens: 18 } }, async ctx => {
  const streamClient = streaming(ctx.socket);
  assert.ok(await waitFor(() => streamClient.chunks.length > 0, 4000));
  assert.equal((await request(ctx.socket, { body: '{}' })).status, 200);
  await ctx.requestEvents(1);
  assert.equal(ctx.sidecar.accounting.snapshot().reason, 'tokens', 'the token total reached the limit and latched before any refusal');
  streamClient.abort();
  const events = await ctx.requestEvents(2);
  assert.equal(events[1].complete, false);
  assert.deepEqual(kinds(ctx), ['tokens']);
  assert.ok(indexOf(ctx, e => e.event === 'limit') < indexOf(ctx, e => e.event === 'request' && e.complete === false));
  const refused = await request(ctx.socket, { body: '{}' });
  assert.deepEqual([refused.status, errorCode(refused)], [429, 'acoder_budget_tokens']);
  const summary = await stopForSummary(ctx);
  assert.deepEqual([summary.usage_missing, summary.admitted_after_token_limit, summary.tokens.total], [1, 0, 18]);
  assert.deepEqual(kinds(ctx), ['tokens'], 'no usage_unreported and no second limit event');
}));

t('response-model: the model is read through the profile from JSON, Responses streams and chat streams; absent or malformed model is null independently of usage', () => {
  const scenario = inOrder([
    (req, res) => jsonAnswer(res, { model: 'json-model' }),
    (req, res) => streamAnswer(res, [created('resp-model'), completed(undefined, 'resp-model')]),
    (req, res) => streamAnswer(res, [{ model: 'chat-model', choices: [] }, { model: 'chat-model', choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } }]),
    (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } })); },
    (req, res) => jsonAnswer(res, { model: 42 }),
    (req, res) => jsonAnswer(res, { model: 'only-model', usage: null }),
  ]);
  return withSidecar({ scenario, limits: { tokens: null } }, async ctx => {
    for (let index = 0; index < 6; index += 1) assert.equal((await request(ctx.socket, { body: '{}' })).status, 200);
    const events = await ctx.requestEvents(6);
    assert.deepEqual(events.map(event => event.response_model), ['json-model', 'resp-model', 'chat-model', null, null, 'only-model']);
    assert.deepEqual(events.map(event => event.usage === null), [false, false, false, false, false, true]);
    assert.deepEqual(invalidEvents(ctx.events), []);
  });
});

t('response-model: the emitted model is sanitized to printable ASCII, truncated to 64 characters and redacted', () => {
  const scenario = inOrder([
    (req, res) => jsonAnswer(res, { model: `m\u0001é${'x'.repeat(100)}` }),
    (req, res) => jsonAnswer(res, { model: `pre-${keyOf(req)}` }),
  ]);
  return withSidecar({ scenario }, async ctx => {
    for (let index = 0; index < 2; index += 1) assert.equal((await request(ctx.socket, { body: '{}' })).status, 200);
    const events = await ctx.requestEvents(2);
    assert.deepEqual(events.map(event => event.response_model), [`m??${'x'.repeat(61)}`, 'pre-[REDACTED]']);
    assert.ok(!JSON.stringify(ctx.events).includes(ctx.key));
    assert.deepEqual(invalidEvents(ctx.events), []);
  });
});

t('response-model: the core uses only the profile seam: a profile double\'s model and usage are emitted, never the values of the body', () => {
  const profile = {
    ...openai,
    createUsageExtractor(contentType) {
      const inner = openai.createUsageExtractor(contentType);
      return { push: chunk => inner.push(chunk), result: () => ({ usage: usage4(5, 6, 1, 2), model: `double\u0007model-${inner.result().model}` }) };
    },
  };
  const scenario = inOrder([(req, res) => jsonAnswer(res, { model: 'body-model' }), (req, res) => streamAnswer(res, [created('body-model'), completed(undefined, 'body-model')])]);
  return withSidecar({ scenario, profile }, async ctx => {
    for (let index = 0; index < 2; index += 1) assert.equal((await request(ctx.socket, { body: '{}' })).status, 200);
    const events = await ctx.requestEvents(2);
    for (const event of events) {
      assert.equal(event.response_model, 'double?model-body-model');
      assert.deepEqual(event.usage, usage4(5, 6, 1, 2));
    }
  });
});
