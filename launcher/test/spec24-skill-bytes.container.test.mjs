import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { AGENT_SKIP } from './helpers/container-env.mjs';
import { fixtureBase, forceRemove, LAUNCHER, sha } from './helpers/fixtures.mjs';
import { assertHealthyStreams, assertNoHostOrPathRefusal, withOpencodeRun } from './helpers/opencode-run.mjs';
import { minimalValue, reportTemplate, shapeErrors } from './helpers/reviewer-json-shape.mjs';
import { treeHash } from './helpers/tree-hash.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime,
// ACODER_TEST_IMAGE or ACODER_TEST_AGENT_IMAGE (A10 item 4, S6-AC12).
const t = (name, fn, timeout = 300000) => nodeTest(name, { timeout, skip: AGENT_SKIP() }, fn);

const REPO = path.resolve(LAUNCHER, '..');
const SKILL = path.join(REPO, 'skills', 'acoder-reviewer');
const git = args => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });

// The test's own hash of skills/acoder-reviewer at the tested commit: the files of HEAD (read with git, not from the working tree) in a
// tree of their own with the payload modes of the snapshot (directories 0555, files 0444), hashed by the test's tree hash (tree-hash.mjs).
function skillHashAtHead() {
  const dir = fs.mkdtempSync(path.join(fixtureBase(), 'sk-'));
  try {
    const root = path.join(dir, 'skill');
    const files = git(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'skills/acoder-reviewer']).split('\n').filter(Boolean);
    assert.ok(files.length > 0, 'the tested commit holds the reviewer skill');
    for (const file of files) {
      const target = path.join(root, path.relative('skills/acoder-reviewer', file));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, execFileSync('git', ['-C', REPO, 'show', `HEAD:${file}`]));
      fs.chmodSync(target, 0o444);
    }
    const dirs = [];
    const walk = d => { dirs.push(d); for (const name of fs.readdirSync(d)) { const full = path.join(d, name); if (fs.lstatSync(full).isDirectory()) walk(full); } };
    walk(root);
    for (const d of dirs.reverse()) fs.chmodSync(d, 0o555);
    const texts = Object.fromEntries(['SKILL.md', 'references/role.md'].map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
    return { hash: treeHash(root), text: name => texts[name] };
  } finally {
    forceRemove(dir);
  }
}

// S6-AC3 (DoD 9; SPEC-24) spec24-skill-bytes: the real reviewer skill of the tested commit (which contains R1 and R2) is the run's
// --reviewer-skill; the record's skill hash equals the test's own hash of the skill at HEAD, and the agent saw the same hash in
// /acoder/run.json. The scripted agent writes a JSON report with every required field of the protocol, each carrying a value of the type
// and of the allowed values that the skill's report block states (reviewer-json-shape.mjs), whose isolation_note carries "container launch" and
// the run_id it read, and the Markdown report that is its pair; the record describes both. The report's content is SCRIPTED (a minimal
// valid report built from the skill's template): no model judgment is tested, only that such a report goes through the launch intact.
t('spec24-skill-bytes: the payload skill is the reviewer skill of the tested commit byte for byte; the reports have the protocol\'s structure', async t => {
  assert.equal(git(['status', '--porcelain', '--', 'skills/acoder-reviewer']), '', 'the reviewer skill in the work tree is the tested commit\'s');
  const expected = skillHashAtHead();
  assert.ok(expected.text('SKILL.md').includes('An opt-in container launcher may start this session unattended.'), 'the skill contains R1');
  assert.ok(expected.text('references/role.md').includes('CONTAINER MODE'), 'the skill contains R2');
  const template = reportTemplate(expected.text('references/role.md'));
  const fields = Object.keys(template);
  const reports = fx => ({
    md: `# Review ${fx.tag}\n\nContainer launch, run_id {{run_id}}. Scripted report; the JSON report is its pair.`,
    json: { ...minimalValue(template), session: fx.tag, isolation_note: 'container launch; run_id {{run_id}}', status: 'complete' },
  });
  await withOpencodeRun({ set: { '--reviewer-skill': SKILL }, reports }, async ({ context: { fx }, done, record, bodies }) => {
    assert.equal(done.code, 0, `${done.stdout}${done.stderr}`);
    assert.equal(record.exit_reason, 'done', JSON.stringify(record.conditions));
    assert.equal(record.launcher.skill_sha256, expected.hash, 'the record\'s skill hash is the hash of the skill at the tested commit');
    const seen = bodies.flatMap(entry => (entry.json.input ?? []).filter(item => item?.type === 'function_call_output').map(item => String(item.output)));
    assert.ok(seen.some(text => text.includes(`"skill_sha256": "${expected.hash}"`)), 'the agent read the same skill hash in /acoder/run.json');
    const report = JSON.parse(fs.readFileSync(fx.writable.reportJson, 'utf8'));
    assert.deepEqual(fields.filter(field => !(field in report)), [], 'the JSON report has every required field');
    assert.deepEqual(shapeErrors(report, template), [], 'each field carries a value of the type and allowed values the skill states');
    assert.ok(['complete', 'incomplete', 'blocked'].includes(report.status) && ['READY', 'READY_WITH_CHANGES', 'NOT_READY'].includes(report.verdict), `status and verdict are allowed values: ${report.status}, ${report.verdict}`);
    assert.equal(report.session, fx.tag);
    assert.ok(report.isolation_note.includes('container launch') && report.isolation_note.includes(record.run_id), `isolation_note names the launch and the run_id: ${report.isolation_note}`);
    const md = fs.readFileSync(fx.writable.reportMd, 'utf8');
    assert.equal(path.basename(fx.writable.reportMd), `report-${fx.tag}.md`, 'the Markdown report is the pair of the JSON report');
    assert.equal(path.dirname(fx.writable.reportMd), path.dirname(fx.writable.reportJson));
    assert.ok(md.includes(fx.tag) && md.includes(record.run_id), 'the Markdown report names the tag and the run_id');
    assert.deepEqual(record.reports.md, { path: fx.writable.reportMd, exists: true, bytes: Buffer.byteLength(md), sha256: sha(md) });
    const jsonText = fs.readFileSync(fx.writable.reportJson);
    assert.deepEqual(record.reports.json, { path: fx.writable.reportJson, exists: true, bytes: jsonText.length, sha256: sha(jsonText), parses: true, session_matches: true });
    assertNoHostOrPathRefusal(record);
    // S6-AC13: the stream counts of the run.
    assertHealthyStreams(t, 'spec24-skill-bytes', record, bodies);
  });
});
