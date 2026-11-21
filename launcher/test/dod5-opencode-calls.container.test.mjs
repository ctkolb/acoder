import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { AGENT_SKIP } from './helpers/container-env.mjs';
import { lastLine } from './helpers/fixtures.mjs';
import { assertNoHostOrPathRefusal, opencodeEvents, withOpencodeRun } from './helpers/opencode-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime,
// ACODER_TEST_IMAGE or ACODER_TEST_AGENT_IMAGE (A10 item 4, S6-AC12).
const t = (name, fn, timeout = 300000) => nodeTest(name, { timeout, skip: AGENT_SKIP() }, fn);
const L = 3;

// S6-AC6 (DoD 5): the scripted conversation needs five requests (the title, the read, the two report writes, the closing text); with a call
// limit of 3 the surplus is refused with 429 acoder_budget_calls, the endpoint counted exactly 3 and the run ends budget, calls. F22: how
// opencode reacted to the 429 (its events after the refusal, its exit, the time to the end) is printed as a diagnostic for the report.
t('dod5-opencode-calls: with a call limit below what the conversation needs the surplus is refused and the run ends budget, calls', async t => {
  await withOpencodeRun({ set: { '--budget-calls': String(L) } }, async ({ context: { fx }, done, record, requests }) => {
    assert.equal(done.code, 3, `${done.stdout}${done.stderr}`);
    assert.equal(lastLine(done.stdout), `ACODER LAUNCH ${fx.tag} budget ${fx.writable.runRecord}`);
    assert.deepEqual([record.exit_reason, record.budget_kind, record.limits.calls], ['budget', 'calls', L], JSON.stringify(record.conditions));
    assert.equal(requests.length, L, 'the endpoint counted exactly the limit');
    assert.equal(record.usage.calls_forwarded, L);
    const agent = record.egress_log.filter(entry => entry.phase === 'agent');
    const refused = agent.filter(entry => entry.decision === 'refused');
    assert.ok(refused.length >= 1 && refused.every(entry => entry.reason === 'acoder_budget_calls' && entry.status === 429), `the surplus was refused with 429 acoder_budget_calls: ${JSON.stringify(refused)}`);
    assert.ok(agent.indexOf(refused[0]) === L, 'the first refusal followed the L-th forwarded request');
    assertNoHostOrPathRefusal(record);
    const ms = iso => Date.parse(iso);
    const after = opencodeEvents(record).filter(event => event.timestamp > ms(refused[0].closed));
    t.diagnostic(`F22: 429 refusals ${refused.length}; opencode events after the first refusal ${JSON.stringify(after.map(event => event.type))}; agent_exit ${JSON.stringify(record.agent_exit)}; from the first refusal to the end ${ms(record.times.ended) - ms(refused[0].closed)} ms`);
  });
});
