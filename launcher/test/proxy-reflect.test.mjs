import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import * as openai from '../providers/openai.mjs';
import { embedBase64, expectedForms } from './helpers/key-forms.mjs';
import { invalidEvents, waitFor, withSidecar } from './helpers/sidecar-harness.mjs';
import { request } from './helpers/socket-client.mjs';
import { OPENSSL_MISSING } from './helpers/stub-endpoint.mjs';

// G11: every test has a finite time limit of its own and is registered from this file (the mutation runner counts tests per module);
// a test that needs the stub certificate is skipped with the reason when `openssl` is absent.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout, skip: OPENSSL_MISSING }, fn);

// S3-AC8 (dod8-proxy-reflect, scenario echo-key): the key the endpoint reflects never reaches the agent or an event.
const keyOf = req => String(req.headers.authorization).slice('Bearer '.length);
const formsIn = (text, key) => Object.entries(expectedForms(key)).filter(([, form]) => text.includes(form)).map(([name]) => name);
const count = (text, part) => text.split(part).length - 1;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// The body parts that hold the key: each form of A8.6 once, and the raw key split across two chunks at the end.
function bodyParts(key) {
  const forms = expectedForms(key);
  const split = Math.floor(key.length / 2);
  const first = JSON.stringify({
    plain: key, b64: [0, 1, 2].map(offset => embedBase64(key, offset, false)), b64url: [0, 1, 2].map(offset => embedBase64(key, offset, true)),
    hex: forms['hex-lower'], HEX: forms['hex-upper'], pct: forms['percent-lower'], PCT: forms['percent-upper'], split: '',
  }).slice(0, -2);
  return [`${first}${key.slice(0, split)}`, `${key.slice(split)}"}`];
}
// Body forms: plain 1, base64 3, base64url 3 (the same text as base64 for this key alphabet, so 3 more matches), hex 2, percent 2, split 1.
const BODY_REPLACEMENTS = 12;

const echoKey = async (req, res) => {
  const key = keyOf(req);
  const parts = bodyParts(key);
  res.writeHead(200, ['content-type', 'application/json', 'content-length', String(parts.join('').length), 'x-echo', `v-${key}-v`, `x-${key}`, 'named']);
  res.write(parts[0]);
  await pause(80);
  res.end(parts[1]);
};

t('dod8-proxy-reflect: the key in a response header value, a header name and the body (every form, split across chunks) is redacted and counted', () => withSidecar({ scenario: echoKey }, async ctx => {
  const answer = await request(ctx.socket, { body: '{}' });
  assert.equal(answer.status, 200);
  assert.equal(answer.error, undefined, 'the redacted body is delivered whole (no content-length mismatch)');
  const body = answer.body.toString('latin1');
  assert.deepEqual(formsIn(body, ctx.key), [], 'no form of the key reaches the client');
  assert.equal(count(body, '[REDACTED]'), BODY_REPLACEMENTS);
  assert.ok(body.endsWith('[REDACTED]"}'), 'the key split across chunks is replaced');
  assert.equal(answer.headers['x-echo'], 'v-[REDACTED]-v');
  assert.deepEqual(answer.rawHeaders.filter((value, index) => index % 2 === 0 && value.includes(ctx.key)), [], 'no header is named with the key');
  assert.deepEqual(formsIn(JSON.stringify(answer.rawHeaders), ctx.key), []);
  assert.equal(ctx.sidecar.stats().key_reflections, BODY_REPLACEMENTS + 2, 'each replacement and the dropped header count');
  const [event] = await ctx.requestEvents(1);
  assert.deepEqual([event.complete, event.bytes_down], [true, bodyParts(ctx.key).join('').length], 'bytes_down counts the bytes from the endpoint');
  ctx.control('STOP');
  const summary = await waitFor(() => ctx.ofKind('summary')[0], 3000);
  assert.equal(summary.key_reflections, BODY_REPLACEMENTS + 2);
  assert.deepEqual(formsIn(JSON.stringify(ctx.events), ctx.key), [], 'no event line holds the key in any form');
  assert.deepEqual(invalidEvents(ctx.events), []);
}));

t('dod8-proxy-reflect: every key form of A8.6 alone in a streamed body is replaced, also when the form arrives one byte per chunk', async () => {
  for (const name of ['raw', 'base64-0', 'base64-1', 'base64-2', 'hex-lower', 'hex-upper', 'percent-lower', 'percent-upper']) {
    const scenario = async (req, res) => {
      const form = expectedForms(keyOf(req))[name];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: <');
      for (const char of form) { res.write(char); await pause(1); }
      res.end('>\n\n');
    };
    await withSidecar({ scenario }, async ctx => {
      const answer = await request(ctx.socket, { body: '{}' });
      assert.equal(answer.body.toString('latin1'), 'data: <[REDACTED]>\n\n', name);
      assert.equal(ctx.sidecar.stats().key_reflections, 1, name);
    });
  }
}, 60000);

t('dod8-proxy-reflect: a body without the key passes unchanged, byte for byte', () => {
  const bytes = Buffer.from(Array.from({ length: 3000 }, (value, index) => (index * 7) % 256));
  const scenario = (req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.write(bytes.subarray(0, 1000)); res.end(bytes.subarray(1000)); };
  return withSidecar({ scenario }, async ctx => {
    const answer = await request(ctx.socket, { body: '{}' });
    assert.ok(answer.body.equals(bytes));
    assert.equal(ctx.sidecar.stats().key_reflections, 0);
  });
});

t('dod8-proxy-reflect: a deliberately thrown internal error prints a fatal event with a code only and asks for exit 70', () => {
  const profile = { ...openai, createUsageExtractor() { throw new Error(`internal failure for ${'k'.repeat(4)}`); } };
  return withSidecar({ profile }, async ctx => {
    const answer = await request(ctx.socket, { body: '{}' });
    assert.ok(answer.error !== undefined || answer.status === undefined, 'the client gets no complete answer');
    assert.ok(await waitFor(() => ctx.exits.length > 0, 3000));
    assert.deepEqual(ctx.exits, [70]);
    assert.deepEqual(ctx.ofKind('fatal'), [{ event: 'fatal', code: 'internal_error' }]);
    assert.equal(ctx.events.at(-1).event, 'fatal');
    assert.ok(!JSON.stringify(ctx.events).includes('internal failure'));
    assert.deepEqual(invalidEvents(ctx.events), []);
  });
});
