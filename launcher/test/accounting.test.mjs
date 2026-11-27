import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { createAccounting } from '../container/accounting.mjs';
import { must, thrownOf } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own. The test is registered from this file, so that the mutation runner can count it per module.
const t = (name, fn, timeout = 10000) => nodeTest(name, { timeout }, fn);

// S3-AC1 (dod5-accounting): the pure admission and accounting module of A6.2 to A6.5. Times are plain numbers (an injected clock).
const make = (limits = {}) => must(() => createAccounting({ calls: 3, tokens: 1000, maxInFlight: 2, ...limits }));
const usage = (input, output, reasoning = 0, cached = 0) => ({ input, output, reasoning, cached_input: cached });
const admitOk = (acc, now = 0) => {
  const result = must(() => acc.admit(now));
  assert.equal(result.ok, true, `expected an admission, got ${JSON.stringify(result)}`);
  return result.id;
};
const refusedWith = (acc, code, now = 0) => assert.deepEqual(must(() => acc.admit(now)), { ok: false, code });

t('dod5-accounting: the limits are validated (calls and max_in_flight positive integers, tokens a positive integer or null)', () => {
  for (const bad of [{ calls: 0 }, { calls: -1 }, { calls: 1.5 }, { calls: '3' }, { tokens: 0 }, { tokens: 2.5 }, { tokens: undefined }, { maxInFlight: 0 }, { maxInFlight: null }]) {
    assert.notEqual(thrownOf(() => createAccounting({ calls: 3, tokens: 1000, maxInFlight: 2, ...bad })), null, `refused: ${JSON.stringify(bad)}`);
  }
  assert.equal(must(() => createAccounting({ calls: 1, tokens: null, maxInFlight: 1 })).snapshot().forwarded, 0);
});

t('dod5-accounting: a request is admitted only while forwarded < calls, and the counter is incremented at admission', () => {
  const acc = make({ calls: 3, maxInFlight: 10 });
  const ids = [];
  for (let n = 1; n <= 3; n += 1) {
    ids.push(admitOk(acc));
    assert.equal(acc.snapshot().forwarded, n, 'counted at admission, before any answer');
    assert.equal(acc.snapshot().in_flight, n);
  }
  assert.equal(new Set(ids).size, 3, 'each admission has its own id');
  refusedWith(acc, 'acoder_budget_calls');
  for (const id of ids) acc.finish(id, { complete: true, status: 200, usage: usage(1, 1) });
  refusedWith(acc, 'acoder_budget_calls');
  assert.equal(acc.snapshot().forwarded, 3, 'a refused request is not a call');
});

t('dod5-accounting: the admissions latch at the instant the counter reaches calls, before any refusal or event', () => {
  const acc = make({ calls: 2, maxInFlight: 10 });
  admitOk(acc);
  assert.equal(acc.snapshot().latched, false);
  admitOk(acc);
  const state = acc.snapshot();
  assert.equal(state.latched, true, 'latched by the L-th admission itself');
  assert.equal(state.reason, 'calls');
  assert.equal(state.in_flight_at_limit, 2);
});

t('dod5-accounting: at most max_in_flight requests are open; the refusal acoder_in_flight is not a call and does not latch', () => {
  const acc = make({ calls: 10, maxInFlight: 2 });
  const first = admitOk(acc);
  admitOk(acc);
  refusedWith(acc, 'acoder_in_flight');
  refusedWith(acc, 'acoder_in_flight');
  assert.equal(acc.snapshot().forwarded, 2);
  assert.equal(acc.snapshot().latched, false);
  acc.finish(first, { complete: true, status: 200, usage: usage(1, 1) });
  admitOk(acc);
  assert.equal(acc.snapshot().in_flight, 2);
});

t('dod5-accounting: the token total is input + output (cached within input, reasoning within output); no admission once it reached the limit', () => {
  const acc = make({ calls: 10, tokens: 100, maxInFlight: 10 });
  const first = admitOk(acc);
  acc.finish(first, { complete: true, status: 200, usage: usage(40, 20, 15, 30) });
  assert.deepEqual(acc.snapshot().tokens, { input: 40, output: 20, reasoning: 15, cached_input: 30, total: 60 });
  assert.equal(acc.snapshot().latched, false, 'below the limit');
  const second = admitOk(acc);
  acc.finish(second, { complete: true, status: 200, usage: usage(30, 10) });
  assert.equal(acc.snapshot().tokens.total, 100);
  assert.equal(acc.snapshot().latched, true, 'reaching the limit latches');
  assert.equal(acc.snapshot().reason, 'tokens');
  refusedWith(acc, 'acoder_budget_tokens');
  assert.equal(acc.snapshot().admitted_after_token_limit, 0);
  assert.equal(acc.snapshot().forwarded, 2);
});

t('dod5-accounting: one below the token limit still admits; the overshoot of in-flight requests is counted and admits nothing more', () => {
  const acc = make({ calls: 10, tokens: 100, maxInFlight: 3 });
  const a = admitOk(acc);
  acc.finish(a, { complete: true, status: 200, usage: usage(50, 49) });
  assert.equal(acc.snapshot().latched, false, '99 < 100');
  const b = admitOk(acc);
  const c = admitOk(acc);
  acc.finish(b, { complete: true, status: 200, usage: usage(10, 10) });
  assert.equal(acc.snapshot().reason, 'tokens');
  assert.equal(acc.snapshot().in_flight_at_limit, 1, 'one request was still in flight at the crossing');
  refusedWith(acc, 'acoder_budget_tokens');
  acc.finish(c, { complete: true, status: 200, usage: usage(10, 10) });
  assert.equal(acc.snapshot().tokens.total, 139, 'the in-flight request after the crossing is counted (permitted overshoot)');
  refusedWith(acc, 'acoder_budget_tokens');
  assert.equal(acc.snapshot().admitted_after_token_limit, 0);
});

t('dod5-accounting: a passed deadline refuses with acoder_budget_wall_clock and latches; before it, admissions are open', () => {
  const acc = make({ calls: 10, maxInFlight: 10 });
  must(() => acc.setDeadline(1000));
  admitOk(acc, 999);
  refusedWith(acc, 'acoder_budget_wall_clock', 1000);
  assert.equal(acc.snapshot().latched, true);
  assert.equal(acc.snapshot().reason, 'wall_clock');
  refusedWith(acc, 'acoder_budget_wall_clock', 1000);
  assert.notEqual(thrownOf(() => acc.setDeadline(5000)), null, 'the deadline is set once');
  for (const bad of [-1, 1.5, '10', Number.MAX_SAFE_INTEGER + 1]) assert.notEqual(thrownOf(() => make().setDeadline(bad)), null, `deadline ${bad}`);
});

t('dod5-accounting: after the deadline every request is refused with wall_clock, even when another limit latched first; the first reason is retained', () => {
  const acc = make({ calls: 1, maxInFlight: 10 });
  must(() => acc.setDeadline(100));
  admitOk(acc, 0);
  refusedWith(acc, 'acoder_budget_calls', 50);
  refusedWith(acc, 'acoder_budget_wall_clock', 100);
  assert.equal(acc.snapshot().reason, 'calls', 'the first latched reason is retained');
});

t('dod5-accounting: check() refuses like admit() but admits nothing (phase probe)', () => {
  const acc = make({ calls: 1, maxInFlight: 1 });
  assert.equal(must(() => acc.check(0)), null);
  assert.equal(acc.snapshot().forwarded, 0, 'a check is not a call');
  admitOk(acc);
  assert.equal(acc.check(0), 'acoder_budget_calls');
});

t('dod5-accounting: with a token limit, an incomplete request without usage while admissions are open is usage_unreported', () => {
  const acc = make({ calls: 10, maxInFlight: 10 });
  const id = admitOk(acc);
  acc.finish(id, { complete: false, status: 200, usage: null });
  const state = acc.snapshot();
  assert.equal(state.latched, true);
  assert.equal(state.reason, 'usage_unreported');
  assert.equal(state.usage_missing, 1);
  refusedWith(acc, 'acoder_usage_unreported');
});

t('dod5-accounting: with a token limit, a completed 2xx answer without usage while admissions are open is usage_unreported', () => {
  for (const status of [200, 201, 299]) {
    const acc = make({ calls: 10, maxInFlight: 10 });
    acc.finish(admitOk(acc), { complete: true, status, usage: null });
    assert.equal(acc.snapshot().reason, 'usage_unreported', `status ${status}`);
  }
});

t('dod5-accounting: a completed non-2xx answer without usage is no error and no missing usage', () => {
  for (const status of [199, 300, 400, 429, 500]) {
    const acc = make({ calls: 10, maxInFlight: 10 });
    acc.finish(admitOk(acc), { complete: true, status, usage: null });
    const state = acc.snapshot();
    assert.equal(state.latched, false, `status ${status}`);
    assert.equal(state.usage_missing, 0);
    assert.equal(state.tokens_lower_bound, false);
  }
});

t('dod5-accounting: an incomplete request with final usage is counted and is not usage_unreported (post-usage abort)', () => {
  const acc = make({ calls: 10, maxInFlight: 10 });
  acc.finish(admitOk(acc), { complete: false, status: 200, usage: usage(5, 7) });
  const state = acc.snapshot();
  assert.equal(state.latched, false);
  assert.equal(state.reason, null);
  assert.equal(state.tokens.total, 12);
  assert.equal(state.usage_missing, 0);
});

t('dod5-accounting: a stop-caused abort without usage adds tokens_lower_bound and usage_missing, never usage_unreported (STOP, calls, tokens, wall clock)', () => {
  const cases = {
    stop: acc => acc.stop(),
    calls: acc => admitOk(acc),
    tokens: acc => acc.finish(admitOk(acc), { complete: true, status: 200, usage: usage(500, 500) }),
    wall_clock: acc => { acc.setDeadline(10); acc.admit(10); },
  };
  for (const [name, latch] of Object.entries(cases)) {
    const acc = make({ calls: name === 'calls' ? 2 : 10, maxInFlight: 10 });
    if (name === 'wall_clock') {
      const open = admitOk(acc, 0);
      latch(acc);
      acc.finish(open, { complete: false, status: 200, usage: null });
    } else {
      const open = admitOk(acc);
      latch(acc);
      acc.finish(open, { complete: false, status: 200, usage: null });
    }
    const state = acc.snapshot();
    assert.equal(state.latched, true, name);
    assert.equal(state.reason, name === 'stop' ? null : name, `${name}: the latched reason is not promoted`);
    assert.equal(state.usage_missing, 1, name);
    assert.equal(state.tokens_lower_bound, true, name);
  }
});

t('dod5-accounting: a completed 2xx answer without usage after the latch is missing usage, not usage_unreported', () => {
  const acc = make({ calls: 1, maxInFlight: 10 });
  const id = admitOk(acc);
  acc.finish(id, { complete: true, status: 200, usage: null });
  assert.equal(acc.snapshot().reason, 'calls');
  assert.equal(acc.snapshot().usage_missing, 1);
  assert.equal(acc.snapshot().tokens_lower_bound, true);
});

t('dod5-accounting: tokens null has no token gate and no usage_unreported; missing usage is an advisory lower bound; calls and wall clock still apply', () => {
  const acc = make({ calls: 3, tokens: null, maxInFlight: 10 });
  acc.finish(admitOk(acc), { complete: true, status: 200, usage: usage(1e6, 1e6) });
  assert.equal(acc.snapshot().latched, false, 'no token gate');
  acc.finish(admitOk(acc), { complete: false, status: 200, usage: null });
  const state = acc.snapshot();
  assert.equal(state.latched, false, 'no usage_unreported');
  assert.equal(state.reason, null);
  assert.equal(state.usage_missing, 1);
  assert.equal(state.tokens_lower_bound, true);
  assert.equal(state.tokens.total, 2e6);
  admitOk(acc);
  refusedWith(acc, 'acoder_budget_calls');
  acc.setDeadline(50);
  refusedWith(acc, 'acoder_budget_wall_clock', 50);
});

t('dod5-accounting: STOP latches admissions before aborts; it is not a budget reason; the latch never reopens', () => {
  const acc = make({ calls: 10, maxInFlight: 10 });
  const id = admitOk(acc);
  acc.stop();
  const state = acc.snapshot();
  assert.equal(state.latched, true);
  assert.equal(state.stopped, true);
  assert.equal(state.reason, null);
  assert.deepEqual(acc.admit(0), { ok: false, code: null }, 'a stopped sidecar admits nothing; the refusal has no budget code');
  acc.finish(id, { complete: true, status: 200, usage: usage(1, 1) });
  assert.deepEqual(acc.admit(0), { ok: false, code: null });
  assert.equal(acc.pendingLimit(), null, 'STOP alone prints no limit event');
});

t('dod5-accounting: the first latched limit is reported exactly once (pendingLimit), whether or not a refusal happened', () => {
  const acc = make({ calls: 1, maxInFlight: 10 });
  admitOk(acc);
  assert.equal(acc.pendingLimit(), 'calls', 'pending before any refusal (abort after the L-th admission)');
  assert.equal(acc.pendingLimit(), null, 'reported once');
  refusedWith(acc, 'acoder_budget_calls');
  assert.equal(acc.pendingLimit(), null);
  const other = make({ calls: 10, maxInFlight: 10 });
  other.finish(admitOk(other), { complete: false, status: null, usage: null });
  assert.equal(other.pendingLimit(), 'usage_unreported');
  assert.equal(other.pendingLimit(), null);
});

t('dod5-accounting: abort after the L-th admission and before any refusal: one calls limit, lower-bound counts, no usage_unreported', () => {
  const acc = make({ calls: 2, maxInFlight: 10 });
  const a = admitOk(acc);
  const b = admitOk(acc);
  acc.finish(a, { complete: false, status: 200, usage: null });
  acc.finish(b, { complete: false, status: null, usage: null });
  const state = acc.snapshot();
  assert.equal(state.reason, 'calls');
  assert.equal(state.usage_missing, 2);
  assert.equal(state.tokens_lower_bound, true);
  assert.equal(acc.pendingLimit(), 'calls');
  assert.equal(acc.pendingLimit(), null);
});

t('dod5-accounting: token total reaching its limit before any refusal latches; a later abort without usage is a lower bound only', () => {
  const acc = make({ calls: 10, tokens: 10, maxInFlight: 10 });
  const a = admitOk(acc);
  const b = admitOk(acc);
  acc.finish(a, { complete: true, status: 200, usage: usage(6, 4) });
  acc.finish(b, { complete: false, status: 200, usage: null });
  assert.equal(acc.snapshot().reason, 'tokens');
  assert.equal(acc.snapshot().usage_missing, 1);
  assert.equal(acc.snapshot().tokens_lower_bound, true);
  assert.equal(acc.snapshot().admitted_after_token_limit, 0);
  assert.equal(acc.pendingLimit(), 'tokens');
});

t('dod5-accounting: malformed usage counts as missing; finish of an unknown or finished request throws', () => {
  const acc = make({ calls: 10, tokens: null, maxInFlight: 10 });
  for (const bad of [{ input: 1, output: -1, reasoning: 0, cached_input: 0 }, { input: 1, output: 1 }, { input: '1', output: 1, reasoning: 0, cached_input: 0 }, 5, []]) {
    acc.finish(admitOk(acc), { complete: true, status: 200, usage: bad });
  }
  assert.equal(acc.snapshot().usage_missing, 5);
  assert.equal(acc.snapshot().tokens.total, 0);
  const id = admitOk(acc);
  acc.finish(id, { complete: true, status: 200, usage: usage(1, 1) });
  assert.notEqual(thrownOf(() => acc.finish(id, { complete: true, status: 200, usage: usage(1, 1) })), null, 'a second finish');
  assert.notEqual(thrownOf(() => acc.finish(999, { complete: true, status: 200, usage: null })), null, 'an unknown id');
  assert.equal(acc.snapshot().tokens.total, 2);
});

t('dod5-accounting: the module is pure (imports nothing)', async () => {
  const fs = await import('node:fs');
  const text = fs.readFileSync(new URL('../container/accounting.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /^\s*import\s/m);
  assert.doesNotMatch(text, /Date\.now|process\.|setTimeout|setInterval/);
});
