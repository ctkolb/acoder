import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { SKIP } from './helpers/container-env.mjs';
import { assertStagingGone, withContainerRun } from './helpers/container-run.mjs';
import { expectedForms } from './helpers/key-forms.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// S4-AC11 (DoD 8) dod8-reflect, exactly as A8.7: the stub endpoint (scenario echo-key) returns the received authorization value in a
// response header value, in a response header NAME (`X-` and the key) and in the body, plain and base64. The dump holds [REDACTED], no header
// named with the key and no form of the key; the record shows key_reflections above 0 and error, secret_found.
t('dod8-reflect: a reflected key reaches the agent only as [REDACTED]; no header is named with it; the run ends error secret_found', async () => {
  await withContainerRun({ scenario: 'dump', answers: { default: 'echo-key' } }, async ({ record, fx, endpointRequests }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    assert.equal(endpointRequests()[0].mode, 'echo-key', 'the endpoint reflected the key');
    const dump = fs.readFileSync(path.join(fx.writable.scratch, 'dump.txt'), 'latin1');
    const answer = JSON.parse(/^answer (.*)$/m.exec(dump)[1]);
    assert.equal(answer.status, 200);
    const names = answer.headers.filter((value, index) => index % 2 === 0).map(name => name.toLowerCase());
    assert.ok(names.includes('x-echo'), 'the reflecting value header reached the agent');
    assert.ok(!names.some(name => name.startsWith('x-') && name !== 'x-echo'), `no header named with the key: ${names}`);
    assert.equal(answer.headers[answer.headers.findIndex(name => name.toLowerCase() === 'x-echo') + 1], '[REDACTED]');
    const body = JSON.parse(answer.body);
    assert.equal(body.plain, '[REDACTED]', 'the plain body form is redacted');
    assert.ok(body.b64.startsWith('[REDACTED]') && body.b64.length <= '[REDACTED]'.length + 3, `the base64 body form is redacted (only its last partial group stays): ${body.b64}`);
    assert.deepEqual(Object.entries(expectedForms(fx.key)).filter(([, form]) => dump.includes(form)).map(([name]) => name), [], 'no form of the key in the dump');
    assert.ok(record.egress_totals.key_reflections > 0);
    assert.deepEqual([record.exit_reason, record.error_detail], ['error', 'secret_found']);
    assertStagingGone({ fx, record });
  });
});
