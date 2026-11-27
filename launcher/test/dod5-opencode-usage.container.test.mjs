import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { AGENT_SKIP } from './helpers/container-env.mjs';
import { assertHealthyStreams, assertNoHostOrPathRefusal, opencodeEvents, withOpencodeRun } from './helpers/opencode-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime,
// ACODER_TEST_IMAGE or ACODER_TEST_AGENT_IMAGE (A10 item 4, S6-AC12).
const t = (name, fn, timeout = 300000) => nodeTest(name, { timeout, skip: AGENT_SKIP() }, fn);

// The usage the endpoint sends with every answer: cached input within input and reasoning within output (A6.4), so every field counts.
const USAGE = { input_tokens: 13, output_tokens: 5, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } };

// S6-AC5 (DoD 5): the record's usage against the endpoint's own count and the usage it sent, and the advisory counts against opencode's own
// step_finish events. The forwarded calls and the advisory calls differ by opencode's title request, which is forwarded but is no step:
// the difference is printed, not asserted. S6-AC13: the stream counts of the run.
async function runAndCount(t, label, scenario) {
  await withOpencodeRun({ scenario: { usage: USAGE, ...scenario } }, async ({ done, record, bodies, requests }) => {
    assert.equal(done.code, 0, `${done.stdout}${done.stderr}`);
    assert.deepEqual([record.exit_reason, record.error_detail, record.conditions], ['done', null, []]);
    assertNoHostOrPathRefusal(record);
    assert.equal(record.usage.calls_forwarded, requests.length, 'the forwarded calls are the endpoint\'s own count');
    assert.equal(record.usage.counted_by, 'egress');
    const sent = bodies.map(entry => entry.usage);
    assert.ok(sent.length >= 5 && sent.every(usage => usage !== null), 'the endpoint sent usage with every answer');
    const sum = field => sent.reduce((total, usage) => total + field(usage), 0);
    const input = sum(usage => usage.input_tokens);
    const output = sum(usage => usage.output_tokens);
    assert.deepEqual(record.usage.tokens, {
      input, output, reasoning: sum(usage => usage.output_tokens_details.reasoning_tokens), cached_input: sum(usage => usage.input_tokens_details.cached_tokens), total: input + output,
    }, 'the token totals are the sums the endpoint sent');
    // The advisory counts are opencode's own: one call per step_finish event and the sums of their part.tokens.
    const steps = opencodeEvents(record).filter(event => event.type === 'step_finish');
    assert.ok(steps.length >= 4, `opencode finished its steps (${steps.length})`);
    const tally = field => steps.reduce((total, event) => total + (field(event.part.tokens) ?? 0), 0);
    assert.deepEqual(record.usage.advisory, {
      calls: steps.length, counted_by: 'adapter:opencode',
      tokens: { input: tally(x => x.input), output: tally(x => x.output), reasoning: tally(x => x.reasoning), cache_read: tally(x => x.cache?.read), cache_write: tally(x => x.cache?.write) },
    }, 'usage.advisory holds opencode\'s own numbers');
    t.diagnostic(`S6-AC5 ${label}: forwarded ${record.usage.calls_forwarded} tokens ${JSON.stringify(record.usage.tokens)}; advisory ${JSON.stringify(record.usage.advisory)}; side requests without tools ${bodies.filter(entry => !(entry.json.tools?.length > 0)).length}`);
    assertHealthyStreams(t, label, record, bodies);
  });
}

// S6-AC5 and S6-AC13 (healthy scenario, run twice consecutively).
t('dod5-opencode-usage: the forwarded calls and token totals are the endpoint\'s; the advisory counts are opencode\'s (two consecutive runs)', async t => {
  for (const run of [1, 2]) await runAndCount(t, `usage run ${run}`, {});
});

// S6-AC13 with the usage withheld until the last event (spec08-usage): every streamed answer sends its last event, the only one with the
// usage, 1500 ms after the others. Opencode waits for it: no stream is cancelled before its usage (two consecutive runs).
t('dod5-opencode-usage: with the usage withheld until the last event opencode cancels no stream before its usage (two consecutive runs)', async t => {
  for (const run of [1, 2]) await runAndCount(t, `usage-withheld run ${run}`, { usage_delay_ms: 1500 });
});
