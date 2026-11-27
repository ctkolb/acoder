// Admission and accounting of the egress sidecar (A6.2 to A6.5). A pure module: no import, no clock, no output. The caller passes
// the time, prints the events and answers the requests; this module only decides and counts.

// The refusal code of each latched reason and of the in-flight limit (A3.2 step 6).
export const REFUSAL_CODES = {
  wall_clock: 'acoder_budget_wall_clock', calls: 'acoder_budget_calls', tokens: 'acoder_budget_tokens', usage_unreported: 'acoder_usage_unreported', in_flight: 'acoder_in_flight',
};

const isPositive = value => Number.isSafeInteger(value) && value > 0;
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isUsage = value => value !== null && typeof value === 'object' && ['input', 'output', 'reasoning', 'cached_input'].every(name => isCount(value[name]));

// limits: {calls, tokens, maxInFlight}; tokens null means no token gate (direct runReview only, A6.4).
export function createAccounting({ calls, tokens, maxInFlight }) {
  if (!isPositive(calls)) throw new Error('calls is a positive integer');
  if (tokens !== null && !isPositive(tokens)) throw new Error('tokens is a positive integer or null');
  if (!isPositive(maxInFlight)) throw new Error('maxInFlight is a positive integer');

  const open = new Set();
  const totals = { input: 0, output: 0, reasoning: 0, cached_input: 0 };
  let nextId = 0;
  let forwarded = 0;
  let deadline = null;
  // A6.5: one latch that never reopens; the first budget or error reason is retained and reported once.
  let latched = false;
  let stopped = false;
  let reason = null;
  let reported = false;
  let inFlightAtLimit = null;
  let usageMissing = 0;
  let lowerBound = false;
  let admittedAfterTokenLimit = 0;

  const total = () => totals.input + totals.output;
  const latch = kind => {
    latched = true;
    if (kind !== null && reason === null) { reason = kind; inFlightAtLimit = open.size; }
  };

  // The refusal code for a request arriving at `now`, or null when it could be admitted. A passed deadline refuses every request.
  function check(now) {
    if (deadline !== null && now >= deadline) { latch('wall_clock'); return REFUSAL_CODES.wall_clock; }
    if (latched) return reason === null ? null : REFUSAL_CODES[reason];
    if (open.size >= maxInFlight) return REFUSAL_CODES.in_flight;
    return null;
  }

  return {
    check,
    // A6.2: the counter is incremented here, before a byte is sent; the L-th admission latches at once.
    admit(now) {
      const code = check(now);
      if (code !== null || latched) return { ok: false, code };
      if (tokens !== null && total() >= tokens) admittedAfterTokenLimit += 1;
      nextId += 1;
      forwarded += 1;
      open.add(nextId);
      if (forwarded >= calls) latch('calls');
      return { ok: true, id: nextId };
    },
    // end: {complete, status, usage}; usage is the profile's result or null.
    finish(id, { complete, status, usage }) {
      if (!open.delete(id)) throw new Error('not a request in flight');
      if (isUsage(usage)) {
        for (const name of Object.keys(totals)) totals[name] += usage[name];
        if (tokens !== null && total() >= tokens) latch('tokens');
        return;
      }
      const success = Number.isInteger(status) && status >= 200 && status <= 299;
      if (complete && !success) return;
      usageMissing += 1;
      // A6.4: with a token limit and admissions open this is an error that latches; otherwise (stop-caused, or no token gate) the total is a lower bound.
      if (tokens !== null && !latched) latch('usage_unreported');
      else lowerBound = true;
    },
    setDeadline(ms) {
      if (deadline !== null) throw new Error('the deadline is set once');
      if (!isCount(ms)) throw new Error('the deadline is a non-negative safe integer');
      deadline = ms;
    },
    stop() { stopped = true; latch(null); },
    // The retained reason, once: printed with the first refusal for it, or before a post-latch report, the summary or the deadline exit.
    pendingLimit() {
      if (reason === null || reported) return null;
      reported = true;
      return reason;
    },
    snapshot: () => ({
      forwarded, in_flight: open.size, latched, stopped, reason, in_flight_at_limit: inFlightAtLimit, usage_missing: usageMissing,
      tokens_lower_bound: lowerBound, admitted_after_token_limit: admittedAfterTokenLimit, tokens: { ...totals, total: total() },
    }),
  };
}
