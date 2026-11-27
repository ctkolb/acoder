import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { parseReviewRun } from '../lib/args.mjs';
import { prepare } from '../lib/prepare.mjs';
import { RECORD_FIELDS, RECORD_FORMAT, buildRecord, launcherSection, makeRunId, mountSummary, preparedSections, recordNames, serializeRecord, summarizeMounts, validateRecord, writeRecord } from '../lib/record.mjs';
import { createRedactor } from '../lib/redact.mjs';
import { thrownOf, must, release, withFixture } from './helpers/fixtures.mjs';
import { syntheticKey } from './helpers/key-forms.mjs';
import { AGENT_MOUNTS, recordValues } from './helpers/record-values.mjs';

// G11: every test has a finite time limit of its own. The test is registered from this file, so that the mutation runner can count it per module.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, async (...args) => {
  // A failure that is not an assertion (a TypeError from a broken module) is reported as an assertion failure.
  try { return await fn(...args); } catch (error) { if (error?.code === 'ERR_ASSERTION') throw error; assert.fail(`threw: ${String(error?.message ?? error)}`); }
});

const FIELDS = [
  'format', 'run_id', 'tag', 'launcher', 'agent', 'provider', 'ticket', 'inputs', 'exports', 'image', 'runtime', 'mounts', 'mount_summary', 'network', 'isolation_checks', 'egress_log',
  'egress_log_truncated', 'egress_totals', 'limits', 'usage', 'times', 'agent_started', 'exit_reason', 'budget_kind', 'error_detail', 'conditions', 'agent_exit', 'reports', 'secret_scan',
  'scratch_symlinks_outside', 'cleanup', 'log_path',
];
const build = (over = {}) => must(() => buildRecord(recordValues(over)));
const problemsOf = record => must(() => validateRecord(record));
const NULLABLE = new Set([
  'agent.cli_version', 'inputs.unchanged_at_end', 'mounts.*.source', 'times.released', 'exit_reason', 'budget_kind', 'error_detail', 'agent_exit.code', 'agent_exit.signal', 'agent_exit.outcome',
  'limits.tokens', 'usage.tokens', 'usage.in_flight_at_limit', 'usage.advisory', 'usage.advisory.tokens', 'reports.md.sha256', 'reports.json.sha256', 'isolation_checks.*.detail',
  'egress_log.*.host', 'egress_log.*.reason', 'egress_log.*.status', 'egress_log.*.usage', 'egress_log.*.response_model',
]);
const OPEN_MAPS = new Set(['egress_totals.refused_by_reason', 'usage.advisory.tokens']);

// Every node below the root: its path (array), a dotted path with indexes, a wildcard path, the parent and the key.
function nodes(root) {
  const found = [];
  const walk = (value, parts) => {
    if (value === null || typeof value !== 'object') return;
    const keys = Array.isArray(value) ? value.map((_, index) => index) : Object.keys(value);
    for (const key of keys) {
      const here = [...parts, key];
      found.push({ parts: here, dotted: here.join('.'), wild: here.map(part => (typeof part === 'number' ? '*' : part)).join('.'), parent: value, key, node: value[key] });
      walk(value[key], here);
    }
  };
  walk(root, []);
  return found;
}
const wrongTypeOf = value => {
  if (typeof value === 'string') return 7;
  if (typeof value === 'number') return 'x';
  if (typeof value === 'boolean') return 'x';
  if (Array.isArray(value)) return 'x';
  if (value === null) return {};
  return 7;
};
const mentions = (problems, dotted) => problems.some(problem => problem.startsWith(dotted) || problem.includes(`${dotted}:`) || problem.includes(dotted));

t('dod6-schema: buildRecord returns exactly the fields of A9, in order, with the values given and a computed mount_summary', () => {
  assert.equal(RECORD_FORMAT, 'acoder-run-record/2');
  assert.deepEqual(RECORD_FIELDS, FIELDS);
  const values = recordValues();
  const record = must(() => buildRecord(values));
  assert.deepEqual(Object.keys(record), FIELDS);
  const { plan_mounts: planMounts, ...rest } = values;
  assert.deepEqual(record, { format: 'acoder-run-record/2', ...rest, mount_summary: must(() => mountSummary(values.mounts, planMounts)) });
  assert.deepEqual(problemsOf(record), []);
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
  assert.notEqual(record.mounts, values.mounts, 'the record holds a copy');
  for (const field of FIELDS.filter(name => name !== 'format' && name !== 'mount_summary')) {
    const { [field]: dropped, ...without } = recordValues();
    assert.notEqual(dropped, undefined);
    assert.match(thrownOf(() => buildRecord(without)) ?? 'no refusal', new RegExp(field), `a missing ${field} is rejected by name`);
  }
  assert.match(thrownOf(() => buildRecord(recordValues({ extra_field: 1 }))) ?? 'no refusal', /extra_field/, 'an unknown value is rejected');
});

t('dod6-schema: a missing field, a wrong type, a null that is not allowed and an unknown field are each rejected, at every level', () => {
  const record = build();
  const all = nodes(record);
  assert.ok(all.length > 250, `the walk covers the whole record (${all.length} nodes)`);
  for (const { parts, dotted, wild, parent, key, node } of all) {
    const withChange = change => {
      const copy = structuredClone(record);
      let target = copy;
      for (const part of parts.slice(0, -1)) target = target[part];
      change(target, key);
      return copy;
    };
    const isOpenValue = OPEN_MAPS.has(parts.slice(0, -1).filter(part => typeof part !== 'number').join('.'));
    if (!Array.isArray(parent) && !isOpenValue) {
      const gone = problemsOf(withChange((target, name) => { delete target[name]; }));
      assert.ok(mentions(gone, dotted) && gone.some(problem => problem.includes('missing')), `missing ${dotted} is rejected: ${JSON.stringify(gone)}`);
    }
    const wrong = problemsOf(withChange((target, name) => { target[name] = wrongTypeOf(node); }));
    assert.ok(mentions(wrong, dotted), `a wrong type for ${dotted} is rejected: ${JSON.stringify(wrong)}`);
    const nulled = problemsOf(withChange((target, name) => { target[name] = null; }));
    if (NULLABLE.has(wild) || node === null) assert.deepEqual(nulled, [], `${dotted} may be null`);
    else assert.ok(mentions(nulled, dotted), `null for ${dotted} is rejected: ${JSON.stringify(nulled)}`);
    if (node !== null && typeof node === 'object' && !Array.isArray(node) && !OPEN_MAPS.has(parts.filter(part => typeof part !== 'number').join('.'))) {
      const extra = problemsOf(withChange((target, name) => { target[name] = { ...node, zz_extra: 1 }; }));
      assert.ok(mentions(extra, 'zz_extra'), `an unknown field inside ${dotted} is rejected: ${JSON.stringify(extra)}`);
    }
  }
  const top = problemsOf({ ...record, zz_extra: 1 });
  assert.ok(mentions(top, 'zz_extra'));
  assert.ok(problemsOf(null).length > 0 && problemsOf([]).length > 0 && problemsOf('x').length > 0, 'a record must be an object');
});

t('dod6-schema: enumerations, integers, hashes and the cross-field rules', () => {
  const record = build();
  const set = (parts, value) => {
    const copy = structuredClone(record);
    let target = copy;
    for (const part of parts.slice(0, -1)) target = target[part];
    target[parts.at(-1)] = value;
    return copy;
  };
  const enums = {
    'secret_scan.status': ['clean', 'found', 'incomplete', 'not_run'], exit_reason: ['done', 'budget', 'error', null], 'runtime.name': ['docker', 'podman'],
    'mounts.0.kind': ['bind', 'tmpfs', 'volume'], 'mounts.0.mode': ['ro', 'rw'], 'mounts.0.container': ['agent', 'egress'],
    'mounts.0.role': ['payload', 'mailbox', 'export', 'scratch', 'report', 'work', 'socket', 'etc'], 'isolation_checks.0.result': ['pass', 'fail', 'not_run'],
    'egress_log.0.phase': ['probe', 'agent'], 'egress_log.0.decision': ['forwarded', 'refused', 'local'], 'agent_exit.outcome': ['success', 'error', null], 'cleanup.status': ['complete', 'incomplete'],
    'network.agent_network': ['none'], 'usage.counted_by': ['egress'],
  };
  for (const [dotted, valid] of Object.entries(enums)) {
    const parts = dotted.split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part));
    for (const value of valid) {
      const copy = set(parts, value);
      if (dotted === 'mounts.0.kind') copy.mounts[0].persistent = value === 'bind';
      if (dotted === 'exit_reason' && value === 'budget') copy.budget_kind = 'calls';
      if (dotted === 'secret_scan.status' && value === 'incomplete') copy.inputs.scratch_git_entries_complete = false;
      assert.deepEqual(problemsOf(copy), [], `${dotted} = ${value} is accepted`);
    }
    assert.ok(mentions(problemsOf(set(parts, 'bogus')), dotted), `${dotted} = bogus is rejected`);
  }
  for (const value of ['budget', 'error']) assert.deepEqual(problemsOf({ ...record, exit_reason: value, budget_kind: value === 'budget' ? 'calls' : null }), []);
  for (const kind of ['wall_clock', 'calls', 'tokens', 'disk', null]) assert.deepEqual(problemsOf({ ...record, budget_kind: kind }), [], `budget_kind ${kind}`);
  assert.ok(mentions(problemsOf({ ...record, budget_kind: 'memory' }), 'budget_kind'));
  assert.ok(mentions(problemsOf({ ...record, exit_reason: 'budget', budget_kind: null }), 'budget_kind'), 'a budget exit needs its kind');
  const details = ['secret_found', 'secret_scan_incomplete', 'egress_protocol_error', 'egress_sidecar_exited', 'runtime_failure', 'input_snapshot_changed', 'usage_unreported', 'interrupted',
    'agent_failed', 'agent_exit_nonzero', 'no_model_request', 'last_model_request_failed', 'report_missing', 'report_invalid', 'gate_failed'];
  for (const detail of details) assert.deepEqual(problemsOf({ ...record, exit_reason: 'error', error_detail: detail }), [], `error_detail ${detail}`);
  assert.ok(mentions(problemsOf({ ...record, error_detail: 'budget' }), 'error_detail'));
  for (const condition of [...details.filter(name => name !== 'gate_failed'), 'budget', 'tokens_lower_bound']) assert.deepEqual(problemsOf({ ...record, conditions: [condition] }), [], `condition ${condition}`);
  assert.ok(mentions(problemsOf({ ...record, conditions: ['gate_failed'] }), 'conditions'));
  assert.ok(mentions(problemsOf({ ...record, conditions: ['nope'] }), 'conditions'));
  // Integers are non-negative safe integers; wall_seconds is a non-negative finite number.
  for (const dotted of ['inputs.snapshot_bytes', 'inputs.snapshot_entries', 'inputs.scratch_git_entries', 'exports.0.entries', 'provider.max_in_flight', 'limits.wall_seconds', 'limits.calls', 'limits.tokens',
    'limits.scratch_max_bytes', 'usage.calls_forwarded', 'usage.tokens.total', 'usage.usage_missing', 'usage.admitted_after_token_limit', 'egress_log.0.seq', 'egress_log.0.bytes_up', 'egress_log.0.usage.input',
    'egress_totals.forwarded', 'egress_totals.key_reflections', 'egress_totals.refused_by_reason.acoder_path_not_allowed', 'reports.md.bytes', 'secret_scan.files_scanned', 'secret_scan.max_depth', 'scratch_symlinks_outside', 'agent_exit.code']) {
    const parts = dotted.split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part));
    for (const bad of [-1, 1.5, 2 ** 53, Number.NaN, Infinity]) assert.ok(mentions(problemsOf(set(parts, bad)), dotted), `${dotted} = ${bad} is rejected`);
    assert.deepEqual(problemsOf(set(parts, 0)), [], `${dotted} = 0 is accepted`);
  }
  for (const bad of [-1, Number.NaN, Infinity]) assert.ok(mentions(problemsOf(set(['times', 'wall_seconds'], bad)), 'times.wall_seconds'));
  assert.deepEqual(problemsOf(set(['times', 'wall_seconds'], 0.25)), []);
  // SHA-256 hashes are 64 lower-case hex characters; the source commit has 40 or 64.
  const hashes = ['launcher.agent_payload_sha256', 'launcher.egress_payload_sha256', 'launcher.skill_sha256', 'ticket.sha256', 'exports.0.manifest_sha256', 'reports.md.sha256', 'reports.json.sha256'];
  for (const dotted of hashes) {
    const parts = dotted.split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part));
    for (const bad of ['abc', 'A'.repeat(64), 'g'.repeat(64), `${'a'.repeat(64)}0`, 'a'.repeat(63), '']) assert.ok(mentions(problemsOf(set(parts, bad)), dotted), `${dotted} = ${bad.slice(0, 8)} is rejected`);
  }
  for (const good of ['a'.repeat(40), 'b'.repeat(64)]) assert.deepEqual(problemsOf(set(['exports', 0, 'source_commit'], good)), []);
  for (const bad of ['a'.repeat(39), 'A'.repeat(40), 'a'.repeat(41), '']) assert.ok(mentions(problemsOf(set(['exports', 0, 'source_commit'], bad)), 'exports.0.source_commit'));
  // The mount's persistent flag is true exactly for a bind.
  assert.ok(mentions(problemsOf(set(['mounts', 6, 'persistent'], true)), 'mounts.6.persistent'), 'a tmpfs is not persistent');
  assert.ok(mentions(problemsOf(set(['mounts', 1, 'persistent'], false)), 'mounts.1.persistent'), 'a bind is persistent');
  // advisory counted_by names the adapter; the egress network is a name.
  assert.ok(mentions(problemsOf(set(['usage', 'advisory', 'counted_by'], 'egress')), 'usage.advisory.counted_by'));
  assert.ok(mentions(problemsOf(set(['format'], 'acoder-run-record/1')), 'format'), 'the format name is the one of A9');
  assert.ok(mentions(problemsOf(set(['exports', 0, 'verified'], false)), 'exports.0.verified'), 'a record holds verified exports only');
  assert.ok(mentions(problemsOf(set(['egress_log', 0, 'reason'], 'bogus')), 'egress_log.0.reason'), 'the reason is a fixed code');
  assert.deepEqual(problemsOf(set(['egress_log', 0, 'reason'], 'acoder_budget_calls')), []);
  for (const field of ['launched', 'ended']) assert.ok(mentions(problemsOf(set(['times', field], 'yesterday')), `times.${field}`), 'a time is RFC 3339');
  assert.ok(mentions(problemsOf(set(['times', 'released'], 'yesterday')), 'times.released'));
  assert.ok(mentions(problemsOf(set(['egress_totals', 'refused_by_reason'], { 'Bad Key': 1 })), 'egress_totals.refused_by_reason'), 'the keys of refused_by_reason are fixed codes');
  assert.ok(mentions(problemsOf(set(['usage', 'advisory', 'tokens'], { input: 'x' })), 'usage.advisory.tokens'));
  assert.ok(mentions(problemsOf(set(['egress_totals', 'refused_by_reason'], { acoder_x: -1 })), 'egress_totals.refused_by_reason'));
  assert.ok(mentions(problemsOf(set(['egress_log', 0, 'response_model'], 'é')), 'egress_log.0.response_model'), 'response_model is printable ASCII');
  assert.ok(mentions(problemsOf(set(['egress_log', 0, 'response_model'], 'x'.repeat(65))), 'egress_log.0.response_model'), 'response_model has at most 64 characters');
  assert.deepEqual(problemsOf(set(['egress_log', 0, 'response_model'], 'x'.repeat(64))), []);
});

t('dod6-schema: all four secret-scan status values are valid, and an incomplete scan makes the scratch Git count a lower bound', () => {
  const record = build();
  for (const status of ['clean', 'found', 'incomplete', 'not_run']) {
    const inputs = { ...record.inputs, scratch_git_entries_complete: status !== 'incomplete' };
    assert.deepEqual(problemsOf({ ...record, inputs, secret_scan: { ...record.secret_scan, status } }), [], status);
  }
  const incomplete = { ...record, secret_scan: { ...record.secret_scan, status: 'incomplete' } };
  assert.ok(mentions(problemsOf(incomplete), 'inputs.scratch_git_entries_complete'), 'incomplete scan with a complete Git count is rejected');
  assert.deepEqual(problemsOf({ ...incomplete, inputs: { ...incomplete.inputs, scratch_git_entries_complete: false } }), []);
  assert.deepEqual(problemsOf({ ...record, inputs: { ...record.inputs, scratch_git_entries_complete: false } }), [], 'a clean scan may still report an incomplete count');
});

// The test's own oracle for the canonical tree hash of A9.
function canonicalOracle(root) {
  const entries = [];
  const walk = (directory, relative) => {
    for (const name of fs.readdirSync(directory)) {
      const full = path.join(directory, name);
      const shown = relative === '' ? name : `${relative}/${name}`;
      const info = fs.lstatSync(full);
      if (info.isDirectory()) { entries.push({ shown, type: 'D', mode: info.mode & 0o777, content: Buffer.alloc(0) }); walk(full, shown); }
      else if (info.isSymbolicLink()) entries.push({ shown, type: 'L', mode: 0, content: Buffer.from(fs.readlinkSync(full)) });
      else entries.push({ shown, type: 'F', mode: info.mode & 0o777, content: fs.readFileSync(full) });
    }
  };
  entries.push({ shown: '', type: 'D', mode: fs.lstatSync(root).mode & 0o777, content: Buffer.alloc(0) });
  walk(root, '');
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.shown), Buffer.from(b.shown)));
  const hash = createHash('sha256');
  const u64 = number => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64BE(BigInt(number)); return buffer; };
  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.shown);
    hash.update(Buffer.concat([Buffer.from(entry.type), Buffer.from(entry.mode.toString(8).padStart(4, '0')), u64(pathBytes.length), pathBytes, u64(entry.content.length), entry.content]));
  }
  return hash.digest('hex');
}

t('dod6-schema: launcherSection hashes payload trees in the canonical form (type, mode, path, content, link target)', () => withFixture({}, async fx => {
  const make = name => { const dir = path.join(fx.base, name); fs.mkdirSync(dir); return dir; };
  const hashOf = dir => must(() => launcherSection({ version: '1', agentPayload: dir, egressPayload: dir, skill: dir })).skill_sha256;
  const a = make('p-a');
  fs.mkdirSync(path.join(a, 'sub'));
  fs.writeFileSync(path.join(a, 'sub', 'ü.txt'), 'content\n');
  fs.writeFileSync(path.join(a, 'b'), 'x');
  fs.writeFileSync(path.join(a, 'B'), 'y');
  fs.symlinkSync('sub/ü.txt', path.join(a, 'link'));
  // A directory and a sibling file whose names sort the other way round than a depth-first walk meets them: 'd.b' sorts before 'd/x'.
  fs.mkdirSync(path.join(a, 'd'));
  fs.writeFileSync(path.join(a, 'd', 'x'), 'inner');
  fs.writeFileSync(path.join(a, 'd.b'), 'sibling');
  assert.equal(hashOf(a), canonicalOracle(a), 'the hash is the canonical hash');
  const section = must(() => launcherSection({ version: '9.9', agentPayload: a, egressPayload: make('p-e'), skill: a }));
  assert.deepEqual(Object.keys(section), ['version', 'agent_payload_sha256', 'egress_payload_sha256', 'skill_sha256']);
  assert.equal(section.version, '9.9');
  assert.equal(section.agent_payload_sha256, canonicalOracle(a));
  assert.equal(section.egress_payload_sha256, canonicalOracle(path.join(fx.base, 'p-e')));
  assert.notEqual(section.agent_payload_sha256, section.egress_payload_sha256);
  // A directory differs from an empty file, a mode from another mode, a link target from another target; content and path matter.
  const dir = make('d1');
  const file = make('d2');
  fs.mkdirSync(path.join(dir, 'thing'));
  fs.writeFileSync(path.join(file, 'thing'), '');
  assert.notEqual(hashOf(dir), hashOf(file), 'a directory against an empty file');
  const c = make('m1');
  const d = make('m2');
  for (const target of [c, d]) fs.writeFileSync(path.join(target, 'f'), 'same\n');
  fs.chmodSync(path.join(c, 'f'), 0o444);
  fs.chmodSync(path.join(d, 'f'), 0o644);
  assert.notEqual(hashOf(c), hashOf(d), 'mode only');
  const e = make('l1');
  const f = make('l2');
  fs.symlinkSync('one', path.join(e, 'l'));
  fs.symlinkSync('two', path.join(f, 'l'));
  assert.notEqual(hashOf(e), hashOf(f), 'link target only');
  const g = make('r1');
  const h = make('r2');
  fs.chmodSync(g, 0o755);
  fs.chmodSync(h, 0o555);
  assert.notEqual(hashOf(g), hashOf(h), 'the root directory mode');
  const i = make('c1');
  const j = make('c2');
  fs.writeFileSync(path.join(i, 'f'), 'one');
  fs.writeFileSync(path.join(j, 'f'), 'two');
  assert.notEqual(hashOf(i), hashOf(j), 'content');
  fs.renameSync(path.join(j, 'f'), path.join(j, 'g'));
  fs.writeFileSync(path.join(j, 'g'), 'one');
  assert.notEqual(hashOf(i), hashOf(j), 'path');
  const link = make('x1');
  const fileX = make('x2');
  fs.symlinkSync('same', path.join(link, 'n'));
  fs.writeFileSync(path.join(fileX, 'n'), 'same');
  assert.notEqual(hashOf(link), hashOf(fileX), 'a link against a file with the target text as content');
  assert.ok(thrownOf(() => launcherSection({ version: '1', agentPayload: path.join(fx.base, 'absent'), egressPayload: a, skill: a })) !== null, 'a missing tree is an error');
  assert.ok(thrownOf(() => launcherSection({ version: '1', agentPayload: path.join(a, 'b'), egressPayload: a, skill: a })) !== null, 'a file is not a payload tree');
  const withFifo = make('special');
  assert.equal(spawnSync('mkfifo', [path.join(withFifo, 'pipe')]).status, 0);
  assert.match(thrownOf(() => launcherSection({ version: '1', agentPayload: withFifo, egressPayload: a, skill: a })) ?? 'no error', /special file/, 'a FIFO in a payload tree is an error');
}));

t('dod6-schema: the names of the record and the log (A6.6), and two attempts in the same second get different names', () => {
  const stage = '/m/run/S2';
  assert.deepEqual(must(() => recordNames({ stageDir: stage, tag: 'tg-1', runId: 'ignored', started: true })), { record: '/m/run/S2/run-tg-1.json', log: '/m/run/S2/run-tg-1.log' });
  assert.deepEqual(must(() => recordNames({ stageDir: stage, tag: 'tg-1', runId: '20261112T101500Z-a1b2c3', started: false })), {
    record: '/m/run/S2/run-tg-1.notstarted-20261112T101500Z-a1b2c3.json', log: '/m/run/S2/run-tg-1.notstarted-20261112T101500Z-a1b2c3.log',
  });
  assert.equal(must(() => makeRunId(new Date('2026-11-12T10:15:00.123Z'), 'a1b2c3')), '20261112T101500Z-a1b2c3');
  assert.equal(must(() => makeRunId(new Date('2026-01-02T03:04:05Z'), '000000')), '20260102T030405Z-000000');
  for (const bad of ['xyz', 'ABCDEF', 'abcde', 'abcdefg', '']) assert.notEqual(thrownOf(() => makeRunId(new Date('2026-11-12T10:15:00Z'), bad)), null, bad);
  const date = new Date('2026-11-12T10:15:00Z');
  const ids = new Set(Array.from({ length: 30 }, () => must(() => makeRunId(date))));
  assert.ok(ids.size > 25, `six random hex characters separate attempts in the same second (${ids.size} of 30)`);
  for (const id of ids) assert.match(id, /^20261112T101500Z-[0-9a-f]{6}$/);
  const names = [...ids].slice(0, 2).map(runId => must(() => recordNames({ stageDir: stage, tag: 'tg-1', runId, started: false })).record);
  assert.notEqual(names[0], names[1]);
  assert.ok(thrownOf(() => recordNames({ stageDir: stage, tag: 'a/b', runId: '20261112T101500Z-a1b2c3', started: false })) !== null, 'a tag with a slash is refused');
  assert.ok(thrownOf(() => recordNames({ stageDir: stage, tag: 'tg', runId: '../x', started: false })) !== null, 'a run id with a slash is refused');
  assert.ok(thrownOf(() => recordNames({ stageDir: 'S2', tag: 'tg', runId: '20261112T101500Z-a1b2c3', started: false })) !== null, 'the stage folder is absolute');
});

t('dod6-schema: the record is created exclusively and never overwritten (no link is followed)', () => withFixture({}, async fx => {
  const redactor = must(() => createRedactor(fx.key));
  const record = build();
  const target = path.join(fx.stage, 'run-t.json');
  const previous = process.umask(0o077);
  let written;
  try { written = must(() => writeRecord(target, record, redactor)); } finally { process.umask(previous); }
  assert.equal(written.path, target);
  const first = fs.readFileSync(target);
  assert.equal(first.toString(), must(() => serializeRecord(record, redactor)).text);
  assert.equal(first.toString().endsWith('}\n'), true);
  assert.deepEqual(JSON.parse(first.toString()), record);
  const info = fs.lstatSync(target);
  assert.ok(info.isFile() && info.nlink === 1);
  assert.equal(info.mode & 0o777, 0o644);
  const again = thrownOf(() => writeRecord(target, { ...record, run_id: '20261112T101500Z-ffffff' }, redactor));
  assert.match(again ?? 'no refusal', /exist/i);
  assert.deepEqual(fs.readFileSync(target), first, 'an existing record is never overwritten');
  const sentinel = path.join(fx.base, 'sentinel.json');
  fs.writeFileSync(sentinel, 'sentinel');
  const link = path.join(fx.stage, 'run-link.json');
  fs.symlinkSync(sentinel, link);
  assert.ok(thrownOf(() => writeRecord(link, record, redactor)) !== null, 'a link at the record path is refused');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'sentinel');
  // The descriptor is closed, the new file is flushed, and a partly written record is removed when a step fails.
  const seen = [];
  const io = { ...fs, openSync: (...args) => { const fd = fs.openSync(...args); seen.push(['open', fd]); return fd; }, closeSync: fd => { seen.push(['close', fd]); return fs.closeSync(fd); }, fsyncSync: fd => { seen.push(['fsync', fd]); return fs.fsyncSync(fd); } };
  const flushed = path.join(fx.stage, 'run-flushed.json');
  const result = must(() => writeRecord(flushed, record, redactor, io));
  assert.deepEqual(seen.map(([op]) => op), ['open', 'fsync', 'close']);
  assert.equal(seen[0][1], seen[1][1]);
  assert.equal(result.replacements, 0);
  const keyed = must(() => buildRecord(recordValues({ agent: { name: 'opencode', cli_version: fx.key, model: 'm', effort: 'high' } })));
  assert.equal(must(() => writeRecord(path.join(fx.stage, 'run-keyed.json'), keyed, redactor)).replacements, 1, 'the number of replacements is reported');
  for (const step of ['fchmodSync', 'writeFileSync', 'fsyncSync']) {
    const failing = path.join(fx.stage, `run-${step}.json`);
    const log = [];
    const broken = { ...io, openSync: fs.openSync, closeSync: fd => { log.push('close'); return fs.closeSync(fd); }, [step]: () => { throw new Error(`${step} failed`); } };
    assert.match(thrownOf(() => writeRecord(failing, record, redactor, broken)) ?? 'no error', new RegExp(`${step} failed`));
    assert.equal(fs.existsSync(failing), false, `${step}: a partly written record is removed`);
    assert.deepEqual(log, ['close'], `${step}: the descriptor is closed`);
  }
  const invalid = path.join(fx.stage, 'run-bad.json');
  assert.ok(thrownOf(() => writeRecord(invalid, { ...record, tag: 7 }, redactor)) !== null, 'an invalid record is not written');
  assert.equal(fs.existsSync(invalid), false);
}));

t('dod6-schema: every string of the record passes the redactor before serialization, and a key that is left is an error', () => withFixture({}, async fx => {
  const key = syntheticKey();
  const redactor = must(() => createRedactor(key));
  const hexKey = Buffer.from(key).toString('hex');
  const record = build({ agent: { name: 'opencode', cli_version: `v ${key}`, model: `m-${hexKey}`, effort: 'high' }, inputs: { ...recordValues().inputs, excluded: [`a/${key}`, 'plain'] } });
  const result = must(() => serializeRecord(record, redactor));
  assert.ok(!result.text.includes(key) && !result.text.includes(hexKey), 'no key form is in the serialized record');
  assert.equal(result.replacements, 3);
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.agent.cli_version, 'v [REDACTED]');
  assert.equal(parsed.agent.model, 'm-[REDACTED]');
  assert.deepEqual(parsed.inputs.excluded, ['a/[REDACTED]', 'plain']);
  assert.equal(record.agent.cli_version, `v ${key}`, 'the input record is not changed');
  assert.equal(must(() => serializeRecord(build(), redactor)).replacements, 0);
  // The key of an object is not redacted (the keys of the schema are fixed words); a key form that stays in the text is an error and never echoed.
  const shortKey = syntheticKey(15);
  const shortRedactor = must(() => createRedactor(shortKey));
  const keyed = build({ egress_totals: { ...recordValues().egress_totals, refused_by_reason: { [`acoder_${Buffer.from(shortKey).toString('hex')}`]: 1 } } });
  const refusal = thrownOf(() => serializeRecord(keyed, shortRedactor)) ?? 'no error';
  assert.match(refusal, /key/i, 'a key inside an object key stays in the text and is an error');
  assert.ok(!refusal.includes(shortKey) && !refusal.includes(Buffer.from(shortKey).toString('hex')), 'the error does not hold the key');
  const target = path.join(fx.stage, 'run-t.json');
  assert.ok(thrownOf(() => writeRecord(target, keyed, shortRedactor)) !== null);
  assert.equal(fs.existsSync(target), false);
}));

t('spec12-mount-summary: a valid mount list gives the expected summary; a writable bind, a read-write mailbox or a missing /agent changes it so that the comparison with the plan fails', () => {
  const plan = AGENT_MOUNTS();
  const good = must(() => mountSummary(AGENT_MOUNTS(), plan));
  assert.deepEqual(good, {
    writable_host_paths: ['/m/run/S2/scratch-t', '/m/run/S2/report-t.md', '/m/run/S2/report-t.json'],
    readonly_inputs: ['/m/run', '/m/exp/code'],
    memory_mounts: ['/work', '/tmp', '/agent', '/run/acoder-egress', '/run/acoder-egress'],
    equal_to_plan: true,
  });
  assert.deepEqual(must(() => summarizeMounts(plan)), { writable_host_paths: good.writable_host_paths, readonly_inputs: good.readonly_inputs, memory_mounts: good.memory_mounts });
  const extra = [...AGENT_MOUNTS(), { container: 'agent', target: '/extra', source: '/h/extra', kind: 'bind', mode: 'rw', persistent: true, role: 'scratch' }];
  const withExtra = must(() => mountSummary(extra, plan));
  assert.deepEqual(withExtra.writable_host_paths, [...good.writable_host_paths, '/extra']);
  assert.equal(withExtra.equal_to_plan, false);
  const rwMailbox = AGENT_MOUNTS().map(mount => (mount.role === 'mailbox' ? { ...mount, mode: 'rw' } : mount));
  const changed = must(() => mountSummary(rwMailbox, plan));
  assert.ok(changed.writable_host_paths.includes('/m/run') && !changed.readonly_inputs.includes('/m/run'));
  assert.equal(changed.equal_to_plan, false);
  const noAgent = AGENT_MOUNTS().filter(mount => mount.target !== '/agent');
  const dropped = must(() => mountSummary(noAgent, plan));
  assert.deepEqual(dropped.memory_mounts, ['/work', '/tmp', '/run/acoder-egress', '/run/acoder-egress']);
  assert.equal(dropped.equal_to_plan, false);
  // Each part of the summary is compared on its own: a plan that differs only in readonly inputs, or only in the order of memory mounts, is not equal.
  const roExport = AGENT_MOUNTS().filter(mount => mount.role !== 'export');
  assert.equal(must(() => mountSummary(roExport, plan)).equal_to_plan, false);
  const reordered = [...AGENT_MOUNTS().slice(0, 6), AGENT_MOUNTS()[7], AGENT_MOUNTS()[6], ...AGENT_MOUNTS().slice(8)];
  assert.equal(must(() => mountSummary(reordered, plan)).equal_to_plan, false);
  // A read-only bind that is not a mailbox or export input, and a volume or tmpfs mounted read-write, are in no host list.
  assert.deepEqual(must(() => summarizeMounts(plan)).writable_host_paths.includes('/work'), false);
  assert.equal(must(() => summarizeMounts(plan)).readonly_inputs.includes('/acoder'), false);
  // Only the recorded mounts decide: the record's summary is computed from its mounts, not taken from the caller.
  const record = build({ mounts: extra });
  assert.equal(record.mount_summary.equal_to_plan, false);
  assert.ok(record.mount_summary.writable_host_paths.includes('/extra'));
  assert.equal(build().mount_summary.equal_to_plan, true);
});

t('dod7-recorded: the ticket, export and input sections come from the prepared run (hashes of the copy, excluded subtrees, entry counts)', () => withFixture({ exports: [{ role: 'code' }, { role: 'docs', place: 'inside' }], transform: (role, manifest) => ({ ...manifest, source_commit: role === 'code' ? 'c'.repeat(40) : 'd'.repeat(64) }) }, async fx => {
  fs.mkdirSync(path.join(fx.mailbox, 'S1', 'scratch-other'));
  fs.writeFileSync(path.join(fx.mailbox, 'S1', 'scratch-other', 'big.txt'), 'x');
  const options = parseReviewRun(fx.argv({ add: [['--exclude', 'S1/scratch-other']] }).slice(2));
  const prepared = must(() => prepare(options, fx.env, {}));
  try {
    const sections = must(() => preparedSections(prepared, options));
    assert.deepEqual(Object.keys(sections), ['ticket', 'exports', 'inputs']);
    assert.deepEqual(sections.ticket, { path: fx.ticket, sha256: fx.ticketSha });
    assert.equal(sections.exports.length, 2);
    for (const [index, role] of ['code', 'docs'].entries()) {
      const entry = fx.export(role);
      assert.deepEqual(sections.exports[index], {
        role, path: entry.dir, in_mailbox: role === 'docs', manifest_path: entry.manifest, manifest_sha256: entry.manifestSha, source_commit: role === 'code' ? 'c'.repeat(40) : 'd'.repeat(64), entries: 7, verified: true,
      });
    }
    assert.deepEqual(sections.inputs, {
      snapshot_bytes: prepared.snapshot.bytes, snapshot_entries: prepared.snapshot.entries, excluded: ['S1/scratch-other'], unchanged_at_end: null, scratch_git_entries: 0, scratch_git_entries_complete: true,
    });
    assert.ok(prepared.snapshot.bytes > 0);
    const values = recordValues({ ticket: sections.ticket, exports: sections.exports, inputs: sections.inputs, tag: fx.tag });
    assert.deepEqual(problemsOf(must(() => buildRecord(values))), []);
  } finally { release(prepared); }
}));
