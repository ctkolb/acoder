import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { expectRefusal, listing, withFixture, parseJson } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own. The test is registered from this file, so that the mutation runner can count it per module.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, fn);

const dryRun = (fx, options) => fx.run(options);

// States V and S on the snapshot: the ticket, the ledger and the plan of a dry run (S2-AC2, S2-AC4, S2-AC5, S2-AC9, S2-AC18).
t('dod2-paths rule 2: line 1 is exactly TICKET <tag> and line 2 starts with To: REVIEWER', () => withFixture({}, async fx => {
  const original = fx.ticketText;
  const cases = { 'a different tag': original.replace('TICKET fx-S2-r1', 'TICKET fx-S2-r2'), 'trailing text on line 1': original.replace('TICKET fx-S2-r1', 'TICKET fx-S2-r1 '), 'no header': original.split('\n').slice(2).join('\n'),
    'a builder ticket': original.replace('To: REVIEWER', 'To: BUILDER'), 'a lower-case role': original.replace('To: REVIEWER', 'To: reviewer'), 'a leading blank line': `\n${original}` };
  for (const [name, text] of Object.entries(cases)) {
    fs.writeFileSync(fx.ticket, text);
    const sha = createHash('sha256').update(text).digest('hex');
    await expectRefusal(fx, { set: { '--ticket-sha256': sha } }, /ticket/).catch(error => { error.message = `${name}: ${error.message}`; throw error; });
  }
}));
t('dod2-paths rule 3: the ledger holds exactly one entry with this tag, role REVIEWER, state pending', () => withFixture({}, async fx => {
  const entry = { tag: fx.tag, role: 'REVIEWER', state: 'pending' };
  const cases = {
    'no entry': [{ tag: 'other', role: 'REVIEWER', state: 'pending' }], 'two entries': [entry, entry], 'two entries with different roles': [entry, { ...entry, role: 'BUILDER' }],
    'role BUILDER': [{ ...entry, role: 'BUILDER' }], 'state active': [{ ...entry, state: 'active' }], 'state completed': [{ ...entry, state: 'completed' }], 'role lower case': [{ ...entry, role: 'reviewer' }],
  };
  for (const [name, tickets] of Object.entries(cases)) {
    fs.writeFileSync(fx.ledger, JSON.stringify({ tickets }));
    await expectRefusal(fx, {}, /ledger|tickets\.json/).catch(error => { error.message = `${name}: ${error.message}`; throw error; });
  }
  fs.writeFileSync(fx.ledger, 'not json');
  await expectRefusal(fx, {}, /ledger|tickets\.json/);
  for (const text of ['{}', '{"tickets": 3}', '"text"', 'null', '3']) {
    fs.writeFileSync(fx.ledger, text);
    await expectRefusal(fx, {}, /ledger|tickets\.json/).catch(error => { error.message = `${text}: ${error.message}`; throw error; });
  }
  fs.writeFileSync(fx.ledger, JSON.stringify([entry]));
  assert.equal((await dryRun(fx, {})).code, 0, 'a ledger that is a plain list of entries is read too');
}));

t('spec01-scratch-exists: the ticket text must contain each of the three path strings', () => withFixture({}, async fx => {
  for (const missing of [fx.writable.scratch, fx.writable.reportMd, fx.writable.reportJson]) {
    const text = fx.ticketText.replace(`${missing}\n`, '');
    fs.writeFileSync(fx.ticket, text);
    const sha = createHash('sha256').update(text).digest('hex');
    await expectRefusal(fx, { set: { '--ticket-sha256': sha } }, /ticket.*(path|contain)/).catch(error => { error.message = `${missing}: ${error.message}`; throw error; });
  }
}));
t('dod2-home: a .git entry inside the copied tree is refused (rule 5), unless that subtree is excluded', () => withFixture({}, async fx => {
  fs.mkdirSync(path.join(fx.mailbox, 'S1', 'scratch-other', '.git'), { recursive: true });
  await expectRefusal(fx, {}, /\.git/i);
  const result = await fx.run({ add: [['--exclude', 'S1/scratch-other']] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(parseJson(result.stdout).excluded, ['S1/scratch-other']);
}));

t('dry-run: prints one JSON plan, exits 0 and leaves nothing behind', () => withFixture({}, async fx => {
  const before = listing(fx.base);
  const result = await fx.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trimEnd().split('\n').filter(line => line.startsWith('ACODER LAUNCH')).length, 0);
  const plan = parseJson(result.stdout);
  assert.equal(plan.dry_run, true);
  assert.equal(plan.tag, fx.tag);
  assert.equal(plan.ticket?.sha256, fx.ticketSha);
  assert.equal(plan.image.check, 'not_run');
  assert.equal(plan.runtime.check, 'not_run');
  assert.equal(plan.image.ref, `sha256:${'b'.repeat(64)}`);
  assert.equal(plan.exports?.length, 1);
  assert.equal(plan.exports?.[0]?.role, 'code');
  assert.equal(plan.exports?.[0]?.manifest_sha256, fx.export('code').manifestSha);
  assert.match(plan.exports?.[0]?.tree_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(plan.writable, { scratch: fx.writable.scratch, report_md: fx.writable.reportMd, report_json: fx.writable.reportJson });
  assert.equal(plan.agent, 'opencode');
  assert.equal(plan.provider, 'openai');
  assert.equal(plan.model, 'gpt-6-luna');
  assert.equal(plan.key.env, 'ACODER_MODEL_API_KEY');
  assert.ok(!result.stdout.includes(fx.key) && !result.stderr.includes(fx.key), 'no key value is printed');
  assert.deepEqual(listing(fx.base), before, 'the staging directory is gone and the mailbox is unchanged');
  assert.equal(fs.readdirSync(fx.staging).length, 0);
  assert.equal(fs.existsSync(fx.writable.scratch), false);
  assert.equal(fs.existsSync(fx.writable.reportMd), false);
}));

t('dry-run: with --no-export and with an export inside the mailbox', () => withFixture({ noExport: true }, async fx => {
  const result = await fx.run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(parseJson(result.stdout).exports, []);
  await withFixture({ exports: [{ role: 'code', place: 'inside' }] }, async inside => {
    const again = await inside.run();
    assert.equal(again.code, 0, again.stderr);
    assert.equal(parseJson(again.stdout).exports?.[0]?.inside_mailbox, true);
    assert.equal(fs.readdirSync(inside.staging).length, 0);
  });
}));

t('dry-run: a refusal removes the staging directory and has no effect', () => withFixture({}, async fx => {
  await expectRefusal(fx, { set: { '--ticket-sha256': 'f'.repeat(64) } }, /ticket/);
  assert.equal(fs.readdirSync(fx.staging).length, 0);
}));

t('dry-run: the plan carries the mailbox, the exports, the snapshot figures, the runtime and the allowed image variables', () => withFixture({ exports: [{ role: 'code' }, { role: 'docs', place: 'inside' }] }, async fx => {
  const result = await fx.run({ add: [['--runtime', 'podman'], ['--allow-image-env', 'FOO_BAR'], ['--allow-image-env', 'BAZ'], ['--exclude', 'S1']] });
  assert.equal(result.code, 0, result.stderr);
  const plan = parseJson(result.stdout);
  assert.equal(plan.mailbox, fx.mailbox);
  assert.deepEqual(plan.excluded, ['S1']);
  assert.deepEqual(plan.allow_image_env, ['FOO_BAR', 'BAZ']);
  assert.deepEqual(plan.runtime, { name: 'podman', check: 'not_run' });
  assert.ok(plan.snapshot?.bytes > 0 && plan.snapshot?.entries > 0);
  assert.match(plan.snapshot?.skill_sha256, /^[0-9a-f]{64}$/);
  assert.equal(plan.ticket?.path, fx.ticket);
  const [code, docs] = plan.exports;
  assert.equal(code?.path, fx.export('code').dir);
  assert.equal(code?.manifest, fx.export('code').manifest);
  assert.equal(code?.source_commit, 'a'.repeat(40));
  assert.equal(code?.entries, 7);
  assert.equal(code?.inside_mailbox, false);
  assert.equal(docs?.inside_mailbox, true);
  assert.notEqual(code?.tree_sha256, undefined);
  assert.equal(code?.tree_sha256, docs?.tree_sha256, 'two exports of equal content have equal tree hashes');
}));
