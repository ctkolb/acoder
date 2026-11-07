import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkExamples, checkLinks, checkSkills, validate } from './validate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'acoding-check-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  for (const directory of ['skills', 'examples']) {
    await cp(path.join(root, directory), path.join(temporary, directory), { recursive: true });
  }
  return temporary;
}

async function editJson(root, name, change) {
  const file = path.join(root, 'examples', name);
  const value = JSON.parse(await readFile(file, 'utf8'));
  change(value);
  await writeFile(file, JSON.stringify(value));
}

test('current repository passes, including the deliberately rejected original report', async () => {
  await validate(root);
});

test('missing links and anchors fail; fenced examples do not create links', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'links.md');
  await writeFile(file, '# Heading\n\n[ok](#heading)\n\n```text\n[example](missing.md)\n```\n');
  await checkLinks(directory);
  await writeFile(file, '[broken](missing.md)\n');
  await assert.rejects(checkLinks(directory), /broken link/);
  await writeFile(file, '# Heading\n\n[broken](#absent)\n');
  await assert.rejects(checkLinks(directory), /missing anchor/);
});

test('skill dependencies on sibling packages fail isolated installation', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'skills/acoding-builder/SKILL.md');
  await writeFile(file, (await readFile(file, 'utf8')) + '\n[Sibling](../acoding-reviewer/SKILL.md)\n');
  await checkLinks(directory); // It exists in a checkout, but not when installed alone.
  await assert.rejects(checkSkills(directory), /link escapes package/);
});

test('implicit invocation cannot be enabled accidentally', async t => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, 'skills/acoding-builder/agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: true\n');
  await assert.rejects(checkSkills(directory), /implicit invocation/);
});

test('ledger drift and selecting an obsolete report fail', async t => {
  const directory = await fixture(t);
  await editJson(directory, 'tickets.json', value => { value.tickets[2].revision = 0; });
  await assert.rejects(checkExamples(directory), /ledger revision/);
  await editJson(directory, 'tickets.json', value => {
    value.tickets[2].revision = 1;
    value.tickets[2].report = '<mailbox>/S1/report-demo-S1-R-CODE-r3.json';
  });
  // Node may insert ANSI escapes between individual characters in its diff.
  // Check the error's values rather than its terminal-formatted message.
  await assert.rejects(checkExamples(directory), {
    code: 'ERR_ASSERTION',
    actual: '<mailbox>/S1/report-demo-S1-R-CODE-r3.json',
    expected: '<mailbox>/S1/report-demo-S1-R-CODE-r3-w1.json',
  });
});

test('invalid event transitions fail even when final ledger state is unchanged', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'examples/ticket-events.jsonl');
  const events = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  events.splice(1, 1); // pending cannot jump directly to awaiting_validation.
  await writeFile(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  await assert.rejects(checkExamples(directory), /Invalid transition/);
});

test('report identity, field types, and missing Markdown pairs fail', async t => {
  const directory = await fixture(t);
  const report = 'report-demo-S1-B-BUILD-r2.json';
  await editJson(directory, report, value => { value.session = 'wrong'; });
  await assert.rejects(checkExamples(directory), /session mismatch/);
  await editJson(directory, report, value => {
    value.session = 'demo-S1-B-BUILD-r2';
    value.checks = 'not an array';
  });
  await assert.rejects(checkExamples(directory), /checks must be an array/);
  await editJson(directory, report, value => { value.checks = []; });
  await rm(path.join(directory, 'examples', report.replace('.json', '.md')));
  await assert.rejects(checkExamples(directory), /ENOENT/);
});

test('corrected evidence cannot lose its commands', async t => {
  const directory = await fixture(t);
  await editJson(directory, 'report-demo-S1-R-CODE-r3-w1.json', value => { value.commands = []; });
  await assert.rejects(checkExamples(directory), /must supply commands/);
});
