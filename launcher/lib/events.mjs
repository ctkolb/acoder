// Schema validation of the event lines the sidecar and the supervisor print (A3.5), the clock protocol, and the small validator
// combinators that record.mjs reuses. A problem never echoes a value: a line may hold text that came from outside.
import net from 'node:net';

const MAX_LINE = 1048576;
const MAX_MODEL = 64;
const CLOCK_CONTAINERS = ['egress', 'agent'];

// Fixed words. The reason codes are the refusals of A3.2; the fatal codes are the only text a failing sidecar prints (A8.5).
export const REASON_CODES = [
  'acoder_not_released', 'acoder_host_not_allowed', 'acoder_path_not_allowed', 'acoder_method_not_allowed', 'acoder_body_too_large', 'acoder_budget_wall_clock', 'acoder_budget_calls',
  'acoder_budget_tokens', 'acoder_in_flight', 'acoder_usage_unreported', 'acoder_upstream_encoding', 'acoder_upstream_error',
];
export const FATAL_CODES = ['internal_error', 'config_invalid', 'listen_failed', 'socket_error', 'upstream_failed'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isInt = value => Number.isSafeInteger(value) && value >= 0;
export const isClockSample = isInt;

// A problem is {path: [...], message}; a validator returns a list of them.
const bad = message => [{ path: [], message }];
const nest = (key, list) => list.map(problem => ({ path: [key, ...problem.path], message: problem.message }));
const fail = (ok, message) => (ok ? [] : bad(message));

export const types = {
  int: value => fail(isInt(value), 'must be a non-negative integer'),
  number: value => fail(typeof value === 'number' && Number.isFinite(value) && value >= 0, 'must be a non-negative number'),
  str: value => fail(typeof value === 'string', 'must be a string'),
  bool: value => fail(typeof value === 'boolean', 'must be a boolean'),
  literal: expected => value => fail(value === expected, `must be ${JSON.stringify(expected)}`),
  oneOf: list => value => fail(list.includes(value), 'is not one of the allowed values'),
  pattern: (regex, message) => value => fail(typeof value === 'string' && regex.test(value), message),
  nullable: inner => value => (value === null ? [] : inner(value)),
  listOf: inner => value => (Array.isArray(value) ? value.flatMap((item, index) => nest(index, inner(item))) : bad('must be a list')),
  mapOf: (keyOk, keyMessage, inner) => value => {
    if (!isObject(value)) return bad('must be an object');
    return Object.entries(value).flatMap(([key, item]) => (keyOk(key) ? nest(key, inner(item)) : bad(keyMessage)));
  },
  // spec: {field: validator}; every field is required and no other field is allowed. check(value) adds problems that need several fields.
  object: (spec, check = () => []) => value => {
    if (!isObject(value)) return bad('must be an object');
    const problems = [];
    for (const key of Object.keys(value)) if (!Object.hasOwn(spec, key)) problems.push(...nest(key, bad('unknown field')));
    for (const [key, validator] of Object.entries(spec)) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) problems.push(...nest(key, bad('missing')));
      else problems.push(...nest(key, validator(value[key])));
    }
    return problems.length > 0 ? problems : check(value);
  },
};

export const formatProblems = problems => problems.map(({ path, message }) => `${path.join('.')}${path.length > 0 ? ': ' : ''}${message}`);

const HEX64 = /^[0-9a-f]{64}$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;
export const rfc3339 = value => {
  const match = typeof value === 'string' ? RFC3339.exec(value) : null;
  return fail(match !== null && !Number.isNaN(Date.parse(value)) && new Date(value).getUTCDate() === Number(match[3]), 'must be an RFC 3339 UTC time');
};
export const printable = value => fail(typeof value === 'string' && /^[\x20-\x7e]{1,64}$/.test(value), 'must be printable ASCII of 1 to 64 characters');
export const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function sanitizeModel(text) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(/[^\x20-\x7e]/g, '?').slice(0, MAX_MODEL);
  return clean === '' ? null : clean;
}

const { int, nullable, listOf, object, literal, oneOf, pattern } = types;
const sample = int;
const usage4 = object({ input: int, output: int, reasoning: int, cached_input: int });

function sidecarSpecs({ allowlist }) {
  const host = value => fail(typeof value === 'string' && allowlist.includes(value), 'is not in the allowlist');
  const request = object({
    event: literal('request'), seq: int, phase: oneOf(['probe', 'agent']), opened: rfc3339, closed: rfc3339, host: nullable(host), decision: oneOf(['forwarded', 'refused', 'local']),
    reason: nullable(oneOf(REASON_CODES)), status: nullable(value => fail(Number.isInteger(value) && value >= 100 && value <= 599, 'must be an HTTP status')), complete: types.bool,
    bytes_up: int, bytes_down: int, usage: nullable(usage4), response_model: nullable(printable), probe: nullable(pattern(/^[0-9a-f]{32}$/, 'must be 32 lower-case hex characters')),
  }, value => [
    ...(value.decision === 'refused' && value.reason === null ? nest('reason', bad('a refusal has a reason')) : []),
    ...(value.decision !== 'refused' && value.reason !== null ? nest('reason', bad('only a refusal has a reason')) : []),
    ...(value.phase === 'agent' && value.probe !== null ? nest('probe', bad('is null in phase agent')) : []),
  ]);
  return {
    ready: object({ event: literal('ready'), config_sha256: pattern(HEX64, 'must be 64 lower-case hex characters'), env_names: listOf(pattern(/^[A-Z_][A-Z0-9_]*$/, 'must be an environment variable name')), clock_epoch_ms: sample }),
    clock: object({ event: literal('clock'), clock_epoch_ms: sample }),
    upstream: object({ event: literal('upstream'), host, handshake: oneOf(['ok', 'failed']), address: nullable(value => fail(typeof value === 'string' && net.isIP(value) !== 0, 'must be an IP address')) }),
    phase: object({ event: literal('phase'), phase: oneOf(['probe', 'agent']) }),
    request,
    limit: object({ event: literal('limit'), kind: oneOf(['wall_clock', 'calls', 'tokens', 'usage_unreported']) }),
    summary: object({
      event: literal('summary'), forwarded: int, refused_probe: int, refused_agent: int, refused_by_reason: types.mapOf(key => CODE_PATTERN.test(key), 'a key is not a fixed code', int), bytes_up: int, bytes_down: int,
      key_reflections: int, usage_missing: int, admitted_after_token_limit: int, in_flight_at_limit: nullable(int), tokens: nullable(object({ input: int, output: int, reasoning: int, cached_input: int, total: int })),
    }),
    fatal: object({ event: literal('fatal'), code: oneOf(FATAL_CODES) }),
  };
}

const SUPERVISOR_SPECS = {
  clock: object({ event: literal('clock'), clock_epoch_ms: sample }),
  probes: object({
    event: literal('probes'),
    results: listOf(object({ id: pattern(/^(?:P[1-8]|U1)$/, 'must be a probe id'), result: oneOf(['pass', 'fail', 'not_run']), detail: nullable(pattern(CODE_PATTERN, 'must be a fixed code')) })),
  }),
  released: object({ event: literal('released') }),
  agent_started: object({ event: literal('agent_started'), pid: value => fail(Number.isSafeInteger(value) && value > 0, 'must be a positive integer') }),
  agent_exit: object({ event: literal('agent_exit'), code: nullable(int), signal: nullable(pattern(/^SIG[A-Z0-9]+$/, 'must be a signal name')) }),
  deadline: object({ event: literal('deadline') }),
};

export function validateEvent(source, value, { allowlist = [] } = {}) {
  let specs;
  if (source === 'sidecar') specs = sidecarSpecs({ allowlist });
  else if (source === 'supervisor') specs = SUPERVISOR_SPECS;
  else throw new Error('unknown event source');
  if (!isObject(value)) return ['event: must be an object'];
  if (typeof value.event !== 'string' || !Object.hasOwn(specs, value.event)) return ['event: unknown event'];
  return formatProblems(specs[value.event](value));
}

export function parseEventLine(source, line, options = {}) {
  if (typeof line !== 'string' || line.length > MAX_LINE) return { ok: false, problem: 'the line is not text of at most 1 MiB' };
  let value;
  try { value = JSON.parse(line); } catch { return { ok: false, problem: 'the line is not JSON' }; }
  const problems = validateEvent(source, value, options);
  return problems.length > 0 ? { ok: false, problem: problems[0] } : { ok: true, event: value };
}

const AFTER_START = new Set(['agent_exit', 'deadline']);

// A supervisor event line is `<prefix> <JSON>` (A3.5). Before agent_started a prefixed line must be a valid supervisor event; after it only
// agent_exit and deadline are events and everything else is the agent's own output (a prefixed line is then only a hint).
export function parseSupervisorLine(line, { prefix, agentStarted }) {
  if (typeof prefix !== 'string' || !/^[0-9a-f]{32}$/.test(prefix)) throw new Error('the event prefix is 32 lower-case hex characters');
  if (!line.startsWith(`${prefix} `)) return { kind: 'agent_output' };
  const parsed = parseEventLine('supervisor', line.slice(prefix.length + 1));
  if (agentStarted) return parsed.ok && AFTER_START.has(parsed.event.event) ? { kind: 'event', event: parsed.event } : { kind: 'agent_output' };
  return parsed.ok ? { kind: 'event', event: parsed.event } : { kind: 'invalid', problem: parsed.problem };
}

// One CLOCK request and exactly one valid reply per container (the sidecar and the agent container). Any other sequence fails the protocol for good.
export function createClockProtocol() {
  const requested = new Set();
  const samples = { egress: null, agent: null };
  let failed = false;
  const refuse = problem => { failed = true; return { ok: false, problem }; };
  return {
    request(container) {
      if (!CLOCK_CONTAINERS.includes(container)) return refuse('unknown_container');
      if (requested.has(container)) return refuse('repeated');
      requested.add(container);
      return { ok: true };
    },
    accept(container, event) {
      if (!CLOCK_CONTAINERS.includes(container)) return refuse('unknown_container');
      if (!requested.has(container)) return refuse('unrequested');
      if (samples[container] !== null) return refuse('duplicate');
      if (validateEvent(container === 'egress' ? 'sidecar' : 'supervisor', event).length > 0 || event.event !== 'clock') return refuse('invalid');
      samples[container] = event.clock_epoch_ms;
      return { ok: true };
    },
    complete: () => !failed && CLOCK_CONTAINERS.every(container => requested.has(container) && samples[container] !== null),
    failed: () => failed,
    samples: () => ({ ...samples }),
  };
}
