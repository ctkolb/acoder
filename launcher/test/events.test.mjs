import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { FATAL_CODES, REASON_CODES, createClockProtocol, isClockSample, parseEventLine, parseSupervisorLine, sanitizeModel, validateEvent } from '../lib/events.mjs';
import { must, thrownOf } from './helpers/fixtures.mjs';
import { changed, nodes, wrongTypeOf } from './helpers/schema-walk.mjs';

// G11: every test has a finite time limit of its own. The test is registered from this file, so that the mutation runner can count it per module.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, fn);

const HOST = 'models.example.org';
const OPTIONS = { allowlist: [HOST] };
const HEX64 = 'a'.repeat(64);
const SIDECAR = {
  ready: { event: 'ready', config_sha256: HEX64, env_names: ['ACODER_RUN_ID', 'ACODER_UPSTREAM_KEY'], clock_epoch_ms: 1760000000000 },
  clock: { event: 'clock', clock_epoch_ms: 1760000000001 },
  upstream: { event: 'upstream', host: HOST, handshake: 'ok', address: '203.0.113.7' },
  phase: { event: 'phase', phase: 'agent' },
  request: {
    event: 'request', seq: 3, phase: 'agent', opened: '2026-11-12T10:15:01.000Z', closed: '2026-11-12T10:15:02.500Z', host: HOST, decision: 'forwarded', reason: null, status: 200, complete: true,
    bytes_up: 10, bytes_down: 20, usage: { input: 1, output: 2, reasoning: 0, cached_input: 0 }, response_model: 'gpt-6-luna', probe: null,
  },
  limit: { event: 'limit', kind: 'calls' },
  summary: {
    event: 'summary', forwarded: 2, refused_probe: 1, refused_agent: 3, refused_by_reason: { acoder_path_not_allowed: 3 }, bytes_up: 10, bytes_down: 20, key_reflections: 0, usage_missing: 0,
    admitted_after_token_limit: 0, in_flight_at_limit: null, tokens: { input: 1, output: 2, reasoning: 0, cached_input: 0, total: 3 },
  },
  fatal: { event: 'fatal', code: 'internal_error' },
};
const SUPERVISOR = {
  clock: { event: 'clock', clock_epoch_ms: 1760000000002 },
  probes: { event: 'probes', results: [{ id: 'P1', result: 'pass', detail: null }, { id: 'U1', result: 'fail', detail: 'unexpected_env_name' }] },
  released: { event: 'released' },
  agent_started: { event: 'agent_started', pid: 42 },
  agent_exit: { event: 'agent_exit', code: 0, signal: null },
  deadline: { event: 'deadline' },
};
const NULLABLE = new Set([
  'request.host', 'request.reason', 'request.status', 'request.usage', 'request.response_model', 'request.probe', 'upstream.address', 'summary.in_flight_at_limit', 'summary.tokens',
  'agent_exit.code', 'agent_exit.signal', 'probes.results.*.detail',
]);
const OPEN = new Set(['summary.refused_by_reason']);
const problems = (source, value, options = OPTIONS) => must(() => validateEvent(source, value, options));
const mentions = (list, text) => list.some(problem => problem.includes(text));
const SOURCES = { sidecar: SIDECAR, supervisor: SUPERVISOR };

t('spec03-metadata (event part): every event of A3.5 is accepted as printed, and an unknown event or one of the other program is rejected', () => {
  for (const [source, samples] of Object.entries(SOURCES)) {
    for (const [name, sample] of Object.entries(samples)) assert.deepEqual(problems(source, sample), [], `${source} ${name}`);
  }
  assert.ok(problems('sidecar', { event: 'nope' }).length > 0);
  assert.ok(problems('supervisor', { event: 'nope' }).length > 0);
  for (const name of ['ready', 'upstream', 'phase', 'request', 'limit', 'summary', 'fatal']) assert.ok(problems('supervisor', SIDECAR[name]).length > 0, `${name} is not a supervisor event`);
  for (const name of ['probes', 'released', 'agent_started', 'agent_exit', 'deadline']) assert.ok(problems('sidecar', SUPERVISOR[name]).length > 0, `${name} is not a sidecar event`);
  for (const bad of [null, [], 'text', 7, {}, { event: 7 }, { event: ['clock'] }, { event: '__proto__' }, { event: 'constructor' }]) {
    for (const source of ['sidecar', 'supervisor']) assert.ok(problems(source, bad).length > 0, `${source}: ${JSON.stringify(bad)}`);
  }
  assert.ok(thrownOrNot(() => validateEvent('other', SIDECAR.clock, OPTIONS)), 'an unknown source is an error');
});
const thrownOrNot = fn => { try { return fn().length > 0; } catch { return true; } };

t('spec03-metadata (event part): a missing field, a wrong type, a null that is not allowed and an unknown field are each rejected, for every event', () => {
  for (const [source, samples] of Object.entries(SOURCES)) {
    for (const [name, sample] of Object.entries(samples)) {
      for (const { parts, dotted, wild, node } of nodes(sample)) {
        const where = `${source} ${name} ${dotted}`;
        const topKey = `${name}.${wild}`;
        const insideOpen = [...OPEN].some(open => topKey.startsWith(`${open}.`));
        const holder = parts.slice(0, -1).reduce((value, key) => value[key], sample);
        if (!insideOpen && !Array.isArray(holder)) {
          const gone = problems(source, changed(sample, parts, (parent, key) => { delete parent[key]; }));
          assert.ok(gone.length > 0 && mentions(gone, String(parts.at(-1))), `missing: ${where}: ${JSON.stringify(gone)}`);
        }
        const wrong = problems(source, changed(sample, parts, (parent, key) => { parent[key] = wrongTypeOf(node); }));
        assert.ok(wrong.length > 0, `wrong type: ${where}`);
        const nulled = problems(source, changed(sample, parts, (parent, key) => { parent[key] = null; }));
        if (NULLABLE.has(topKey) || node === null) assert.deepEqual(nulled, [], `null is allowed: ${where}`);
        else assert.ok(nulled.length > 0, `null: ${where}`);
        if (node !== null && typeof node === 'object' && !Array.isArray(node) && !OPEN.has(topKey)) {
          assert.ok(problems(source, changed(sample, parts, (parent, key) => { parent[key] = { ...node, zz_extra: 1 }; })).length > 0, `unknown field inside: ${where}`);
        }
      }
      assert.ok(mentions(problems(source, { ...sample, zz_extra: 1 }), 'zz_extra'), `unknown field: ${source} ${name}`);
      const { event, ...rest } = sample;
      assert.ok(problems(source, rest).length > 0, `no event name: ${source} ${name}`);
    }
  }
});

t('spec03-metadata (event part): a host that is not in the allowlist, a reason outside the fixed codes and the cross-field rules of a request', () => {
  const request = overrides => ({ ...SIDECAR.request, ...overrides });
  assert.deepEqual(problems('sidecar', request({ host: HOST }), { allowlist: [HOST, 'other.example.org'] }), []);
  assert.ok(mentions(problems('sidecar', request({ host: 'evil.example.org' })), 'host'), 'a host outside the allowlist');
  assert.ok(mentions(problems('sidecar', request({ host: HOST.toUpperCase() })), 'host'), 'the match is exact');
  assert.ok(mentions(problems('sidecar', request({ host: HOST }), { allowlist: [] }), 'host'), 'an empty allowlist allows no host');
  assert.ok(mentions(problems('sidecar', request({ host: `${HOST}:443` })), 'host'), 'no port');
  assert.ok(mentions(problems('sidecar', SIDECAR.upstream, { allowlist: [] }), 'host'));
  assert.ok(mentions(problems('sidecar', { ...SIDECAR.upstream, host: 'evil.example.org' }), 'host'));
  assert.ok(mentions(problems('sidecar', { ...SIDECAR.upstream, host: null }), 'host'), 'an upstream event names a host');
  const refused = overrides => request({ decision: 'refused', status: 429, complete: true, host: HOST, reason: 'acoder_budget_calls', ...overrides });
  assert.ok(REASON_CODES.length >= 8 && new Set(REASON_CODES).size === REASON_CODES.length);
  for (const code of ['acoder_not_released', 'acoder_host_not_allowed', 'acoder_path_not_allowed', 'acoder_budget_wall_clock', 'acoder_budget_calls', 'acoder_budget_tokens', 'acoder_in_flight', 'acoder_usage_unreported', 'acoder_upstream_encoding']) {
    assert.ok(REASON_CODES.includes(code), code);
  }
  for (const code of REASON_CODES) assert.deepEqual(problems('sidecar', refused({ reason: code })), [], code);
  for (const bad of ['bogus', 'ACODER_BUDGET_CALLS', '', 'acoder_budget_calls ', 7]) assert.ok(mentions(problems('sidecar', refused({ reason: bad })), 'reason'), String(bad));
  assert.ok(mentions(problems('sidecar', refused({ reason: null })), 'reason'), 'a refusal has a reason');
  assert.ok(mentions(problems('sidecar', request({ reason: 'acoder_budget_calls' })), 'reason'), 'a forwarded request has no reason');
  assert.ok(mentions(problems('sidecar', request({ decision: 'local', host: null, reason: 'acoder_budget_calls' })), 'reason'));
  assert.deepEqual(problems('sidecar', request({ decision: 'local', host: null, status: 200 })), []);
  assert.deepEqual(problems('sidecar', refused({ host: null })), []);
  for (const bad of ['maybe', 'Forwarded', null]) assert.ok(mentions(problems('sidecar', request({ decision: bad })), 'decision'), String(bad));
  for (const bad of [99, 600, 200.5, -1, '200']) assert.ok(mentions(problems('sidecar', request({ status: bad })), 'status'), String(bad));
  for (const good of [100, 599]) assert.deepEqual(problems('sidecar', request({ status: good })), []);
  for (const bad of ['agentx', 'PROBE', null, 7]) assert.ok(mentions(problems('sidecar', request({ phase: bad })), 'phase'));
  for (const bad of [-1, 1.5, 2 ** 53, '1']) for (const field of ['seq', 'bytes_up', 'bytes_down']) assert.ok(mentions(problems('sidecar', request({ [field]: bad })), field), `${field} ${bad}`);
  for (const bad of ['2026-11-12 10:15:01Z', '2026-11-12T10:15:01+00:00', '2026-13-12T10:15:01Z', '2026-11-12T10:15:01', 'yesterday', 7]) {
    assert.ok(mentions(problems('sidecar', request({ opened: bad })), 'opened'), String(bad));
    assert.ok(mentions(problems('sidecar', request({ closed: bad })), 'closed'), String(bad));
  }
  assert.deepEqual(problems('sidecar', request({ opened: '2026-11-12T10:15:01Z' })), []);
  // The one probe token: 32 hex characters and only in phase probe.
  const probe = 'f'.repeat(32);
  assert.deepEqual(problems('sidecar', request({ phase: 'probe', probe })), []);
  assert.ok(mentions(problems('sidecar', request({ phase: 'agent', probe })), 'probe'), 'in phase agent the probe is always null');
  for (const bad of ['f'.repeat(31), 'F'.repeat(32), 'g'.repeat(32), 'f'.repeat(33), 7]) assert.ok(mentions(problems('sidecar', request({ phase: 'probe', probe: bad })), 'probe'), String(bad));
  // Usage has exactly four counters.
  for (const bad of [{ input: 1, output: 2, reasoning: 0 }, { input: 1, output: 2, reasoning: 0, cached_input: -1 }, { input: 1, output: 2, reasoning: 0, cached_input: 0, total: 3 }, 5]) {
    assert.ok(mentions(problems('sidecar', request({ usage: bad })), 'usage'), JSON.stringify(bad));
  }
  // The response model is sanitized text: printable ASCII, at most 64 characters.
  for (const good of ['gpt-6-luna', 'a'.repeat(64), ' ']) assert.deepEqual(problems('sidecar', request({ response_model: good })), [], good);
  for (const bad of ['a'.repeat(65), 'é', 'tab\there', 'line\nbreak', '', 7]) assert.ok(mentions(problems('sidecar', request({ response_model: bad })), 'response_model'), JSON.stringify(bad));
});

t('spec03-metadata (event part): fixed vocabularies of the other events, and the model sanitizer', () => {
  for (const kind of ['wall_clock', 'calls', 'tokens', 'usage_unreported']) assert.deepEqual(problems('sidecar', { event: 'limit', kind }), [], kind);
  for (const bad of ['disk', 'memory', 'Calls', null]) assert.ok(mentions(problems('sidecar', { event: 'limit', kind: bad }), 'kind'), String(bad));
  assert.ok(FATAL_CODES.length >= 3 && new Set(FATAL_CODES).size === FATAL_CODES.length);
  for (const code of FATAL_CODES) assert.deepEqual(problems('sidecar', { event: 'fatal', code }), [], code);
  for (const bad of ['Error: connect ECONNREFUSED', 'stack at x', '', null, 'internal error']) assert.ok(mentions(problems('sidecar', { event: 'fatal', code: bad }), 'code'), String(bad));
  assert.ok(problems('sidecar', { event: 'fatal', code: 'internal_error', message: 'x' }).length > 0, 'a fatal event carries a code only, never a message');
  for (const phase of ['probe', 'agent']) assert.deepEqual(problems('sidecar', { event: 'phase', phase }), [], phase);
  assert.ok(mentions(problems('sidecar', { event: 'phase', phase: 'done' }), 'phase'));
  for (const handshake of ['ok', 'failed']) assert.deepEqual(problems('sidecar', { ...SIDECAR.upstream, handshake }), [], handshake);
  assert.ok(mentions(problems('sidecar', { ...SIDECAR.upstream, handshake: 'maybe' }), 'handshake'));
  for (const address of ['203.0.113.7', '2001:db8::1', null]) assert.deepEqual(problems('sidecar', { ...SIDECAR.upstream, address }), [], String(address));
  for (const bad of ['models.example.org', '999.1.1.1', '', 7]) assert.ok(mentions(problems('sidecar', { ...SIDECAR.upstream, address: bad }), 'address'), String(bad));
  for (const bad of ['a'.repeat(63), 'A'.repeat(64), 7]) assert.ok(mentions(problems('sidecar', { ...SIDECAR.ready, config_sha256: bad }), 'config_sha256'));
  for (const bad of [['lower_case'], ['A B'], [7], 'ACODER_RUN_ID', ['']]) assert.ok(mentions(problems('sidecar', { ...SIDECAR.ready, env_names: bad }), 'env_names'), JSON.stringify(bad));
  assert.deepEqual(problems('sidecar', { ...SIDECAR.ready, env_names: [] }), []);
  for (const bad of ['P0', 'P9', 'p1', 'X1', 7]) assert.ok(mentions(problems('supervisor', { ...SUPERVISOR.probes, results: [{ id: bad, result: 'pass', detail: null }] }), 'id'), String(bad));
  for (const bad of ['ok', 'PASS', null]) assert.ok(mentions(problems('supervisor', { ...SUPERVISOR.probes, results: [{ id: 'P1', result: bad, detail: null }] }), 'result'), String(bad));
  for (const bad of ['Has Space', 'x'.repeat(65), '', 7]) assert.ok(mentions(problems('supervisor', { ...SUPERVISOR.probes, results: [{ id: 'P1', result: 'fail', detail: bad }] }), 'detail'), String(bad));
  assert.deepEqual(problems('supervisor', { ...SUPERVISOR.probes, results: [] }), []);
  for (const bad of [0, -1, 1.5, '42']) assert.ok(mentions(problems('supervisor', { ...SUPERVISOR.agent_started, pid: bad }), 'pid'), String(bad));
  for (const bad of [-1, 1.5, '0']) assert.ok(mentions(problems('supervisor', { ...SUPERVISOR.agent_exit, code: bad }), 'code'), String(bad));
  for (const good of ['SIGTERM', 'SIGKILL', null]) assert.deepEqual(problems('supervisor', { ...SUPERVISOR.agent_exit, code: null, signal: good }), [], String(good));
  for (const bad of ['sigterm', 'TERM', '', 9]) assert.ok(mentions(problems('supervisor', { ...SUPERVISOR.agent_exit, signal: bad }), 'signal'), String(bad));
  for (const bad of [-1, 1.5, '3', 2 ** 53]) assert.ok(mentions(problems('sidecar', { ...SIDECAR.summary, forwarded: bad }), 'forwarded'), String(bad));
  assert.ok(mentions(problems('sidecar', { ...SIDECAR.summary, refused_by_reason: { x: -1 } }), 'refused_by_reason'));
  assert.ok(mentions(problems('sidecar', { ...SIDECAR.summary, refused_by_reason: { 'not a code': 1 } }), 'refused_by_reason'));
  assert.ok(mentions(problems('sidecar', { ...SIDECAR.summary, refused_by_reason: { acoder_budget_calls: 1.5 } }), 'refused_by_reason'));
  assert.deepEqual(must(() => sanitizeModel('gpt-6-luna')), 'gpt-6-luna');
  assert.equal(must(() => sanitizeModel('é\tmodel\n')), '??model?');
  assert.equal(must(() => sanitizeModel('x'.repeat(100))), 'x'.repeat(64));
  assert.equal(must(() => sanitizeModel(null)), null);
  assert.equal(must(() => sanitizeModel(7)), null);
  assert.equal(must(() => sanitizeModel('')), null);
  assert.equal(must(() => sanitizeModel('\u0000\u0001')), '??');
});

t('spec03-metadata (event part): an event line is one JSON object of at most 1 MiB, and a supervisor line carries the per-run prefix', () => {
  const line = JSON.stringify(SIDECAR.clock);
  assert.deepEqual(must(() => parseEventLine('sidecar', line, OPTIONS)), { ok: true, event: SIDECAR.clock });
  assert.deepEqual(must(() => parseEventLine('sidecar', `  ${line}  `, OPTIONS)), { ok: true, event: SIDECAR.clock });
  for (const bad of ['', 'not json', '[1]', '"x"', '7', 'null', '{"event":"clock"', JSON.stringify({ event: 'clock' }), JSON.stringify({ ...SIDECAR.clock, extra: 1 })]) {
    const result = must(() => parseEventLine('sidecar', bad, OPTIONS));
    assert.equal(result.ok, false, bad);
    assert.equal(typeof result.problem, 'string', bad);
    assert.ok(!result.problem.includes('not json') || bad === '', 'the problem does not echo the line');
  }
  const long = JSON.stringify({ ...SIDECAR.fatal, code: 'x'.repeat(1048576) });
  assert.equal(must(() => parseEventLine('sidecar', long, OPTIONS)).ok, false, 'a line over 1 MiB is rejected');
  assert.equal(must(() => parseEventLine('supervisor', JSON.stringify(SUPERVISOR.released), OPTIONS)).ok, true);
  assert.equal(must(() => parseEventLine('supervisor', JSON.stringify(SIDECAR.phase), OPTIONS)).ok, false);
  const prefix = 'c'.repeat(32);
  const before = { prefix, agentStarted: false };
  const after = { prefix, agentStarted: true };
  const prefixed = event => `${prefix} ${JSON.stringify(event)}`;
  for (const [name, event] of Object.entries(SUPERVISOR)) assert.deepEqual(must(() => parseSupervisorLine(prefixed(event), before)), { kind: 'event', event }, name);
  assert.deepEqual(must(() => parseSupervisorLine('plain agent output', before)), { kind: 'agent_output' });
  assert.deepEqual(must(() => parseSupervisorLine(JSON.stringify(SUPERVISOR.released), before)), { kind: 'agent_output' }, 'an unprefixed JSON line is not an event');
  assert.deepEqual(must(() => parseSupervisorLine(`x${prefixed(SUPERVISOR.released)}`, before)), { kind: 'agent_output' }, 'the prefix is at the start');
  assert.deepEqual(must(() => parseSupervisorLine(`${prefix}${JSON.stringify(SUPERVISOR.released)}`, before)), { kind: 'agent_output' }, 'the prefix is followed by one space');
  assert.equal(must(() => parseSupervisorLine(`${'d'.repeat(32)} ${JSON.stringify(SUPERVISOR.released)}`, before)).kind, 'agent_output', 'another prefix is not ours');
  for (const bad of [`${prefix} not json`, `${prefix} {"event":"nope"}`, `${prefix} ${JSON.stringify({ ...SUPERVISOR.released, extra: 1 })}`, `${prefix} ${JSON.stringify(SIDECAR.phase)}`]) {
    const result = must(() => parseSupervisorLine(bad, before));
    assert.equal(result.kind, 'invalid', bad);
    assert.equal(typeof result.problem, 'string');
  }
  // After agent_started only agent_exit and deadline are events; every other line is agent output.
  for (const name of ['agent_exit', 'deadline']) assert.deepEqual(must(() => parseSupervisorLine(prefixed(SUPERVISOR[name]), after)), { kind: 'event', event: SUPERVISOR[name] }, name);
  for (const name of ['clock', 'probes', 'released', 'agent_started']) assert.deepEqual(must(() => parseSupervisorLine(prefixed(SUPERVISOR[name]), after)), { kind: 'agent_output' }, `${name} after the start is a hint, not an event`);
  assert.deepEqual(must(() => parseSupervisorLine('plain', after)), { kind: 'agent_output' });
  assert.deepEqual(must(() => parseSupervisorLine(`${prefix} garbage`, after)), { kind: 'agent_output' }, 'after the start nothing prefixed is a protocol error');
  for (const badPrefix of ['short', 'G'.repeat(32), 'c'.repeat(33), '']) assert.notEqual(thrownOf(() => parseSupervisorLine('x', { prefix: badPrefix, agentStarted: false })), null, `prefix ${badPrefix}`);
});

t('clock-events: a clock sample is an unsigned safe integer', () => {
  for (const good of [0, 1, 1760000000000, Number.MAX_SAFE_INTEGER]) assert.equal(must(() => isClockSample(good)), true, String(good));
  for (const bad of [-1, 1.5, '5', 2 ** 53, Number.NaN, Infinity, -Infinity, null, undefined, true, {}, [], 1e400, -0.5]) assert.equal(must(() => isClockSample(bad)), false, String(bad));
  const bads = [undefined, null, '5', 1.5, -1, 2 ** 53, Number.MAX_SAFE_INTEGER + 2, true, [], {}];
  const events = { sidecar: [SIDECAR.ready, SIDECAR.clock], supervisor: [SUPERVISOR.clock] };
  for (const [source, list] of Object.entries(events)) for (const sample of list) for (const bad of bads) {
    const value = { ...sample };
    if (bad === undefined) delete value.clock_epoch_ms; else value.clock_epoch_ms = bad;
    assert.ok(mentions(problems(source, value), 'clock_epoch_ms'), `${source} ${sample.event} ${String(bad)}`);
  }
  const unknown = { ...SIDECAR.clock, other: 1 };
  assert.ok(mentions(problems('sidecar', unknown), 'other'));
  for (const good of [0, 5, Number.MAX_SAFE_INTEGER]) assert.deepEqual(problems('sidecar', { ...SIDECAR.clock, clock_epoch_ms: good }), [], String(good));
});

t('clock-events: the protocol accepts exactly one requested reply per container and fails on a duplicate, an unrequested, an invalid or a repeated request', () => {
  const clock = (source, value) => ({ event: 'clock', clock_epoch_ms: value, ...(source ? {} : {}) });
  const fresh = () => must(() => createClockProtocol());
  let protocol = fresh();
  assert.equal(must(() => protocol.complete()), false, 'nothing requested yet');
  assert.deepEqual(must(() => protocol.request('egress')), { ok: true });
  assert.equal(protocol.complete(), false);
  assert.deepEqual(must(() => protocol.request('agent')), { ok: true });
  assert.equal(protocol.complete(), false, 'no reply yet');
  assert.deepEqual(must(() => protocol.accept('egress', clock(null, 1000))), { ok: true });
  assert.equal(protocol.complete(), false, 'one reply of two');
  assert.deepEqual(must(() => protocol.accept('agent', clock(null, 1005))), { ok: true });
  assert.equal(protocol.complete(), true);
  assert.equal(protocol.failed(), false);
  assert.deepEqual(protocol.samples(), { egress: 1000, agent: 1005 });
  assert.equal(must(() => protocol.accept('agent', clock(null, 1006))).ok, false, 'a duplicate reply');
  assert.equal(protocol.failed(), true, 'a duplicate fails the protocol for good');
  assert.equal(protocol.complete(), false, 'a failed protocol is never complete');
  // A reply nobody asked for.
  protocol = fresh();
  assert.deepEqual(must(() => protocol.accept('egress', clock(null, 1))), { ok: false, problem: 'unrequested' });
  assert.equal(protocol.failed(), true);
  protocol = fresh();
  protocol.request('egress');
  assert.equal(must(() => protocol.accept('agent', clock(null, 1))).problem, 'unrequested', 'the other container was not asked');
  // An invalid reply fails the protocol; a valid one afterwards does not repair it.
  for (const bad of [{ event: 'clock' }, { event: 'clock', clock_epoch_ms: '5' }, { event: 'clock', clock_epoch_ms: 1.5 }, { event: 'clock', clock_epoch_ms: -1 }, { event: 'clock', clock_epoch_ms: 2 ** 53 }, { event: 'clock', clock_epoch_ms: 1, extra: 1 }, { event: 'released' }]) {
    protocol = fresh();
    protocol.request('egress');
    protocol.request('agent');
    const result = must(() => protocol.accept('egress', bad));
    assert.deepEqual(result, { ok: false, problem: 'invalid' }, JSON.stringify(bad));
    assert.equal(protocol.failed(), true);
    protocol.accept('egress', clock(null, 5));
    protocol.accept('agent', clock(null, 6));
    assert.equal(protocol.complete(), false, JSON.stringify(bad));
  }
  // The sidecar's reply is a sidecar event and the supervisor's a supervisor event.
  protocol = fresh();
  protocol.request('egress');
  protocol.request('agent');
  assert.equal(must(() => protocol.accept('agent', { event: 'ready', config_sha256: HEX64, env_names: [], clock_epoch_ms: 1 })).ok, false, 'a ready event is not a clock reply');
  // CLOCK is sent once per container: a repeated request, an unknown container and a late request are refused.
  protocol = fresh();
  protocol.request('egress');
  assert.equal(must(() => protocol.request('egress')).ok, false, 'a repeated request');
  assert.equal(protocol.failed(), true);
  protocol = fresh();
  assert.equal(must(() => protocol.request('proxy')).ok, false, 'an unknown container');
  assert.equal(must(() => protocol.accept('proxy', clock(null, 1))).ok, false);
  // Both containers must have been requested: one container alone is never complete.
  protocol = fresh();
  protocol.request('egress');
  protocol.accept('egress', clock(null, 1));
  assert.equal(protocol.complete(), false, 'only one container was asked');
  protocol = fresh();
  protocol.request('egress');
  protocol.request('agent');
  protocol.accept('agent', clock(null, 1));
  protocol.accept('egress', clock(null, 1));
  assert.equal(protocol.complete(), true, 'the order of the replies does not matter');
  assert.deepEqual(protocol.samples(), { egress: 1, agent: 1 });
  assert.deepEqual(fresh().samples(), { egress: null, agent: null });
});
