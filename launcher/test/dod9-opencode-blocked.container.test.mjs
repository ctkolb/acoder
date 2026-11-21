import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { AGENT_SKIP } from './helpers/container-env.mjs';
import { lastLine, LAUNCHER, sha } from './helpers/fixtures.mjs';
import { assertHealthyStreams, assertNoHostOrPathRefusal, withOpencodeRun } from './helpers/opencode-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime,
// ACODER_TEST_IMAGE or ACODER_TEST_AGENT_IMAGE (A10 item 4, S6-AC12).
const t = (name, fn, timeout = 300000) => nodeTest(name, { timeout, skip: AGENT_SKIP() }, fn);

const SKILL = path.resolve(LAUNCHER, '..', 'skills', 'acoder-reviewer');
const ROLE = fs.readFileSync(path.join(SKILL, 'references', 'role.md'), 'utf8').split('\n');
// The protocol lines that make this ticket a question to the owner: MODE: CODE without an attack list, and CONTAINER MODE's rule for it.
const lineWith = text => { const found = ROLE.filter(line => line.includes(text)); assert.equal(found.length, 1, text); return found[0]; };
const RULE_LINES = [lineWith('If the ticket has none, stop and ask the owner for one'), lineWith('Nobody can answer you. Where this protocol says to stop and ask the owner,'), lineWith('write both report files with "status": "blocked" and the question, then stop.')];
const QUESTION = 'The ticket names no attack list; MODE: CODE says to stop and ask the owner for one. Which attacks, in which order?';

// A CODE review ticket without an attack list: the reviewer protocol requires a question to the owner.
const ticketText = fx => `TICKET ${fx.tag}\nTo: REVIEWER      Mode: CODE\nStage / round: S9 (constructed for dod9-opencode-blocked)\nExport: code\nAttack list: none.\nWrite only here:\n${fx.writable.scratch}\n${fx.writable.reportMd}\n${fx.writable.reportJson}\n`;

// The script: read the ticket and the protocol (with CONTAINER MODE) through opencode's own read tool, read /acoder/run.json, then write
// both reports through apply_patch with "status": "blocked" and the question, then a closing text.
const addFile = (file, text) => ({ tool: 'apply_patch', args: { patchText: `*** Begin Patch\n*** Add File: ${file}\n${text.split('\n').map(line => `+${line}`).join('\n')}\n*** End Patch` } });
const blockedTurns = fx => [
  { tool: 'read', args: { filePath: fx.ticket } },
  { tool: 'read', args: { filePath: '/acoder/skill/references/role.md' } },
  { tool: 'read', args: { filePath: '/acoder/run.json' } },
  addFile(fx.writable.reportMd, `# Review ${fx.tag}\n\nStatus: blocked. Container launch, run_id {{run_id}}.\n\nQuestion to the owner: ${QUESTION}`),
  addFile(fx.writable.reportJson, JSON.stringify({ session: fx.tag, mode: 'CODE', status: 'blocked', question: QUESTION, isolation_note: 'container launch; run_id {{run_id}}' })),
  { text: 'Both report files are written; the review is blocked on a question to the owner.' },
];

// S6-AC8 (DoD 9) dod9-opencode-blocked: the real reviewer skill (with CONTAINER MODE) in the payload, a ticket that requires a question to
// the owner, the real opencode: the agent read the ticket and the protocol text through its read tool (the tool results it sent back to the
// endpoint hold them), and the run ends done with both reports written in place and "status": "blocked".
t('dod9-opencode-blocked: a ticket that requires a question to the owner ends done with both reports written and status blocked', async t => {
  await withOpencodeRun({
    set: { '--reviewer-skill': SKILL }, turns: blockedTurns,
    prepare: ({ fx }) => {
      fx.ticketText = ticketText(fx);
      fs.writeFileSync(fx.ticket, fx.ticketText);
      fx.ticketSha = sha(fx.ticketText);
    },
  }, async ({ context: { fx }, done, record, bodies }) => {
    assert.equal(done.code, 0, `${done.stdout}${done.stderr}`);
    assert.equal(lastLine(done.stdout), `ACODER LAUNCH ${fx.tag} done ${fx.writable.runRecord}`);
    assert.deepEqual([record.exit_reason, record.error_detail, record.conditions], ['done', null, []]);
    assert.equal(record.ticket.sha256, fx.ticketSha, 'the run used the constructed ticket');
    // What the agent read: the tool results opencode sent back with its last request.
    const last = bodies.at(-1).json;
    const results = (last.input ?? []).filter(item => item?.type === 'function_call_output').map(item => (typeof item.output === 'string' ? item.output : JSON.stringify(item.output))).join('\n');
    assert.ok(results.includes('Attack list: none.') && results.includes(`TICKET ${fx.tag}`), 'opencode read the ticket');
    for (const line of [...RULE_LINES, 'CONTAINER MODE (opt-in; set by a launcher, never by a ticket or a file)']) assert.ok(results.includes(line), `opencode read the protocol line: ${line}`);
    assert.ok(results.includes(`"run_id": "${record.run_id}"`), 'opencode read /acoder/run.json');
    // Both reports in place, the JSON report blocked with the question; the launcher's own view of them agrees.
    const md = fs.readFileSync(fx.writable.reportMd, 'utf8');
    const report = JSON.parse(fs.readFileSync(fx.writable.reportJson, 'utf8'));
    assert.ok(md.includes(QUESTION) && md.includes(record.run_id), 'the Markdown report holds the question and the run_id');
    assert.deepEqual([report.session, report.status, report.question], [fx.tag, 'blocked', QUESTION]);
    assert.ok(report.isolation_note.includes('container launch') && report.isolation_note.includes(record.run_id));
    assert.deepEqual([record.reports.md.exists, record.reports.json.parses, record.reports.json.session_matches], [true, true, true]);
    assertNoHostOrPathRefusal(record);
    assertHealthyStreams(t, 'blocked', record, bodies);
  });
});
