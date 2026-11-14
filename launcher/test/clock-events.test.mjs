import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { invalidEvents, withSidecar } from './helpers/sidecar-harness.mjs';
import { errorCode, request } from './helpers/socket-client.mjs';
import { OPENSSL_MISSING } from './helpers/stub-endpoint.mjs';

// G11: every test has a finite time limit of its own and is registered from this file (the mutation runner counts tests per module);
// a test that needs the stub certificate is skipped with the reason when `openssl` is absent.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout, skip: OPENSSL_MISSING }, fn);

// S3-AC6 and S3-AC9 (clock-events): the control lines CLOCK and PHASE agent <deadline> (A3.5, A3.6).
const NOW = 1_800_000_000_000;
const notReleased = async ctx => {
  const answer = await request(ctx.socket, { body: '{}' });
  assert.deepEqual([answer.status, errorCode(answer)], [403, 'acoder_not_released']);
};

t('clock-events: CLOCK in phase probe is answered once with a clock event sampled when the line is handled', () => {
  let clock = NOW;
  return withSidecar({ release: false, deps: { now: () => clock } }, async ctx => {
    clock = NOW + 1234;
    ctx.control('CLOCK');
    assert.deepEqual(ctx.ofKind('clock'), [{ event: 'clock', clock_epoch_ms: NOW + 1234 }]);
    clock = NOW + 5000;
    ctx.control('CLOCK');
    assert.equal(ctx.ofKind('clock').length, 1, 'a repeated CLOCK is rejected');
    assert.equal(ctx.sidecar.phase(), 'probe');
    assert.deepEqual(invalidEvents(ctx.events), []);
  });
});

t('clock-events: CLOCK after PHASE agent is out of order and rejected', () => withSidecar({ release: false }, async ctx => {
  ctx.control(`PHASE agent ${Date.now() + 600000}`);
  assert.equal(ctx.sidecar.phase(), 'agent');
  ctx.control('CLOCK');
  assert.deepEqual(ctx.ofKind('clock'), []);
}));

t('clock-events: a valid PHASE agent <deadline> switches the phase once and prints the phase event', () => withSidecar({ release: false }, async ctx => {
  await notReleased(ctx);
  ctx.control(`PHASE agent ${Date.now() + 600000}`);
  assert.deepEqual(ctx.ofKind('phase'), [{ event: 'phase', phase: 'agent' }]);
  assert.equal(ctx.sidecar.phase(), 'agent');
  assert.equal((await request(ctx.socket, { body: '{}' })).status, 200);
  assert.equal(ctx.stub.requests.length, 1);
  assert.deepEqual(invalidEvents(ctx.events), []);
}));

t('clock-events: the largest safe integer is a valid deadline', () => withSidecar({ release: false }, async ctx => {
  ctx.control(`PHASE agent ${Number.MAX_SAFE_INTEGER}`);
  assert.equal(ctx.sidecar.phase(), 'agent');
}));

// Signed, hexadecimal, fractional, exponent, empty and unsafe-integer deadlines, and other malformed PHASE lines (one sidecar each).
const BAD_PHASE_LINES = {
  'plus sign': 'PHASE agent +1900000000000', 'minus sign': 'PHASE agent -1900000000000', hexadecimal: 'PHASE agent 0x1ba5f0e5800', fraction: 'PHASE agent 1900000000000.5', 'zero fraction': 'PHASE agent 1900000000000.0',
  exponent: 'PHASE agent 1.9e12', 'empty deadline': 'PHASE agent ', 'unsafe integer': 'PHASE agent 9007199254740992', 'two spaces': 'PHASE agent  1900000000000',
  'trailing space': 'PHASE agent 1900000000000 ', 'digits then letters': 'PHASE agent 1900000000000ms', 'no deadline': 'PHASE agent', 'bare PHASE': 'PHASE',
  'phase probe': 'PHASE probe 1900000000000', 'extra field': 'PHASE agent 1900000000000 extra',
};
for (const [name, line] of Object.entries(BAD_PHASE_LINES)) {
  t(`clock-events: a PHASE line whose deadline is not an unsigned safe decimal integer, or that is malformed (${name}), is rejected without phase change or forwarding`, () => withSidecar({ release: false }, async ctx => {
    ctx.control(line);
    assert.equal(ctx.sidecar.phase(), 'probe');
    assert.deepEqual(ctx.ofKind('phase'), []);
    await notReleased(ctx);
    assert.equal(ctx.stub.requests.length, 0);
    assert.equal(ctx.recorder.connects.length, 0);
  }));
}

t('clock-events: after STOP, CLOCK and PHASE change nothing', () => withSidecar({ release: false }, async ctx => {
  ctx.control('STOP');
  ctx.control('CLOCK');
  ctx.control(`PHASE agent ${Date.now() + 600000}`);
  assert.deepEqual(ctx.ofKind('clock'), []);
  assert.deepEqual(ctx.ofKind('phase'), []);
  assert.equal(ctx.sidecar.phase(), 'probe');
  assert.deepEqual(ctx.ofKind('fatal'), []);
}));

t('clock-events: a lower-case control word is no PHASE line and changes nothing', () => withSidecar({ release: false }, async ctx => {
  ctx.control(`phase agent ${NOW}`);
  assert.equal(ctx.sidecar.phase(), 'probe');
  ctx.control(`PHASE agent ${Date.now() + 600000}`);
  assert.equal(ctx.sidecar.phase(), 'agent', 'the first real PHASE line still releases');
}));
