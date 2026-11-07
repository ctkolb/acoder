import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import MarkdownIt from 'markdown-it';
import GithubSlugger from 'github-slugger';
import { parse as parseYaml } from 'yaml';

const markdown = new MarkdownIt();
const requireThat = (condition, message) => assert.ok(condition, message);
const json = async file => JSON.parse(await readFile(file, 'utf8'));

async function filesUnder(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.filter(e => !['.git', 'node_modules'].includes(e.name)).map(async e => {
    const file = path.join(root, e.name);
    requireThat(!e.isSymbolicLink(), `Unexpected symlink: ${file}`);
    return e.isDirectory() ? filesUnder(file) : [file];
  }));
  return files.flat();
}

export async function checkLinks(root) {
  root = path.resolve(root);
  const files = await filesUnder(root);
  const pages = new Map();
  for (const file of files.filter(f => f.endsWith('.md'))) {
    const tokens = markdown.parse(await readFile(file, 'utf8'), {});
    const slugger = new GithubSlugger();
    const anchors = new Set();
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type === 'heading_open') {
        const text = (tokens[i + 1].children ?? []).map(t => t.content).join('');
        anchors.add(slugger.slug(text));
      }
    }
    pages.set(file, { tokens, anchors });
  }
  for (const [file, { tokens }] of pages) {
    for (const token of tokens.flatMap(t => t.children ?? [])) {
      const href = token.type === 'link_open' ? token.attrGet('href')
        : token.type === 'image' ? token.attrGet('src') : null;
      if (href === null || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue;
      const [relative, fragment] = href.split('#');
      const target = relative ? path.resolve(path.dirname(file), decodeURIComponent(relative)) : file;
      requireThat(target === root || target.startsWith(root + path.sep), `${file}: link escapes package: ${href}`);
      await stat(target).catch(() => { throw new Error(`${file}: broken link: ${href}`); });
      if (fragment && target.endsWith('.md')) {
        requireThat(pages.get(target)?.anchors.has(decodeURIComponent(fragment)), `${file}: missing anchor: ${href}`);
      }
    }
  }
}

export async function checkSkills(root) {
  const skills = path.join(root, 'skills');
  const names = (await readdir(skills, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
  assert.deepEqual(names.sort(), ['acoding-builder', 'acoding-orchestrator', 'acoding-reviewer']);
  for (const name of names) {
    const source = path.join(skills, name);
    const text = await readFile(path.join(source, 'SKILL.md'), 'utf8');
    const frontMatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    requireThat(frontMatter, `${name}: missing YAML front matter`);
    const metadata = parseYaml(frontMatter[1]);
    assert.equal(metadata.name, name, `${name}: name must match directory`);
    requireThat(typeof metadata.description === 'string' && metadata.description.trim(), `${name}: missing description`);
    const agent = parseYaml(await readFile(path.join(source, 'agents/openai.yaml'), 'utf8'));
    assert.equal(agent.policy?.allow_implicit_invocation, false, `${name}: implicit invocation must be disabled`);
    await stat(path.join(source, 'references/role.md'));
    if (name === 'acoding-orchestrator') await stat(path.join(source, 'references/directed.md'));
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'acoding-skill-'));
    try {
      const installed = path.join(temporary, name);
      await cp(source, installed, { recursive: true });
      await checkLinks(installed);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

const transitions = {
  pending: ['active', 'superseded'],
  active: ['awaiting_validation', 'blocked', 'superseded'],
  awaiting_validation: ['completed', 'rework', 'blocked', 'superseded'],
  rework: ['awaiting_validation', 'superseded'],
  blocked: ['superseded'], completed: [], superseded: [],
};

export async function checkExamples(root) {
  const examples = path.join(root, 'examples');
  const files = await filesUnder(examples);
  const objects = new Map();
  for (const file of files.filter(f => f.endsWith('.json'))) objects.set(path.basename(file), await json(file));
  const ledger = objects.get('tickets.json');
  requireThat(Array.isArray(ledger?.tickets) && ledger.tickets.length, 'Missing ticket inventory');
  const tickets = new Map(ledger.tickets.map(t => [t.tag, t]));
  assert.equal(tickets.size, ledger.tickets.length, 'Duplicate ticket tags');
  const lines = (await readFile(path.join(examples, 'ticket-events.jsonl'), 'utf8')).trim().split('\n');
  const states = new Map();
  for (const line of lines) {
    const event = JSON.parse(line);
    requireThat(tickets.has(event.tag), `Unknown event tag: ${event.tag}`);
    requireThat(Number.isInteger(event.revision) && event.revision >= 0, 'Invalid event revision');
    requireThat(typeof event.reason === 'string' && event.reason.trim(), 'Missing event reason');
    const prior = states.get(event.tag);
    if (!prior) {
      assert.equal(event.state, 'pending', 'First event must be pending');
      assert.equal(event.revision, 0, 'First revision must be zero');
    } else {
      requireThat(transitions[prior.state]?.includes(event.state), `Invalid transition: ${prior.state} -> ${event.state}`);
      assert.equal(event.revision, prior.revision + (event.state === 'rework' ? 1 : 0), 'Invalid revision transition');
    }
    states.set(event.tag, event);
  }
  for (const ticket of tickets.values()) {
    const final = states.get(ticket.tag);
    requireThat(final, `No events for ${ticket.tag}`);
    assert.equal(final.state, ticket.state, `${ticket.tag}: ledger state differs from events`);
    assert.equal(final.revision, ticket.revision, `${ticket.tag}: ledger revision differs from events`);
    requireThat(['BUILDER', 'REVIEWER'].includes(ticket.role), 'Invalid ticket role');
    assert.equal(ticket.ticket, `<mailbox>/S1/ticket-${ticket.tag}.md`);
    const text = await readFile(path.join(examples, path.basename(ticket.ticket)), 'utf8');
    requireThat(text.startsWith(`TICKET ${ticket.tag}\n`), 'Ticket header mismatch');
    requireThat(text.includes(`To: ${ticket.role}`), 'Ticket role mismatch');
    const suffix = ticket.revision ? `-w${ticket.revision}` : '';
    assert.equal(ticket.report, `<mailbox>/S1/report-${ticket.tag}${suffix}.json`);
    requireThat(objects.has(path.basename(ticket.report)), 'Selected report does not exist');
    if (ticket.revision) await stat(path.join(examples, `rework-${ticket.tag}${suffix}.md`));
  }
  const commonArrays = ['coverage', 'measurements'];
  for (const [filename, report] of objects) {
    if (!filename.startsWith('report-')) continue;
    const match = filename.match(/^report-(.+?)(?:-w([1-9]\d*))?\.json$/);
    requireThat(match && tickets.has(match[1]), `Unknown report: ${filename}`);
    const ticket = tickets.get(match[1]);
    const paired = filename.replace(/\.json$/, '.md');
    await stat(path.join(examples, paired));
    assert.equal(report.session, ticket.tag, `${filename}: session mismatch`);
    assert.equal(report.stage, 'S1');
    assert.equal(report.report_path, `<mailbox>/S1/${paired}`, `${filename}: report path mismatch`);
    const builder = ticket.role === 'BUILDER';
    const arrays = builder
      ? ['remaining_work', 'files_changed', 'contracts_addressed', 'checks', 'red_evidence', 'mutants', 'findings_addressed', 'candidates', 'adjacent_findings', 'blockers']
      : ['reviewed_exports', 'findings', 'mutations', 'builder_mutants', 'corpora', 'commands', 'scripts', 'riskiest_points', 'not_checked'];
    for (const field of [...commonArrays, ...arrays]) requireThat(Array.isArray(report[field]), `${filename}: ${field} must be an array`);
    for (const field of builder ? ['base_commit', 'head_commit'] : ['reviewed_commit']) {
      requireThat(typeof report[field] === 'string' && /^[a-f\d]{40}$/.test(report[field]), `${filename}: invalid ${field}`);
    }
    requireThat(['ready', 'complete', 'blocked', 'incomplete'].includes(report.status), `${filename}: invalid status`);
    requireThat(typeof report.mode === 'string' && ticket.tag.includes(`-${report.mode}-`), `${filename}: mode mismatch`);
    if (builder) {
      requireThat(typeof report.plan_first === 'boolean', 'plan_first must be boolean');
      for (const field of ['calls_used', 'calls_limit']) requireThat(Number.isInteger(report[field]) && report[field] >= 0, `Invalid ${field}`);
    } else {
      assert.equal(report.repository_unchanged, true);
      requireThat(['READY', 'NOT_READY'].includes(report.verdict), 'Invalid verdict');
      for (let i = 1; i <= 6; i++) requireThat(['met', 'not_met', 'not_required'].includes(report.evidence_minimums?.[`E${i}`]), `Invalid E${i}`);
      assert.deepEqual(report.validator, { status: 'not_available', command: null, exit_code: null, output: null });
      for (const command of report.commands) {
        requireThat(typeof command.command === 'string' && command.command.trim(), 'Missing command');
        requireThat(Number.isInteger(command.exit_code), 'Invalid command exit code');
      }
    }
  }
  // This is an intentionally rejected synthetic report, not operational evidence.
  const original = objects.get('report-demo-S1-R-CODE-r3.json');
  const corrected = objects.get('report-demo-S1-R-CODE-r3-w1.json');
  assert.equal(original.evidence_minimums.E4, 'not_met', 'Preserve the rejected E4 example');
  assert.deepEqual(original.commands, [], 'Preserve the omitted commands example');
  assert.equal(corrected.evidence_minimums.E4, 'met', 'Corrected E4 must be met');
  requireThat(corrected.commands.length > 0, 'Corrected report must supply commands');
  requireThat(typeof corrected.versions.language === 'string' && Number.isInteger(corrected.versions.tests_run) && corrected.versions.tests_run > 0, 'Corrected report must supply runtime and test count');
}

export async function validate(root) {
  await checkLinks(root);
  await checkSkills(root);
  await checkExamples(root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await validate(path.resolve(process.argv[2] ?? '.'));
    console.log('Validated local links, isolated skill packages, metadata, and synthetic examples.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
