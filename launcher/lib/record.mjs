// Run record, schema acoder-run-record/2 (A9): build, validate, serialize and write with exclusive creation.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CODE_PATTERN, REASON_CODES, formatProblems, printable, rfc3339, types } from './events.mjs';

export const RECORD_FORMAT = 'acoder-run-record/2';
export const RECORD_FIELDS = [
  'format', 'run_id', 'tag', 'launcher', 'agent', 'provider', 'ticket', 'inputs', 'exports', 'image', 'runtime', 'mounts', 'mount_summary', 'network', 'isolation_checks', 'egress_log',
  'egress_log_truncated', 'egress_totals', 'limits', 'usage', 'times', 'agent_started', 'exit_reason', 'budget_kind', 'error_detail', 'conditions', 'agent_exit', 'reports', 'secret_scan',
  'scratch_symlinks_outside', 'cleanup', 'log_path',
];
const TAG = /^[A-Za-z0-9._-]{1,120}$/;
const RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const OPEN_NOFOLLOW = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const CONDITIONS = [
  'secret_found', 'secret_scan_incomplete', 'egress_protocol_error', 'egress_sidecar_exited', 'runtime_failure', 'input_snapshot_changed', 'usage_unreported', 'interrupted', 'budget',
  'agent_failed', 'agent_exit_nonzero', 'no_model_request', 'last_model_request_failed', 'report_missing', 'report_invalid', 'tokens_lower_bound',
];
const ERROR_DETAILS = [...CONDITIONS.filter(name => name !== 'budget' && name !== 'tokens_lower_bound'), 'gate_failed'];

// A6.6: the run_id carries the time and six random hex characters, so two attempts in the same second never collide.
export function makeRunId(date = new Date(), random = randomBytes(3).toString('hex')) {
  if (!/^[0-9a-f]{6}$/.test(random)) throw new Error('the random part of a run id is six lower-case hex characters');
  return `${date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${random}`;
}

// A9 and A6.6: `run-<tag>.json` for a started run, `run-<tag>.notstarted-<run_id>.json` for an attempt that ended earlier; the log has the same stem.
export function recordNames({ stageDir, tag, runId, started }) {
  if (!path.isAbsolute(stageDir)) throw new Error('the stage folder must be an absolute path');
  if (!TAG.test(tag)) throw new Error('not a ticket tag');
  if (!started && !RUN_ID.test(runId)) throw new Error('not a run id');
  const stem = started ? `run-${tag}` : `run-${tag}.notstarted-${runId}`;
  return { record: path.join(stageDir, `${stem}.json`), log: path.join(stageDir, `${stem}.log`) };
}

// A9: mount_summary is computed from the mounts that `inspect` reported.
export function summarizeMounts(mounts) {
  const targets = predicate => mounts.filter(predicate).map(mount => mount.target);
  return {
    writable_host_paths: targets(mount => mount.persistent && mount.mode === 'rw'),
    readonly_inputs: targets(mount => mount.persistent && mount.mode === 'ro' && (mount.role === 'mailbox' || mount.role === 'export')),
    memory_mounts: targets(mount => !mount.persistent),
  };
}

export function mountSummary(mounts, planMounts) {
  const summary = summarizeMounts(mounts);
  return { ...summary, equal_to_plan: JSON.stringify(summary) === JSON.stringify(summarizeMounts(planMounts)) };
}

// The canonical tree hash of A9: entries sorted by relative UTF-8 path bytes, each one as a type byte (F, D, L), four octal permission
// digits (0000 for a link), the path length and the content length as u64 big-endian, the path and the content; the root is the empty path.
export function canonicalHash(root) {
  const entries = [];
  const u64 = number => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64BE(BigInt(number)); return buffer; };
  const add = (relative, type, mode, content) => entries.push({ relative: Buffer.from(relative), type, mode, content });
  const readFile = file => {
    const fd = fs.openSync(file, OPEN_NOFOLLOW);
    try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
  };
  const walk = (directory, relative) => {
    for (const name of fs.readdirSync(directory)) {
      const full = path.join(directory, name);
      const shown = relative === '' ? name : `${relative}/${name}`;
      const info = fs.lstatSync(full);
      if (info.isDirectory()) { add(shown, 'D', info.mode & 0o777, Buffer.alloc(0)); walk(full, shown); }
      else if (info.isSymbolicLink()) add(shown, 'L', 0, Buffer.from(fs.readlinkSync(full)));
      else if (info.isFile()) add(shown, 'F', info.mode & 0o777, readFile(full));
      else throw new Error(`a payload tree holds a special file: ${shown}`);
    }
  };
  const info = fs.lstatSync(root);
  if (!info.isDirectory()) throw new Error('a payload tree is a directory');
  add('', 'D', info.mode & 0o777, Buffer.alloc(0));
  walk(root, '');
  entries.sort((a, b) => Buffer.compare(a.relative, b.relative));
  const hash = createHash('sha256');
  for (const { relative, type, mode, content } of entries) hash.update(Buffer.concat([Buffer.from(type), Buffer.from(mode.toString(8).padStart(4, '0')), u64(relative.length), relative, u64(content.length), content]));
  return hash.digest('hex');
}

export const launcherSection = ({ version, agentPayload, egressPayload, skill }) => ({
  version, agent_payload_sha256: canonicalHash(agentPayload), egress_payload_sha256: canonicalHash(egressPayload), skill_sha256: canonicalHash(skill),
});

// The ticket, exports and inputs sections of a record, from the result of prepare() (the hashes are those of the copy).
export function preparedSections(prepared, options) {
  return {
    ticket: { path: prepared.ticket.path, sha256: prepared.ticket.sha256 },
    exports: options.exports.map(({ role }) => ({
      role, path: prepared.exports[role].dir, in_mailbox: prepared.exports[role].inside_mailbox, manifest_path: prepared.manifests[role].path, manifest_sha256: prepared.manifests[role].sha256,
      source_commit: prepared.manifests[role].source_commit, entries: prepared.exports[role].entries, verified: true,
    })),
    inputs: { snapshot_bytes: prepared.snapshot.bytes, snapshot_entries: prepared.snapshot.entries, excluded: [...prepared.excluded], unchanged_at_end: null, scratch_git_entries: 0, scratch_git_entries_complete: true },
  };
}

const { int, number, str, bool, literal, oneOf, pattern, nullable, listOf, mapOf, object } = types;
const sha = pattern(/^[0-9a-f]{64}$/, 'must be 64 lower-case hex characters');
const commit = pattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'must be 40 or 64 lower-case hex characters');
const problem = (key, message) => [{ path: [key], message }];
const countsOf = fields => object(Object.fromEntries(fields.map(field => [field, int])));

const SPEC = object({
  format: literal(RECORD_FORMAT), run_id: str, tag: str,
  launcher: object({ version: str, agent_payload_sha256: sha, egress_payload_sha256: sha, skill_sha256: sha }),
  agent: object({ name: str, cli_version: nullable(str), model: str, effort: str }),
  provider: object({ id: str, endpoint: str, max_in_flight: int }),
  ticket: object({ path: str, sha256: sha }),
  inputs: object({ snapshot_bytes: int, snapshot_entries: int, excluded: listOf(str), unchanged_at_end: nullable(bool), scratch_git_entries: int, scratch_git_entries_complete: bool }),
  exports: listOf(object({ role: str, path: str, in_mailbox: bool, manifest_path: str, manifest_sha256: sha, source_commit: commit, entries: int, verified: literal(true) })),
  image: object({ ref: str, id: str, repo_digests: listOf(str), env_names: listOf(str), allowed_env_names: listOf(str) }),
  runtime: object({ name: oneOf(['docker', 'podman']), client_version: str, server_version: str, host_os: str, host_arch: str }),
  mounts: listOf(object({
    container: oneOf(['agent', 'egress']), target: str, source: nullable(str), kind: oneOf(['bind', 'tmpfs', 'volume']), mode: oneOf(['ro', 'rw']), persistent: bool,
    role: oneOf(['payload', 'mailbox', 'export', 'scratch', 'report', 'work', 'socket', 'etc']),
  }, mount => (mount.persistent === (mount.kind === 'bind') ? [] : problem('persistent', 'is true exactly for a bind')))),
  mount_summary: object({ writable_host_paths: listOf(str), readonly_inputs: listOf(str), memory_mounts: listOf(str), equal_to_plan: bool }),
  network: object({ agent_network: literal('none'), egress_network: str, egress_network_created: bool, allowlist: listOf(str), extra_ca_cert: bool }),
  isolation_checks: listOf(object({ id: str, result: oneOf(['pass', 'fail', 'not_run']), detail: nullable(str) })),
  egress_log: listOf(object({
    seq: int, phase: oneOf(['probe', 'agent']), opened: rfc3339, closed: rfc3339, host: nullable(str), decision: oneOf(['forwarded', 'refused', 'local']), reason: nullable(oneOf(REASON_CODES)),
    status: nullable(int), complete: bool, bytes_up: int, bytes_down: int, usage: nullable(countsOf(['input', 'output', 'reasoning', 'cached_input'])), response_model: nullable(printable),
  })),
  egress_log_truncated: bool,
  egress_totals: object({
    forwarded: int, refused_probe: int, refused_agent: int, refused_by_reason: mapOf(key => CODE_PATTERN.test(key), 'a key is not a fixed code', int), bytes_up: int, bytes_down: int, key_reflections: int,
  }),
  limits: object({ wall_seconds: int, calls: int, tokens: nullable(int), scratch_max_bytes: int }),
  usage: object({
    calls_forwarded: int, tokens: nullable(countsOf(['input', 'output', 'reasoning', 'cached_input', 'total'])), usage_missing: int, admitted_after_token_limit: int, in_flight_at_limit: nullable(int),
    counted_by: literal('egress'), advisory: nullable(object({ calls: int, tokens: nullable(mapOf(() => true, '', int)), counted_by: pattern(/^adapter:[a-z0-9-]+$/, 'must name the adapter') })),
  }),
  times: object({ launched: rfc3339, released: nullable(rfc3339), ended: rfc3339, wall_seconds: number }),
  agent_started: bool,
  exit_reason: nullable(oneOf(['done', 'budget', 'error'])), budget_kind: nullable(oneOf(['wall_clock', 'calls', 'tokens', 'disk'])), error_detail: nullable(oneOf(ERROR_DETAILS)),
  conditions: listOf(oneOf(CONDITIONS)),
  agent_exit: object({ code: nullable(int), signal: nullable(str), outcome: nullable(oneOf(['success', 'error'])) }),
  reports: object({
    md: object({ path: str, exists: bool, bytes: int, sha256: nullable(sha) }),
    json: object({ path: str, exists: bool, bytes: int, sha256: nullable(sha), parses: bool, session_matches: bool }),
  }),
  secret_scan: object({
    status: oneOf(['clean', 'found', 'incomplete', 'not_run']), files_scanned: int, log_redactions: int, redacted_files: listOf(str), redacted_names: int, removed_links: int,
    unresolved_redactions: listOf(str), special_entries: int, bytes_read: int, entries_seen: int, max_bytes: int, max_entries: int, max_depth: int, max_seconds: int, report_max_bytes: int,
  }),
  scratch_symlinks_outside: int,
  cleanup: object({ status: oneOf(['complete', 'incomplete']), leftovers: listOf(str) }),
  log_path: str,
}, record => [
  ...(record.exit_reason === 'budget' && record.budget_kind === null ? problem('budget_kind', 'a budget exit names its kind') : []),
  ...(record.secret_scan.status === 'incomplete' && record.inputs.scratch_git_entries_complete !== false ? [{ path: ['inputs', 'scratch_git_entries_complete'], message: 'is false when the scan is incomplete' }] : []),
]);

export function validateRecord(record) {
  return formatProblems(SPEC(record));
}

// values: every field of A9 except `format` and `mount_summary`, plus `plan_mounts` (the mounts of the plan, for equal_to_plan).
export function buildRecord(values) {
  const allowed = new Set([...RECORD_FIELDS.filter(name => name !== 'format' && name !== 'mount_summary'), 'plan_mounts']);
  const unknown = Object.keys(values).filter(name => !allowed.has(name));
  if (unknown.length > 0) throw new Error(`unknown record value ${unknown.join(', ')}`);
  const record = {
    format: RECORD_FORMAT,
    run_id: values.run_id,
    tag: values.tag,
    launcher: values.launcher,
    agent: values.agent,
    provider: values.provider,
    ticket: values.ticket,
    inputs: values.inputs,
    exports: values.exports,
    image: values.image,
    runtime: values.runtime,
    mounts: values.mounts,
    mount_summary: Array.isArray(values.mounts) && Array.isArray(values.plan_mounts) ? mountSummary(values.mounts, values.plan_mounts) : undefined,
    network: values.network,
    isolation_checks: values.isolation_checks,
    egress_log: values.egress_log,
    egress_log_truncated: values.egress_log_truncated,
    egress_totals: values.egress_totals,
    limits: values.limits,
    usage: values.usage,
    times: values.times,
    agent_started: values.agent_started,
    exit_reason: values.exit_reason,
    budget_kind: values.budget_kind,
    error_detail: values.error_detail,
    conditions: values.conditions,
    agent_exit: values.agent_exit,
    reports: values.reports,
    secret_scan: values.secret_scan,
    scratch_symlinks_outside: values.scratch_symlinks_outside,
    cleanup: values.cleanup,
    log_path: values.log_path,
  };
  const problems = validateRecord(record);
  if (problems.length > 0) throw new Error(`invalid run record: ${problems.join('; ')}`);
  return structuredClone(record);
}

// Every string passes the redactor before serialization (A8.5); a key form that is still in the text (for example in an object key) is an error.
export function serializeRecord(record, redactor) {
  const problems = validateRecord(record);
  if (problems.length > 0) throw new Error(`invalid run record: ${problems.join('; ')}`);
  let replacements = 0;
  const clean = value => {
    if (typeof value === 'string') {
      const result = redactor.redactString(value);
      replacements += result.count;
      return result.text;
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
    return value;
  };
  const text = `${JSON.stringify(clean(record), null, 2)}\n`;
  if (redactor.containsKey(text)) throw new Error('the key is still in the serialized run record');
  return { text, replacements };
}

// Exclusive creation: an existing file, or a link at the path, is never opened or changed.
// `io` is a test seam (the file system functions used); the run passes none.
export function writeRecord(file, record, redactor, io = fs) {
  const { text, replacements } = serializeRecord(record, redactor);
  const fd = io.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
  try {
    io.fchmodSync(fd, 0o644);
    io.writeFileSync(fd, text);
    io.fsyncSync(fd);
  } catch (error) {
    try { io.unlinkSync(file); } catch { /* the original error is the one to report */ }
    throw error;
  } finally { io.closeSync(fd); }
  return { path: file, replacements };
}
