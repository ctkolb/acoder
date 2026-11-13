// A complete, valid input of buildRecord (every field of A9), for the record, scan and state tests.
const hex = char => char.repeat(64);

export const AGENT_MOUNTS = (mailbox = '/m/run', scratch = '/m/run/S2/scratch-t', md = '/m/run/S2/report-t.md', json = '/m/run/S2/report-t.json', exportPath = '/m/exp/code') => [
  { container: 'agent', target: '/acoder', source: '/s/agent-payload', kind: 'bind', mode: 'ro', persistent: true, role: 'payload' },
  { container: 'agent', target: mailbox, source: '/s/mailbox', kind: 'bind', mode: 'ro', persistent: true, role: 'mailbox' },
  { container: 'agent', target: exportPath, source: '/s/export-code', kind: 'bind', mode: 'ro', persistent: true, role: 'export' },
  { container: 'agent', target: scratch, source: scratch, kind: 'bind', mode: 'rw', persistent: true, role: 'scratch' },
  { container: 'agent', target: md, source: md, kind: 'bind', mode: 'rw', persistent: true, role: 'report' },
  { container: 'agent', target: json, source: json, kind: 'bind', mode: 'rw', persistent: true, role: 'report' },
  { container: 'agent', target: '/work', source: null, kind: 'tmpfs', mode: 'rw', persistent: false, role: 'work' },
  { container: 'agent', target: '/tmp', source: null, kind: 'tmpfs', mode: 'rw', persistent: false, role: 'work' },
  { container: 'agent', target: '/agent', source: null, kind: 'tmpfs', mode: 'rw', persistent: false, role: 'work' },
  { container: 'agent', target: '/run/acoder-egress', source: 'acoder-egress-r', kind: 'volume', mode: 'ro', persistent: false, role: 'socket' },
  { container: 'agent', target: '/etc/hosts', source: '/s/agent-payload/etc/hosts', kind: 'bind', mode: 'ro', persistent: true, role: 'etc' },
  { container: 'agent', target: '/etc/resolv.conf', source: '/s/agent-payload/etc/resolv.conf', kind: 'bind', mode: 'ro', persistent: true, role: 'etc' },
  { container: 'egress', target: '/acoder', source: '/s/egress-payload', kind: 'bind', mode: 'ro', persistent: true, role: 'payload' },
  { container: 'egress', target: '/run/acoder-egress', source: 'acoder-egress-r', kind: 'volume', mode: 'rw', persistent: false, role: 'socket' },
];

export function recordValues(over = {}) {
  const values = {
    run_id: '20261112T101500Z-a1b2c3', tag: 't',
    launcher: { version: '1.0.0', agent_payload_sha256: hex('a'), egress_payload_sha256: hex('b'), skill_sha256: hex('c') },
    agent: { name: 'opencode', cli_version: '1.19.3', model: 'gpt-6-luna', effort: 'high' },
    provider: { id: 'openai', endpoint: 'https://models.example.org/v1', max_in_flight: 4 },
    ticket: { path: '/m/run/S2/ticket-t.md', sha256: hex('d') },
    inputs: { snapshot_bytes: 100, snapshot_entries: 7, excluded: ['S1/scratch-x'], unchanged_at_end: true, scratch_git_entries: 2, scratch_git_entries_complete: true },
    exports: [{ role: 'code', path: '/m/exp/code', in_mailbox: false, manifest_path: '/m/run/S2/manifest-code.json', manifest_sha256: hex('e'), source_commit: 'a'.repeat(40), entries: 12, verified: true }],
    image: { ref: `sha256:${hex('f')}`, id: `sha256:${hex('f')}`, repo_digests: [`name@sha256:${hex('f')}`], env_names: ['PATH', 'NODE_VERSION'], allowed_env_names: ['FOO'] },
    runtime: { name: 'docker', client_version: '27.0.1', server_version: '27.0.1', host_os: 'linux', host_arch: 'arm64' },
    mounts: AGENT_MOUNTS(),
    plan_mounts: AGENT_MOUNTS(),
    network: { agent_network: 'none', egress_network: 'acoder-ext-r', egress_network_created: true, allowlist: ['models.example.org'], extra_ca_cert: false },
    isolation_checks: [{ id: 'H1', result: 'pass', detail: null }, { id: 'P1', result: 'not_run', detail: 'not_reached' }],
    egress_log: [{
      seq: 1, phase: 'agent', opened: '2026-11-12T10:15:01.000Z', closed: '2026-11-12T10:15:02.000Z', host: 'models.example.org', decision: 'forwarded', reason: null,
      status: 200, complete: true, bytes_up: 10, bytes_down: 20, usage: { input: 1, output: 2, reasoning: 0, cached_input: 0 }, response_model: 'gpt-6-luna',
    }],
    egress_log_truncated: false,
    egress_totals: { forwarded: 1, refused_probe: 0, refused_agent: 1, refused_by_reason: { acoder_path_not_allowed: 1 }, bytes_up: 10, bytes_down: 20, key_reflections: 0 },
    limits: { wall_seconds: 300, calls: 10, tokens: 1000, scratch_max_bytes: 4294967296 },
    usage: {
      calls_forwarded: 1, tokens: { input: 1, output: 2, reasoning: 0, cached_input: 0, total: 3 }, usage_missing: 0, admitted_after_token_limit: 0, in_flight_at_limit: null,
      counted_by: 'egress', advisory: { calls: 1, tokens: { input: 1 }, counted_by: 'adapter:opencode' },
    },
    times: { launched: '2026-11-12T10:15:00.000Z', released: '2026-11-12T10:15:01.000Z', ended: '2026-11-12T10:16:00.000Z', wall_seconds: 59.5 },
    agent_started: true, exit_reason: 'done', budget_kind: null, error_detail: null, conditions: [],
    agent_exit: { code: 0, signal: null, outcome: 'success' },
    reports: {
      md: { path: '/m/run/S2/report-t.md', exists: true, bytes: 5, sha256: hex('1') },
      json: { path: '/m/run/S2/report-t.json', exists: true, bytes: 9, sha256: hex('2'), parses: true, session_matches: true },
    },
    secret_scan: {
      status: 'clean', files_scanned: 3, log_redactions: 0, redacted_files: [], redacted_names: 0, removed_links: 0, unresolved_redactions: [], special_entries: 0, bytes_read: 40,
      entries_seen: 3, max_bytes: 4294967296, max_entries: 200000, max_depth: 64, max_seconds: 60, report_max_bytes: 16777216,
    },
    scratch_symlinks_outside: 0, cleanup: { status: 'complete', leftovers: [] }, log_path: '/m/run/S2/run-t.log',
  };
  return { ...values, ...over };
}
