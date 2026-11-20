import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { AGENT_SKIP } from './helpers/container-env.mjs';
import { assertNoHostOrPathRefusal, withOpencodeRun } from './helpers/opencode-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime,
// ACODER_TEST_IMAGE or ACODER_TEST_AGENT_IMAGE (A10 item 4, S6-AC12).
const t = (name, fn, timeout = 300000) => nodeTest(name, { timeout, skip: AGENT_SKIP() }, fn);

// S6-AC4 (DoD 3; D-Q6) dod3-opencode-egress: in a run of the real opencode, every request that reached the sidecar in the agent phase was
// forwarded to the endpoint: none was refused for its host or its path, so opencode completed with the allowlisted host and the two admitted
// request kinds only. The sidecar's own summary agrees (no agent-phase refusal of any reason), and its forwarded count is the endpoint's.
t('dod3-opencode-egress: opencode reaches nothing through the sidecar but the allowlisted host and the admitted request kinds', async () => {
  await withOpencodeRun({}, async ({ done, record, requests }) => {
    assert.equal(done.code, 0, `${done.stdout}${done.stderr}`);
    assert.equal(record.exit_reason, 'done', JSON.stringify(record.conditions));
    assertNoHostOrPathRefusal(record);
    const agent = record.egress_log.filter(entry => entry.phase === 'agent');
    assert.deepEqual(agent.filter(entry => entry.decision !== 'forwarded'), [], 'every agent-phase request was forwarded');
    assert.ok(agent.every(entry => entry.host === 'model.stub.test' && entry.status === 200 && entry.complete === true), 'each went to the allowlisted host and ended complete');
    assert.equal(agent.length, requests.length, 'the forwarded requests are the ones the endpoint received');
    assert.ok(requests.every(entry => ['/v1/responses', '/v1/chat/completions'].includes(entry.url)), 'only the admitted request kinds');
  });
});
