// The lifecycle of A6.6 and the exit reason of A6.5 as pure functions: no file, process or clock is touched here.
export const STATES = ['V', 'S', 'E2', 'E3', 'G', 'R', 'A', 'T', 'C', 'F'];
export const OUTCOMES = ['refused', 'not-started', 'done', 'budget', 'error'];
const EXIT_CODES = { refused: 2, 'not-started': 1, done: 0, budget: 3, error: 1 };

// A6.5: the first match wins; every condition that held is listed, in this order.
export const PRECEDENCE = [
  ['secret_found'],
  ['secret_scan_incomplete', 'egress_protocol_error', 'egress_sidecar_exited', 'runtime_failure', 'input_snapshot_changed', 'usage_unreported'],
  ['interrupted'],
  ['budget'],
  ['agent_failed', 'agent_exit_nonzero', 'no_model_request', 'last_model_request_failed', 'report_missing', 'report_invalid'],
];
const ORDER = PRECEDENCE.flat();
const BUDGET_KINDS = ['wall_clock', 'calls', 'tokens', 'disk'];
const SCAN_FLAGS = { clean: [], found: ['secret_found'], incomplete: ['secret_scan_incomplete'], not_run: ['secret_scan_incomplete'] };

export function exitCodeOf(outcome) {
  if (!Object.hasOwn(EXIT_CODES, outcome)) throw new Error(`unknown outcome ${String(outcome)}`);
  return EXIT_CODES[outcome];
}

// The effects of the failure states (A6.6). `remove` is in the order of removal: containers, volume and network first, then the staging
// directory, then the empty report files and the empty scratch directory (A6.6 attempt artifacts). `leaves` names what stays behind.
const RUNTIME = ['agent', 'egress', 'volume', 'network'];
const ATTEMPT = ['staging', 'report_md', 'report_json', 'scratch'];
const NOT_STARTED = { outcome: 'not-started', record: 'notstarted', log: 'notstarted', retry: true, leaves: ['record', 'log'] };
const FAILURES = {
  V: { outcome: 'refused', record: 'none', log: 'none', error_detail: null, retry: true, remove: [], leaves: [] },
  S: { outcome: 'refused', record: 'none', log: 'none', error_detail: null, retry: true, remove: ['staging'], leaves: [] },
  E2: { ...NOT_STARTED, error_detail: 'runtime_failure', remove: ATTEMPT },
  E3: { ...NOT_STARTED, error_detail: 'runtime_failure', remove: [...RUNTIME, ...ATTEMPT] },
  G: { ...NOT_STARTED, error_detail: 'gate_failed', remove: [...RUNTIME, ...ATTEMPT] },
};
const R_NOT_WRITTEN = { ...NOT_STARTED, error_detail: 'runtime_failure', remove: [...RUNTIME, ...ATTEMPT] };
const R_WRITTEN = {
  outcome: 'error', record: 'run', log: 'run', error_detail: 'runtime_failure', retry: false, remove: [...RUNTIME, 'staging'],
  leaves: ['scratch', 'report_md', 'report_json', 'started_file', 'record', 'log'],
};

// The outcome of a failure at one effect boundary. Once the started file exists the ticket counts as started and cannot be retried.
// An interrupt (A6.8) is the cause when `interrupted` is true: the not-started record then says so, and a refusal stays a refusal.
export function failureOutcome(state, { startedFileWritten = false, interrupted = false } = {}) {
  const row = state === 'R' ? (startedFileWritten ? R_WRITTEN : R_NOT_WRITTEN) : FAILURES[state];
  if (row === undefined || !Object.hasOwn({ ...FAILURES, R: 1 }, state)) throw new Error(`${String(state)} is not an effect boundary`);
  const errorDetail = interrupted && row.error_detail !== null ? 'interrupted' : row.error_detail;
  return { state, outcome: row.outcome, exit_code: exitCodeOf(row.outcome), record: row.record, log: row.log, error_detail: errorDetail, retry: row.retry, remove: [...row.remove], leaves: [...row.leaves] };
}

// flags: conditions that held (any name of PRECEDENCE except `budget`); budgetKinds: the limits in the order the launcher learned of them
// (they make `budget` hold); tokensLowerBound: the advisory condition of A6.3, which never decides the reason.
export function decideExit({ flags = [], budgetKinds = [], tokensLowerBound = false }) {
  for (const flag of flags) if (!ORDER.includes(flag) || flag === 'budget') throw new Error(`unknown condition ${String(flag)}`);
  for (const kind of budgetKinds) if (!BUDGET_KINDS.includes(kind)) throw new Error(`unknown budget kind ${String(kind)}`);
  const held = new Set(flags);
  if (budgetKinds.length > 0) held.add('budget');
  const conditions = ORDER.filter(name => held.has(name));
  const winner = conditions[0] ?? null;
  const exitReason = winner === null ? 'done' : winner === 'budget' ? 'budget' : 'error';
  const outcome = exitReason;
  return {
    exit_reason: exitReason, budget_kind: budgetKinds[0] ?? null, error_detail: exitReason === 'error' ? winner : null,
    conditions: tokensLowerBound ? [...conditions, 'tokens_lower_bound'] : conditions, outcome, exit_code: exitCodeOf(outcome),
  };
}

const isGood = request => request.complete === true && Number.isInteger(request.status) && request.status >= 200 && request.status <= 299;

// The conditions of step 5 of A6.5, from the facts of the run: the agent's exit and the adapter's outcome (null when the agent never ran), the
// egress log, and the report states of the record. They are listed in the order of A6.5.
export function agentConditions({ agent, egress_log: log, reports }) {
  const found = [];
  if (agent !== null) {
    if (agent.code === 0 && (agent.signal === null || agent.signal === undefined)) { if (agent.outcome === 'error') found.push('agent_failed'); }
    else found.push('agent_exit_nonzero');
  }
  const calls = log.filter(request => request.decision === 'forwarded');
  if (calls.length === 0) found.push('no_model_request');
  else {
    const last = calls.reduce((best, request) => {
      const [a, b] = [Date.parse(request.closed), Date.parse(best.closed)];
      return a > b || (a === b && request.seq > best.seq) ? request : best;
    });
    if (!isGood(last)) found.push('last_model_request_failed');
  }
  const present = report => report.exists && report.bytes > 0;
  if (!present(reports.md) || !present(reports.json)) found.push('report_missing');
  else if (!reports.json.parses || !reports.json.session_matches) found.push('report_invalid');
  return found;
}

// facts: flags, budgetKinds, tokensLowerBound (as decideExit), scan_status (clean, found, incomplete, not_run), and the facts of agentConditions.
export function evaluateRun({ flags = [], budgetKinds = [], tokensLowerBound = false, scan_status: scanStatus, agent, egress_log: log, reports }) {
  if (!Object.hasOwn(SCAN_FLAGS, scanStatus)) throw new Error(`unknown scan status ${String(scanStatus)}`);
  return decideExit({ flags: [...flags, ...SCAN_FLAGS[scanStatus], ...agentConditions({ agent, egress_log: log, reports })], budgetKinds, tokensLowerBound });
}
