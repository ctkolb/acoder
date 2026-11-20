import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodeTest from 'node:test';
import { AGENT_SKIP } from './helpers/container-env.mjs';
import { lastLine } from './helpers/fixtures.mjs';
import { assertNoHostOrPathRefusal, DEFAULT_EFFORT, DEFAULT_MODEL, withOpencodeRun } from './helpers/opencode-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime,
// ACODER_TEST_IMAGE or ACODER_TEST_AGENT_IMAGE (A10 item 4, S6-AC12).
const t = (name, fn, timeout = 300000) => nodeTest(name, { timeout, skip: AGENT_SKIP() }, fn);

// S6-AC2 (DoD 1): one run of the real opencode, one call of main with flags only and no prompt (standard input closed); the expected model
// and effort of every conversation request the endpoint received. F17: every request opencode sent is `POST <base>/responses`.
async function runAndCheck({ extraArgs = [], model, effort }) {
  await withOpencodeRun({ extraArgs }, async ({ context: { fx }, done, record, bodies, requests }) => {
    assert.equal(done.code, 0, `${done.stdout}${done.stderr}`);
    assert.equal(lastLine(done.stdout), `ACODER LAUNCH ${fx.tag} done ${fx.writable.runRecord}`);
    assert.deepEqual([record.exit_reason, record.error_detail, record.conditions], ['done', null, []]);
    assert.deepEqual([record.agent.name, record.agent.model, record.agent.effort], ['opencode', model, effort]);
    for (const file of [fx.writable.reportMd, fx.writable.reportJson]) assert.ok(fs.statSync(file).size > 0, `${file} is written in place`);
    assert.ok(fx.ticketText.includes(fx.writable.reportMd) && fx.ticketText.includes(fx.writable.reportJson), 'the reports are at the ticket\'s paths');
    assert.equal(JSON.parse(fs.readFileSync(fx.writable.reportJson, 'utf8')).session, fx.tag);
    assert.ok(bodies.length >= 4 && bodies.length === requests.length, `the endpoint recorded every request (${bodies.length})`);
    assert.deepEqual([...new Set(requests.map(entry => entry.url))], ['/v1/responses'], 'F17: opencode sent the Responses request kind only');
    // The conversation requests (those that offer opencode's tools) name the model and the effort of the run. Opencode also sends a side
    // request without tools for the session title, under a model of its own choice (observed in S6: gpt-5.4-nano, effort none); the A4
    // configuration does not set that model, so this test does not assert it (reported to the owner).
    const conversation = bodies.filter(entry => Array.isArray(entry.json.tools) && entry.json.tools.length > 0);
    assert.ok(conversation.length >= 4, `the read, the two report writes and the closing text were requested (${conversation.length})`);
    assert.deepEqual(conversation.map(entry => [entry.json.model, entry.json.reasoning?.effort]), conversation.map(() => [model, effort]), 'every conversation request names the run\'s model and effort');
    assertNoHostOrPathRefusal(record);
  });
}

t('dod1-opencode: one command with flags only runs the real opencode to done; the requests carry the default model and effort "high"', async () => {
  await runAndCheck({ model: DEFAULT_MODEL, effort: DEFAULT_EFFORT });
});

t('dod1-opencode: --model and --effort override the defaults in every request', async () => {
  await runAndCheck({ extraArgs: [['--model', 'gpt-override-1'], ['--effort', 'low']], model: 'gpt-override-1', effort: 'low' });
});
