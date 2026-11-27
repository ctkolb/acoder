import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { formatLastLine, main } from '../lib/cli.mjs';
import { checkWritableAbsent } from '../lib/paths.mjs';
import { makeRunId } from '../lib/record.mjs';
import { OUTCOMES, PRECEDENCE, STATES, agentConditions, decideExit, evaluateRun, exitCodeOf, failureOutcome } from '../lib/state.mjs';
import { BOUNDARIES, runLifecycle } from './helpers/fake-lifecycle.mjs';
import { attempt, lastLine, listing, must, runMain, thrownOf, withFixture } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own. The test is registered from this file, so that the mutation runner can count it per module.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, async (...args) => {
  // A failure that is not an assertion (a TypeError from a broken module) is reported as an assertion failure.
  try { return await fn(...args); } catch (error) { if (error?.code === 'ERR_ASSERTION') throw error; assert.fail(`threw: ${String(error?.message ?? error)}`); }
});

// The order of A6.5, written out here once more (the tests do not take it from the module).
const ORDER = [
  'secret_found',
  'secret_scan_incomplete', 'egress_protocol_error', 'egress_sidecar_exited', 'runtime_failure', 'input_snapshot_changed', 'usage_unreported',
  'interrupted',
  'budget',
  'agent_failed', 'agent_exit_nonzero', 'no_model_request', 'last_model_request_failed', 'report_missing', 'report_invalid',
];
const decide = input => must(() => decideExit({ flags: [], budgetKinds: [], tokensLowerBound: false, ...input }));

t('spec09-state: the states, the outcomes, the exit codes and the order of A6.5', () => {
  assert.deepEqual(STATES, ['V', 'S', 'E2', 'E3', 'G', 'R', 'A', 'T', 'C', 'F']);
  assert.deepEqual(OUTCOMES, ['refused', 'not-started', 'done', 'budget', 'error']);
  assert.deepEqual(PRECEDENCE, [
    ['secret_found'],
    ['secret_scan_incomplete', 'egress_protocol_error', 'egress_sidecar_exited', 'runtime_failure', 'input_snapshot_changed', 'usage_unreported'],
    ['interrupted'],
    ['budget'],
    ['agent_failed', 'agent_exit_nonzero', 'no_model_request', 'last_model_request_failed', 'report_missing', 'report_invalid'],
  ]);
  assert.deepEqual(Object.fromEntries(OUTCOMES.map(outcome => [outcome, must(() => exitCodeOf(outcome))])), { refused: 2, 'not-started': 1, done: 0, budget: 3, error: 1 });
  assert.ok(thrownOf(() => exitCodeOf('finished')) !== null, 'an unknown outcome is an error');
});

t('spec09-state: a failure at each effect boundary gives the outcome, exit code, record, leftovers and retry eligibility of the table (real files, fake runtime)', async () => {
  const expectations = {
    V: { outcome: 'refused', code: 2, record: null, removedAll: true, retry: true },
    S: { outcome: 'refused', code: 2, record: null, removedAll: true, retry: true },
    E2: { outcome: 'not-started', code: 1, record: 'notstarted', detail: 'runtime_failure', retry: true },
    E3: { outcome: 'not-started', code: 1, record: 'notstarted', detail: 'runtime_failure', retry: true },
    G: { outcome: 'not-started', code: 1, record: 'notstarted', detail: 'gate_failed', retry: true },
    'R-before-started': { outcome: 'not-started', code: 1, record: 'notstarted', detail: 'runtime_failure', retry: true },
    'R-after-started': { outcome: 'error', code: 1, record: 'run', detail: 'runtime_failure', retry: false },
  };
  assert.deepEqual(BOUNDARIES, Object.keys(expectations));
  for (const boundary of BOUNDARIES) {
    await withFixture({ noExport: true }, async fx => {
      const before = listing(fx.base);
      const initial = fs.readdirSync(fx.stage).sort();
      const result = must(() => runLifecycle({ fx, failAt: boundary }));
      const want = expectations[boundary];
      const label = `${boundary}`;
      assert.equal(result.outcome.outcome, want.outcome, label);
      assert.equal(must(() => exitCodeOf(result.outcome.outcome)), want.code, label);
      assert.equal(result.outcome.exit_code, want.code, label);
      assert.deepEqual(result.resources, [], `${label}: no runtime resource is left`);
      assert.equal(fs.existsSync(result.staging ?? path.join(fx.base, 'none')), false, `${label}: the staging directory is removed`);
      const retry = attempt(() => checkWritableAbsent(result.writable)) === undefined;
      assert.equal(retry, want.retry, `${label}: retry eligibility`);
      assert.equal(result.outcome.retry, want.retry, label);
      if (want.removedAll) {
        assert.equal(result.recordFile, null, label);
        assert.deepEqual(listing(fx.base), before, `${label}: a refusal leaves the tree byte for byte as it was`);
        return;
      }
      const stem = `run-${fx.tag}`;
      if (want.record === 'notstarted') {
        const names = [`${stem}.notstarted-${result.runId}.json`, `${stem}.notstarted-${result.runId}.log`];
        assert.deepEqual(result.stageNames, [...initial, ...names].sort(), `${label}: only the attempt record and its log remain`);
        assert.equal(result.recordFile, path.join(fx.stage, names[0]));
        assert.equal(fs.existsSync(result.writable.scratch), false, `${label}: the empty scratch directory is removed`);
        assert.equal(fs.existsSync(result.writable.reportMd) || fs.existsSync(result.writable.reportJson), false, `${label}: the empty report files are removed`);
      } else {
        const names = [result.writable.scratch, result.writable.reportMd, result.writable.reportJson, result.writable.startedRecord, path.join(fx.stage, `${stem}.json`), path.join(fx.stage, `${stem}.log`)].map(file => path.basename(file));
        assert.deepEqual(result.stageNames, [...initial, ...names].sort(), `${label}: a started ticket keeps its scratch, reports, started file, record and log`);
        assert.equal(result.recordFile, path.join(fx.stage, `${stem}.json`));
      }
      const record = JSON.parse(fs.readFileSync(result.recordFile, 'utf8'));
      assert.equal(record.error_detail, want.detail, label);
      assert.equal(record.exit_reason, want.record === 'run' ? 'error' : null, label);
      assert.equal(result.outcome.error_detail, want.detail, label);
    });
  }
});

t('spec09-state: the table itself (what each state removes, what it leaves, the error detail), and an interrupt in the same place', () => {
  const failure = (state, extra) => must(() => failureOutcome(state, extra));
  assert.deepEqual(failure('V', {}), { state: 'V', outcome: 'refused', exit_code: 2, record: 'none', log: 'none', error_detail: null, retry: true, remove: [], leaves: [] });
  assert.deepEqual(failure('S', {}), { state: 'S', outcome: 'refused', exit_code: 2, record: 'none', log: 'none', error_detail: null, retry: true, remove: ['staging'], leaves: [] });
  const attemptRemoved = ['staging', 'report_md', 'report_json', 'scratch'];
  const runtimeRemoved = ['agent', 'egress', 'volume', 'network'];
  assert.deepEqual(failure('E2', {}), { state: 'E2', outcome: 'not-started', exit_code: 1, record: 'notstarted', log: 'notstarted', error_detail: 'runtime_failure', retry: true, remove: attemptRemoved, leaves: ['record', 'log'] });
  assert.deepEqual(failure('E3', {}), { state: 'E3', outcome: 'not-started', exit_code: 1, record: 'notstarted', log: 'notstarted', error_detail: 'runtime_failure', retry: true, remove: [...runtimeRemoved, ...attemptRemoved], leaves: ['record', 'log'] });
  assert.deepEqual(failure('G', {}), { state: 'G', outcome: 'not-started', exit_code: 1, record: 'notstarted', log: 'notstarted', error_detail: 'gate_failed', retry: true, remove: [...runtimeRemoved, ...attemptRemoved], leaves: ['record', 'log'] });
  assert.deepEqual(failure('R', { startedFileWritten: false }), {
    state: 'R', outcome: 'not-started', exit_code: 1, record: 'notstarted', log: 'notstarted', error_detail: 'runtime_failure', retry: true, remove: [...runtimeRemoved, ...attemptRemoved], leaves: ['record', 'log'],
  });
  assert.deepEqual(failure('R', { startedFileWritten: true }), {
    state: 'R', outcome: 'error', exit_code: 1, record: 'run', log: 'run', error_detail: 'runtime_failure', retry: false, remove: [...runtimeRemoved, 'staging'], leaves: ['scratch', 'report_md', 'report_json', 'started_file', 'record', 'log'],
  });
  assert.deepEqual(failure('R', {}), failure('R', { startedFileWritten: false }), 'the started file defaults to not written');
  // An interrupt in the same place: the not-started record says interrupted, a started ticket ends error with interrupted; refusals stay refusals.
  for (const state of ['E2', 'E3', 'G', 'R']) assert.equal(failure(state, { interrupted: true }).error_detail, 'interrupted', state);
  assert.equal(failure('R', { startedFileWritten: true, interrupted: true }).error_detail, 'interrupted');
  assert.equal(failure('R', { startedFileWritten: true, interrupted: true }).outcome, 'error');
  assert.equal(failure('V', { interrupted: true }).outcome, 'refused');
  assert.equal(failure('S', { interrupted: true }).error_detail, null);
  for (const state of ['A', 'T', 'C', 'F', 'X', undefined, 'constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.notEqual(thrownOf(() => failureOutcome(state, {})), null, `${state} is not an effect boundary`);
});

t('spec09-state: two attempts in the same second get different record names, and the first does not block the second', () => withFixture({ noExport: true }, async fx => {
  const date = new Date('2026-11-12T10:15:00Z');
  const first = must(() => runLifecycle({ fx, failAt: 'G', date, random: 'aaaaaa' }));
  assert.equal(attempt(() => checkWritableAbsent(first.writable)), undefined, 'the not-started attempt can be retried');
  const second = must(() => runLifecycle({ fx, failAt: 'G', date, random: 'bbbbbb' }));
  assert.notEqual(first.recordFile, second.recordFile);
  assert.equal(first.runId.slice(0, 16), second.runId.slice(0, 16), 'the same second');
  assert.ok(fs.existsSync(first.recordFile) && fs.existsSync(second.recordFile), 'both records exist side by side');
  assert.deepEqual(fs.readdirSync(fx.stage).filter(name => name.includes('.notstarted-')).length, 4, 'two records and two logs');
  assert.equal(makeRunId(date, 'aaaaaa').length, makeRunId(date, 'bbbbbb').length);
}));

t('spec09-state: the exit reason by precedence: every pair of adjacent steps, in both input orders', () => {
  const supply = names => decide({ flags: names.filter(name => name !== 'budget'), budgetKinds: names.includes('budget') ? ['calls'] : [] });
  for (let index = 0; index + 1 < ORDER.length; index += 1) {
    const [winner, loser] = [ORDER[index], ORDER[index + 1]];
    for (const names of [[winner, loser], [loser, winner]]) {
      const result = supply(names);
      const label = `${winner} before ${loser} (${names.join(',')})`;
      assert.deepEqual(result.conditions, [winner, loser], label);
      if (winner === 'budget') { assert.equal(result.exit_reason, 'budget', label); assert.equal(result.outcome, 'budget'); assert.equal(result.exit_code, 3); assert.equal(result.error_detail, null); }
      else { assert.equal(result.exit_reason, 'error', label); assert.equal(result.error_detail, winner, label); assert.equal(result.outcome, 'error'); assert.equal(result.exit_code, 1); }
    }
  }
  // All of them at once: the first wins and every one is listed, in the order of A6.5.
  const everything = supply(ORDER);
  assert.equal(everything.error_detail, 'secret_found');
  assert.deepEqual(everything.conditions, ORDER);
  // Nothing held is done.
  assert.deepEqual(decide({}), { exit_reason: 'done', budget_kind: null, error_detail: null, conditions: [], outcome: 'done', exit_code: 0 });
});

t('spec09-state: simultaneous secret_found and a call limit give error with secret_found and both conditions; budget alone is budget with its first kind', () => {
  const both = decide({ flags: ['secret_found'], budgetKinds: ['calls'] });
  assert.deepEqual(both, { exit_reason: 'error', budget_kind: 'calls', error_detail: 'secret_found', conditions: ['secret_found', 'budget'], outcome: 'error', exit_code: 1 });
  assert.deepEqual(decide({ budgetKinds: ['calls', 'wall_clock'] }), { exit_reason: 'budget', budget_kind: 'calls', error_detail: null, conditions: ['budget'], outcome: 'budget', exit_code: 3 });
  assert.equal(decide({ budgetKinds: ['wall_clock', 'calls'] }).budget_kind, 'wall_clock', 'the first limit that the launcher learned of');
  for (const kind of ['wall_clock', 'calls', 'tokens', 'disk']) assert.equal(decide({ budgetKinds: [kind] }).budget_kind, kind);
  // The interrupt outranks a budget stop; a scan that could not finish outranks a disk budget (A8.6).
  assert.equal(decide({ flags: ['interrupted'], budgetKinds: ['wall_clock'] }).error_detail, 'interrupted');
  assert.equal(decide({ flags: ['secret_scan_incomplete'], budgetKinds: ['disk'] }).error_detail, 'secret_scan_incomplete');
  // secret_found has precedence over secret_scan_incomplete and both stay in the conditions.
  const found = decide({ flags: ['secret_scan_incomplete', 'secret_found'] });
  assert.equal(found.error_detail, 'secret_found');
  assert.deepEqual(found.conditions, ['secret_found', 'secret_scan_incomplete']);
  // tokens_lower_bound is a condition that never decides the reason; it is listed last.
  const lower = decide({ budgetKinds: ['tokens'], tokensLowerBound: true });
  assert.equal(lower.exit_reason, 'budget');
  assert.deepEqual(lower.conditions, ['budget', 'tokens_lower_bound']);
  assert.deepEqual(decide({ tokensLowerBound: true }), { exit_reason: 'done', budget_kind: null, error_detail: null, conditions: ['tokens_lower_bound'], outcome: 'done', exit_code: 0 });
  // Duplicates are listed once; unknown input is an error, and budget is given only as a kind.
  assert.deepEqual(decide({ flags: ['secret_found', 'secret_found'] }).conditions, ['secret_found']);
  assert.notEqual(thrownOf(() => decideExit({ flags: ['nope'], budgetKinds: [] })), null);
  assert.notEqual(thrownOf(() => decideExit({ flags: ['budget'], budgetKinds: [] })), null, 'budget needs a kind');
  assert.notEqual(thrownOf(() => decideExit({ flags: [], budgetKinds: ['memory'] })), null);
});

const forwarded = (seq, closedSecond, status, complete = true, over = {}) => ({
  seq, phase: 'agent', opened: '2026-11-12T10:15:00.000Z', closed: `2026-11-12T10:15:${String(closedSecond).padStart(2, '0')}.000Z`, host: 'models.example.org', decision: 'forwarded', reason: null,
  status, complete, bytes_up: 1, bytes_down: 1, usage: null, response_model: null, ...over,
});
const REPORTS_OK = { md: { exists: true, bytes: 5 }, json: { exists: true, bytes: 9, parses: true, session_matches: true } };
const GOOD = { agent: { code: 0, signal: null, outcome: 'success' }, egress_log: [forwarded(1, 5, 200)], reports: REPORTS_OK };
const evaluate = (over = {}) => must(() => evaluateRun({ flags: [], budgetKinds: [], tokensLowerBound: false, scan_status: 'clean', ...GOOD, ...over }));
const reports = (md, json) => ({ md: { ...REPORTS_OK.md, ...md }, json: { ...REPORTS_OK.json, ...json } });

t('spec16-outcome: the done rule of A6.5 over adapter outcome, exit code, the last forwarded request, forwarded count, reports and the scan', () => {
  assert.deepEqual(evaluate(), { exit_reason: 'done', budget_kind: null, error_detail: null, conditions: [], outcome: 'done', exit_code: 0 });
  const detail = over => evaluate(over).error_detail;
  // The adapter's outcome and the exit code.
  assert.equal(detail({ agent: { code: 0, signal: null, outcome: 'error' } }), 'agent_failed');
  assert.equal(detail({ agent: { code: 1, signal: null, outcome: 'error' } }), 'agent_exit_nonzero');
  assert.equal(detail({ agent: { code: 1, signal: null, outcome: 'success' } }), 'agent_exit_nonzero');
  assert.equal(detail({ agent: { code: null, signal: 'SIGKILL', outcome: 'error' } }), 'agent_exit_nonzero');
  assert.equal(detail({ agent: { code: 0, signal: 'SIGTERM', outcome: 'success' } }), 'agent_exit_nonzero', 'a signal is never done');
  assert.equal(detail({ agent: { code: null, signal: null, outcome: null } }), 'agent_exit_nonzero', 'an agent that has no exit');
  assert.equal(detail({ agent: { code: 0, signal: null, outcome: null } }), 'agent_failed', 'done needs the adapter outcome success');
  assert.equal(evaluate({ agent: null }).error_detail, null, 'no agent facts at all (the agent never ran) add no agent condition');
  // The forwarded requests: none; the last one (latest closed, tie: greatest seq) must be complete with 2xx.
  assert.equal(detail({ egress_log: [] }), 'no_model_request');
  assert.equal(detail({ egress_log: [forwarded(1, 5, 429, true, { decision: 'refused', reason: 'acoder_budget_calls' })] }), 'no_model_request', 'a refused request is not a call');
  assert.equal(detail({ egress_log: [forwarded(1, 5, 200, true, { decision: 'local', host: null })] }), 'no_model_request', 'the local probe path is not a call');
  assert.equal(detail({ egress_log: [forwarded(1, 5, 500)] }), 'last_model_request_failed');
  assert.equal(detail({ egress_log: [forwarded(1, 5, 200, false)] }), 'last_model_request_failed');
  assert.equal(detail({ egress_log: [forwarded(1, 5, null, true)] }), 'last_model_request_failed');
  for (const status of [199, 300, 301, 404, 429, 599, '200', null, undefined, 200.5]) assert.equal(detail({ egress_log: [forwarded(1, 5, status)] }), 'last_model_request_failed', String(status));
  for (const status of [200, 201, 204, 299]) assert.equal(detail({ egress_log: [forwarded(1, 5, status)] }), null, String(status));
  assert.equal(detail({ egress_log: [forwarded(1, 3, 500), forwarded(2, 9, 200)] }), null, 'an early failure does not matter');
  assert.equal(detail({ egress_log: [forwarded(1, 9, 500), forwarded(2, 3, 200)] }), 'last_model_request_failed', 'the latest closed counts, not the last in the list');
  assert.equal(detail({ egress_log: [forwarded(2, 9, 200), forwarded(1, 9, 500)] }), null, 'tie on the closing time: the greatest sequence number');
  assert.equal(detail({ egress_log: [forwarded(1, 9, 200), forwarded(2, 9, 500)] }), 'last_model_request_failed');
  assert.equal(detail({ egress_log: [forwarded(1, 5, 200), forwarded(2, 9, 500, true, { decision: 'refused', reason: 'acoder_in_flight' })] }), null, 'a later refusal does not hide a good last call');
  assert.equal(detail({ egress_log: [forwarded(1, 5, 200), forwarded(2, 9, null, false, { decision: 'forwarded' })] }), 'last_model_request_failed', 'an aborted last request fails');
  // Reports: both regular and non-empty; the JSON report parses and its session equals the tag.
  assert.equal(detail({ reports: reports({ exists: false }, {}) }), 'report_missing');
  assert.equal(detail({ reports: reports({ bytes: 0 }, {}) }), 'report_missing');
  assert.equal(detail({ reports: reports({}, { exists: false }) }), 'report_missing');
  assert.equal(detail({ reports: reports({}, { bytes: 0 }) }), 'report_missing');
  assert.equal(detail({ reports: reports({}, { parses: false, session_matches: false }) }), 'report_invalid');
  assert.equal(detail({ reports: reports({}, { parses: true, session_matches: false }) }), 'report_invalid');
  assert.equal(detail({ reports: reports({}, { parses: false, session_matches: true }) }), 'report_invalid');
  assert.equal(detail({ reports: reports({ exists: false }, { parses: false }) }), 'report_missing', 'missing is reported before invalid');
  assert.equal(detail({ reports: reports({}, { exists: false, parses: false }) }), 'report_missing', 'a missing JSON report is missing, not invalid');
  assert.deepEqual(evaluate({ reports: reports({ exists: false }, { parses: false }) }).conditions, ['report_missing'], 'a missing report is not also invalid');
  // The scan must be clean: found is secret_found, incomplete and not run are secret_scan_incomplete.
  assert.equal(detail({ scan_status: 'found' }), 'secret_found');
  assert.equal(detail({ scan_status: 'incomplete' }), 'secret_scan_incomplete');
  assert.equal(detail({ scan_status: 'not_run' }), 'secret_scan_incomplete');
  assert.deepEqual(evaluate({ scan_status: 'found', flags: ['secret_found'] }).conditions, ['secret_found'], 'the scan result and its condition are one condition');
  assert.equal(evaluate({ scan_status: 'clean', flags: ['secret_found'] }).error_detail, 'secret_found', 'a key reflected by the endpoint is secret_found with a clean scan');
  assert.match(thrownOf(() => evaluateRun({ flags: [], budgetKinds: [], tokensLowerBound: false, scan_status: 'dirty', ...GOOD })) ?? 'no error', /unknown scan status/);
  // A limit event is never done; an independent failure of the same run keeps its precedence.
  assert.equal(evaluate({ budgetKinds: ['calls'] }).exit_reason, 'budget');
  const both = evaluate({ budgetKinds: ['wall_clock'], agent: { code: null, signal: 'SIGKILL', outcome: 'error' }, egress_log: [] });
  assert.equal(both.exit_reason, 'budget');
  assert.deepEqual(both.conditions, ['budget', 'agent_exit_nonzero', 'no_model_request']);
  assert.equal(evaluate({ flags: ['runtime_failure'], budgetKinds: ['calls'] }).error_detail, 'runtime_failure');
  // The conditions are listed in the order of A6.5 whatever the order of the facts.
  const many = evaluate({ flags: ['egress_protocol_error', 'secret_found'], agent: { code: 1, signal: null, outcome: 'error' }, egress_log: [], reports: reports({ exists: false }, {}) });
  assert.deepEqual(many.conditions, ['secret_found', 'egress_protocol_error', 'agent_exit_nonzero', 'no_model_request', 'report_missing']);
});

t('spec16-outcome: agentConditions lists the step 5 conditions in order and nothing else', () => {
  const conditions = over => must(() => agentConditions({ ...GOOD, ...over }));
  assert.deepEqual(conditions({}), []);
  assert.deepEqual(conditions({ agent: { code: 1, signal: null, outcome: 'error' }, egress_log: [], reports: reports({ bytes: 0 }, {}) }), ['agent_exit_nonzero', 'no_model_request', 'report_missing']);
  assert.deepEqual(conditions({ agent: { code: 0, signal: null, outcome: 'error' }, egress_log: [forwarded(1, 5, 500)], reports: reports({}, { parses: false }) }), ['agent_failed', 'last_model_request_failed', 'report_invalid']);
  assert.deepEqual(conditions({ agent: null }), []);
});

t('spec13-lastline: the last line of A1.6 for refused, not-started, done, budget and error', () => {
  const record = '/m/run/S2/run-tg-1.json';
  assert.equal(must(() => formatLastLine({ tag: 'tg-1', outcome: 'refused', record: '-' })), 'ACODER LAUNCH tg-1 refused -');
  assert.equal(must(() => formatLastLine({ tag: 'tg-1', outcome: 'not-started', record: '/m/run/S2/run-tg-1.notstarted-20261112T101500Z-a1b2c3.json' })), 'ACODER LAUNCH tg-1 not-started /m/run/S2/run-tg-1.notstarted-20261112T101500Z-a1b2c3.json');
  for (const outcome of ['done', 'budget', 'error']) assert.equal(must(() => formatLastLine({ tag: 'tg-1', outcome, record })), `ACODER LAUNCH tg-1 ${outcome} ${record}`);
  assert.equal(must(() => formatLastLine({ tag: '-', outcome: 'refused', record: '-' })), 'ACODER LAUNCH - refused -', 'the tag is - when it could not be established');
  assert.equal(must(() => formatLastLine({ tag: 'tg-1', outcome: 'error', record: '-' })), 'ACODER LAUNCH tg-1 error -', 'no record was written');
  for (const bad of [{ tag: 'tg 1', outcome: 'done', record }, { tag: '', outcome: 'done', record }, { tag: 'a'.repeat(121), outcome: 'done', record }, { tag: 'tg', outcome: 'finished', record },
    { tag: 'tg', outcome: 'done', record: 'relative/run.json' }, { tag: 'tg', outcome: 'done', record: '' }, { tag: 'tg', outcome: 'done', record: '/a\nb' }, { tag: 'tg', outcome: 'refused', record }]) {
    assert.notEqual(thrownOf(() => formatLastLine(bad)), null, JSON.stringify(bad));
  }
});

t('spec13-lastline: the command prints the refused last line as the last line, for a usage error and for a refusal, and the error line for an internal failure', () => withFixture({}, async fx => {
  const usage = await runMain(['review', 'run', '--bogus']);
  assert.equal(usage.code, 2);
  assert.equal(lastLine(usage.stdout), 'ACODER LAUNCH - refused -');
  const missing = await fx.run({ drop: ['--budget-calls'] });
  assert.equal(lastLine(missing.stdout), 'ACODER LAUNCH - refused -', 'a flag error: the tag could not be established');
  const refused = await fx.run({ set: { '--ticket-sha256': 'f'.repeat(64) } });
  assert.equal(refused.code, 2);
  assert.equal(lastLine(refused.stdout), `ACODER LAUNCH ${fx.tag} refused -`);
  assert.equal(refused.stdout.trimEnd().split('\n').at(-1), lastLine(refused.stdout));
  const broken = await fx.run({ deps: { afterSnapshot: () => { throw new Error('boom'); } } });
  assert.equal(broken.code, 1);
  assert.equal(lastLine(broken.stdout), `ACODER LAUNCH ${fx.tag} error -`);
  assert.equal(typeof main, 'function');
}));
