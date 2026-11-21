// The opencode tests (S6): the real opencode of ACODER_TEST_AGENT_IMAGE, launched through the one main() with flags only, against the scripted
// endpoint (opencode-endpoint.mjs) in the topology of withContainerEnv. The script makes opencode read /acoder/run.json and write both
// report files with its own tools (observed in S6: for an `openai` model opencode offers `read` and `apply_patch`, not `write`).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AGENT_IMAGE_ID } from './container-env.mjs';
import { agentLines, withContainerEnv } from './container-run.mjs';
import { LAUNCHER } from './fixtures.mjs';
import { startLauncher } from './launcher-process.mjs';

export const OPENCODE_ENDPOINT = `${LAUNCHER}test/helpers/opencode-endpoint.mjs`;
export const DEFAULT_MODEL = 'gpt-6-luna';
export const DEFAULT_EFFORT = 'high';

// One apply_patch call that adds `file` with `text` (every line of the new file is a `+` line).
const addFile = (file, text) => ({ tool: 'apply_patch', args: { patchText: `*** Begin Patch\n*** Add File: ${file}\n${text.split('\n').map(line => `+${line}`).join('\n')}\n*** End Patch` } });

// The default reports: a Markdown report and a JSON report whose session is the tag and whose isolation note carries the run_id that
// opencode read from /acoder/run.json ({{run_id}} is filled in by the endpoint from the read tool's result).
export const defaultReports = fx => ({
  md: `# Review ${fx.tag}\n\nContainer launch, run_id {{run_id}}. Scripted report.`,
  json: { session: fx.tag, isolation_note: 'container launch; run_id {{run_id}}', status: 'complete' },
});

// The script: read /acoder/run.json, add the Markdown report, add the JSON report (one line), then a closing text.
export function reportTurns(fx, reports = defaultReports(fx)) {
  return [
    { tool: 'read', args: { filePath: '/acoder/run.json' } },
    addFile(fx.writable.reportMd, reports.md),
    addFile(fx.writable.reportJson, JSON.stringify(reports.json)),
    { text: 'Both report files are written.' },
  ];
}

// options: tag, extraArgs (flags added to the launch), set (flag values that replace the fixture's), reports(fx), turns(fx) (a script that
// replaces reportTurns), scenario (further fields of the endpoint's script: usage, usage_delay_ms, fail_after, after), prepare(context)
// (called before the launch, for example to rewrite the ticket), fixture. fn receives {context, done, record, bodies, requests}: the
// launcher's {code, stdout, stderr}, the run record, and the endpoint's recorded bodies and requests.
export async function withOpencodeRun(options, fn) {
  return withContainerEnv({
    tag: options.tag ?? 'oc-S6-r1', fixture: options.fixture, endpointProgram: OPENCODE_ENDPOINT, launchArgs: [],
    set: { '--image': AGENT_IMAGE_ID(), ...(options.set ?? {}) },
    answers: ({ fx }) => ({ turns: options.turns?.(fx) ?? reportTurns(fx, options.reports?.(fx)), ...(options.scenario ?? {}) }),
  }, async context => {
    await options.prepare?.(context);
    const done = await startLauncher(context, { extraArgs: options.extraArgs ?? [] }).done;
    const file = context.fx.writable.runRecord;
    const record = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    assert.ok(record !== null, `a record was written: ${done.stdout}${done.stderr}`);
    const bodies = context.endpointBodies().map(entry => ({ ...entry, json: JSON.parse(entry.body) }));
    return fn({ context, done, record, bodies, requests: context.endpointRequests() });
  });
}

// S6-AC4 (D-Q6): no agent-phase entry of the egress log was refused for its host or its path, and at least one request was forwarded.
export function assertNoHostOrPathRefusal(record) {
  const agent = record.egress_log.filter(entry => entry.phase === 'agent');
  const refused = agent.filter(entry => ['acoder_host_not_allowed', 'acoder_path_not_allowed'].includes(entry.reason));
  assert.deepEqual(refused, [], 'S6-AC4: no agent request was refused for its host or its path');
  assert.ok(agent.some(entry => entry.decision === 'forwarded'), 'at least one agent request was forwarded');
}

// S6-AC13: the stream behavior of one opencode run, from the record and the endpoint's recorded bodies. pre_usage_aborts: forwarded
// agent-phase requests that ended incomplete without usage; usage_unreported: 1 when the record holds that condition; retries: requests
// that repeat an earlier one (a conversation request with the same number of tool results, or a second side request without tools);
// chat_requests and include_usage: chat completions requests, and those that ask for stream_options.include_usage.
export function streamCounts(record, bodies) {
  const forwarded = record.egress_log.filter(entry => entry.phase === 'agent' && entry.decision === 'forwarded');
  const keys = bodies.map(entry => (Array.isArray(entry.json.tools) && entry.json.tools.length > 0
    ? `turn ${(entry.json.input ?? entry.json.messages ?? []).filter(item => item?.type === 'function_call_output' || item?.role === 'tool').length}` : 'side'));
  const chat = bodies.filter(entry => entry.url.endsWith('/chat/completions'));
  return {
    forwarded: forwarded.length, pre_usage_aborts: forwarded.filter(entry => entry.complete !== true && entry.usage === null).length,
    usage_unreported: record.conditions.includes('usage_unreported') ? 1 : 0, usage_missing: record.usage.usage_missing,
    retries: keys.length - new Set(keys).size, chat_requests: chat.length, include_usage: chat.filter(entry => entry.json.stream_options?.include_usage === true).length,
  };
}

// S6-AC13 for a healthy scripted scenario (no injected failure): the counts are printed as a test diagnostic (the report's two-run table is
// read from it) and must all be zero, as the run ended done with a token limit set.
export function assertHealthyStreams(t, label, record, bodies) {
  const counts = streamCounts(record, bodies);
  t.diagnostic(`S6-AC13 ${label}: ${JSON.stringify(counts)}`);
  assert.deepEqual([counts.pre_usage_aborts, counts.usage_unreported, counts.usage_missing], [0, 0, 0], `S6-AC13 ${label}: no pre-usage abort and no missing usage`);
  return counts;
}

// The opencode events of the run, as the agent printed them (the log keeps every agent line).
export const opencodeEvents = record => agentLines(record).filter(line => typeof line.type === 'string');
