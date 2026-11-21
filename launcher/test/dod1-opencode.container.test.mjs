import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodeTest from 'node:test';
import { AGENT_SKIP } from './helpers/container-env.mjs';
import { lastLine } from './helpers/fixtures.mjs';
import { assertHealthyStreams, assertNoHostOrPathRefusal, DEFAULT_EFFORT, DEFAULT_MODEL, withOpencodeRun } from './helpers/opencode-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime,
// ACODER_TEST_IMAGE or ACODER_TEST_AGENT_IMAGE (A10 item 4, S6-AC12).
const t = (name, fn, timeout = 300000) => nodeTest(name, { timeout, skip: AGENT_SKIP() }, fn);

// S6-AC2 (DoD 1): one run of the real opencode, one call of main with flags only and no prompt (standard input closed); the expected model
// and effort of every request the endpoint received. F17: every request opencode sent is `POST <base>/responses`. S6-AC13: the stream counts.
async function runAndCheck(t, label, { extraArgs = [], model, effort }) {
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
    // Every request names the model and the effort of the run, the conversation requests (those that offer opencode's tools) and opencode's
    // side request without tools for the session title alike (D-R47: the adapter sets small_model to the run's model; without it opencode
    // chose gpt-5.4-nano with effort none and service_tier flex for the title).
    const conversation = bodies.filter(entry => Array.isArray(entry.json.tools) && entry.json.tools.length > 0);
    assert.ok(conversation.length >= 4, `the read, the two report writes and the closing text were requested (${conversation.length})`);
    assert.deepEqual(bodies.map(entry => [entry.json.model, entry.json.reasoning?.effort]), bodies.map(() => [model, effort]), 'every request names the run\'s model and effort');
    assert.deepEqual(bodies.filter(entry => 'service_tier' in entry.json).map(entry => entry.n), [], 'no request asks for a service tier the owner did not choose');
    assertNoHostOrPathRefusal(record);
    assertHealthyStreams(t, label, record, bodies);
  });
}

t('dod1-opencode: one command with flags only runs the real opencode to done; the requests carry the default model and effort "high"', async t => {
  await runAndCheck(t, 'dod1-opencode defaults', { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT });
});

t('dod1-opencode: --model and --effort override the defaults in every request', async t => {
  await runAndCheck(t, 'dod1-opencode overrides', { extraArgs: [['--model', 'gpt-override-1'], ['--effort', 'low']], model: 'gpt-override-1', effort: 'low' });
});
