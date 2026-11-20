// The opencode tests (S6): the real opencode of ACODER_TEST_AGENT_IMAGE, launched through the one main() with flags only, against the scripted
// endpoint (opencode-endpoint.mjs) in the topology of withContainerEnv. The script makes opencode read /acoder/run.json and write both
// report files with its own tools (observed in S6: for an `openai` model opencode offers `read` and `apply_patch`, not `write`).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AGENT_IMAGE_ID } from './container-env.mjs';
import { withContainerEnv } from './container-run.mjs';
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

// options: tag, extraArgs (flags added to the launch), set (flag values that replace the fixture's), reports(fx), fixture. fn receives
// {context, done, record, bodies, requests}: the launcher's {code, stdout, stderr}, the run record, and the endpoint's recorded bodies and
// requests.
export async function withOpencodeRun(options, fn) {
  return withContainerEnv({
    tag: options.tag ?? 'oc-S6-r1', fixture: options.fixture, endpointProgram: OPENCODE_ENDPOINT, launchArgs: [],
    set: { '--image': AGENT_IMAGE_ID(), ...(options.set ?? {}) },
    answers: ({ fx }) => ({ turns: reportTurns(fx, options.reports?.(fx)) }),
  }, async context => {
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
