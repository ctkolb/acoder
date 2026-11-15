import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import * as openai from '../providers/openai.mjs';
import { embedBase64, expectedForms } from './helpers/key-forms.mjs';
import { invalidEvents, waitFor, withSidecar } from './helpers/sidecar-harness.mjs';
import { request, streaming } from './helpers/socket-client.mjs';
import { gate, OPENSSL_MISSING } from './helpers/stub-endpoint.mjs';

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

// R31-02 (A3.3, A8.5): the redactor holds back only the longest end of a chunk that is a proper prefix of a key form and sends the rest
// at once. In each step the stub sends `data: <` + part 1; after the client has exactly `data: <`, part 2; after the client has that
// part's bytes, `>\n\n`. A step {name, at, rest?} splits the form `name` after `at` characters; part 2 is the rest of the form, or
// `rest` when given (the form is then never completed). `steps(key)` lists the steps; one sidecar serves them one after the other.
const PREFIX = 'data: <';
const REPLACED = '[REDACTED]';
const splitParts = (key, { name, at, rest }) => {
  const form = expectedForms(key)[name];
  return [form.slice(0, at), rest ?? form.slice(at)];
};
async function splitSteps(steps) {
  const gates = [];
  let current = null;
  const scenario = async (req, res) => {
    const step = current;
    const [first, second] = splitParts(keyOf(req), step);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`${PREFIX}${first}`);
    if (await step.middle.wait(5000)) res.write(second);
    if (await step.last.wait(5000)) res.end('>\n\n');
    else res.end();
  };
  // The stream carries no usage: without a token gate that is no usage_unreported, and the call limit is above the number of steps.
  await withSidecar({ scenario, limits: { calls: 1000, tokens: null } }, async ctx => {
    try {
      for (const step of steps(ctx.key)) {
        current = { ...step, middle: gate(), last: gate() };
        gates.push(current.middle, current.last);
        const [first, second] = splitParts(ctx.key, step);
        const label = `${step.name} split after ${step.at}${step.rest === undefined ? '' : ' (not completed)'}`;
        const before = ctx.sidecar.stats().key_reflections;
        const client = streaming(ctx.socket);
        // Part 1 is a prefix of the form: it is held back while the stub holds part 2, and the bytes before it are not.
        assert.ok(await waitFor(() => client.text().length >= PREFIX.length, 3000), `${label}: the bytes before the split arrive before the rest is sent`);
        assert.equal(client.text(), PREFIX, `${label}: exactly the bytes before the possible key form are sent`);
        current.middle.open();
        const shown = step.rest === undefined ? `${PREFIX}${REPLACED}` : `${PREFIX}${first}${second}`;
        assert.ok(await waitFor(() => client.text().length >= shown.length, 3000), `${label}: part 2 is passed on before the stream ends`);
        assert.equal(client.text(), shown, `${label}: a completed form is replaced, an incomplete one is sent as it came`);
        current.last.open();
        const result = await client.done;
        assert.equal(result.complete, true, label);
        assert.equal(client.text(), `${shown}>\n\n`, label);
        assert.deepEqual(formsIn(client.text(), ctx.key), [], `${label}: no form of the key reaches the client`);
        assert.equal(ctx.sidecar.stats().key_reflections - before, step.rest === undefined ? 1 : 0, `${label}: each replacement counts`);
      }
      assert.deepEqual(formsIn(JSON.stringify(ctx.events), ctx.key), [], 'no event line holds the key in any form');
    } finally {
      for (const item of gates) item.open();
    }
  });
}
// Every form of A8.6 (base64url is the same text as base64 for this key alphabet, see key-forms.mjs).
const FORM_NAMES = ['raw', 'base64-0', 'base64-1', 'base64-2', 'hex-lower', 'hex-upper', 'percent-lower', 'percent-upper'];
const everySplit = (key, name) => Array.from({ length: expectedForms(key)[name].length - 1 }, (unused, index) => ({ name, at: index + 1 }));

// The index of the first key byte whose hex digits hold a letter: up to and including it the lower- and upper-case hex and percent forms
// differ, so a split there is a prefix of the one form only, whatever the random key (syntheticKey makes the two hex forms differ).
const firstLetterByte = key => [...Buffer.from(key)].findIndex(byte => /[a-f]/.test(byte.toString(16)));

t('dod8-proxy-reflect: a chunk ending in the first bytes of a key form is held only for those bytes: replaced when the next chunk completes the form, sent when it does not', () => splitSteps(key => {
  const letter = firstLetterByte(key);
  assert.ok(letter >= 0, 'the key has a byte with a hex letter');
  return [
    { name: 'raw', at: 5 }, { name: 'raw', at: 5, rest: '!' },
    // `%..%xa%`: its shortest end `%` is a form prefix too, and every byte of it must be held.
    { name: 'percent-lower', at: 3 * letter + 4 }, { name: 'percent-lower', at: 3 * letter + 4, rest: '!' },
    { name: 'hex-upper', at: 2 * letter + 2 }, { name: 'hex-upper', at: 2 * letter + 2, rest: '!' },
  ];
}));

t('dod8-proxy-reflect: a stream that ends in the first bytes of a key form gets those bytes at its end', () => {
  const scenario = (req, res) => {
    const forms = expectedForms(keyOf(req));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: <');
    res.end(`${forms.raw.slice(0, 5)}|${forms['percent-lower'].slice(0, 4)}`);
  };
  return withSidecar({ scenario, limits: { tokens: null } }, async ctx => {
    const answer = await request(ctx.socket, { body: '{}' });
    const forms = expectedForms(ctx.key);
    assert.equal(answer.body.toString('latin1'), `data: <${forms.raw.slice(0, 5)}|${forms['percent-lower'].slice(0, 4)}`, 'the held end is sent when the stream ends');
    assert.equal(ctx.sidecar.stats().key_reflections, 0);
  });
});

t('dod8-proxy-reflect: each key form of A8.6 split in the middle across two chunks is held back and replaced', () => splitSteps(key => FORM_NAMES.map(name => ({ name, at: Math.floor(expectedForms(key)[name].length / 2) }))));

t('dod8-proxy-reflect: the raw key split at every position of a two-chunk stream is always replaced', () => splitSteps(key => everySplit(key, 'raw')), 60000);

t('dod8-proxy-reflect: the base64 form (one byte alignment) split at every position of a two-chunk stream is always replaced', () => splitSteps(key => everySplit(key, 'base64-1')), 60000);

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
    assert.equal(ctx.events.at(-1)?.event, 'fatal');
    assert.ok(!JSON.stringify(ctx.events).includes('internal failure'));
    assert.deepEqual(invalidEvents(ctx.events), []);
  });
});
