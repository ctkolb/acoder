import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseReviewRun } from '../lib/args.mjs';
import { treeHash } from '../lib/integrity.mjs';
import { prepare } from '../lib/prepare.mjs';
import { ENTRY_LIMIT, copyTree } from '../lib/snapshot.mjs';
import { attempt, expectRefusal, listing, t, withFixture, withWritable } from './helpers/fixtures.mjs';

const options = (fx, extra) => parseReviewRun(fx.argv(extra).slice(2));
const prepared = (fx, extra, deps) => attempt(() => prepare(options(fx, extra), fx.env, deps));
const stagingEntries = fx => fs.readdirSync(fx.staging);

async function makeSocket(file) {
  const short = fs.mkdtempSync('/tmp/ac-s-');
  const sock = path.join(short, 's');
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(sock, resolve); });
  try { fs.renameSync(sock, file); } finally { server.close(); fs.rmSync(short, { recursive: true, force: true }); }
}
const makeFifo = file => { const run = spawnSync('mkfifo', [file]); if (run.status !== 0) throw new Error('mkfifo failed'); };

// S2-AC8 (spec01-hardlink-copy): the copies are new files with link count 1.
t('spec01-hardlink-copy: a file hard-linked to a sentinel and one hard-linked to the ledger are copied as new files', () => withFixture({}, async fx => {
  const sentinel = path.join(fx.base, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'sentinel bytes\n');
  const linkedSentinel = path.join(fx.mailbox, 'S1', 'linked-sentinel.txt');
  const linkedLedger = path.join(fx.mailbox, 'S1', 'linked-ledger.json');
  fs.linkSync(sentinel, linkedSentinel);
  fs.linkSync(fx.ledger, linkedLedger);
  assert.equal(fs.lstatSync(sentinel).nlink, 2);
  const result = prepared(fx, {});
  assert.ok(result.staging, `prepare failed: ${JSON.stringify(result)}`);
  try {
    for (const [name, source] of [['linked-sentinel.txt', linkedSentinel], ['linked-ledger.json', linkedLedger]]) {
      const copy = path.join(result.staging.mailbox, 'S1', name);
      const copied = fs.lstatSync(copy);
      assert.equal(copied.nlink, 1, `${name}: link count`);
      assert.notEqual(copied.ino, fs.lstatSync(source).ino, `${name}: inode`);
      assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(source, 'utf8'));
    }
    const copy = path.join(result.staging.mailbox, 'S1', 'linked-sentinel.txt');
    withWritable(path.dirname(copy), () => { fs.chmodSync(copy, 0o644); fs.writeFileSync(copy, 'changed in the copy\n'); });
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'sentinel bytes\n', 'writing to a copy leaves the sentinel unchanged');
    assert.equal(fs.lstatSync(sentinel).nlink, 2);
  } finally { result.cleanup?.(); }
  assert.equal(stagingEntries(fx).length, 0);
}));

// spec27-special-files: each is refused with exit code 2 and the staging directory removed; --exclude lets the launch proceed.
const REFUSED_TREES = {
  'a FIFO in the mailbox': async fx => makeFifo(path.join(fx.mailbox, 'S1', 'pipe')),
  'a Unix socket in the mailbox': async fx => makeSocket(path.join(fx.mailbox, 'S1', 'sock')),
  'a FIFO in an export': async fx => withWritable(fx.export('code').dir, () => { makeFifo(path.join(fx.export('code').dir, 'pipe')); }),
  'a Unix socket in an export': async fx => { const made = path.join(fx.base, 'sock-src'); await makeSocket(made); withWritable(fx.export('code').dir, () => fs.renameSync(made, path.join(fx.export('code').dir, 'sock'))); },
  'a .git directory in another ticket scratch folder': async fx => fs.mkdirSync(path.join(fx.mailbox, 'S1', 'scratch-other', '.git'), { recursive: true }),
  'a .git file in another ticket scratch folder': async fx => { fs.mkdirSync(path.join(fx.mailbox, 'S1', 'scratch-other'), { recursive: true }); fs.writeFileSync(path.join(fx.mailbox, 'S1', 'scratch-other', '.git'), 'gitdir: x\n'); },
  'a .GIT directory in another ticket scratch folder': async fx => fs.mkdirSync(path.join(fx.mailbox, 'S1', 'scratch-other', '.GIT'), { recursive: true }),
  'a .Git link in another ticket scratch folder': async fx => { fs.mkdirSync(path.join(fx.mailbox, 'S1', 'scratch-other'), { recursive: true }); fs.symlinkSync('x', path.join(fx.mailbox, 'S1', 'scratch-other', '.Git')); },
  'a symbolic link in the mailbox outside an export': async fx => fs.symlinkSync('note.md', path.join(fx.mailbox, 'S1', 'link')),
  'a dangling symbolic link in the mailbox': async fx => fs.symlinkSync('nowhere', path.join(fx.mailbox, 'S1', 'dangling')),
  'a credential file name inside the mailbox': async fx => fs.writeFileSync(path.join(fx.mailbox, 'S1', '.NPMRC'), 'x'),
  'a credential directory inside the mailbox': async fx => fs.mkdirSync(path.join(fx.mailbox, 'S1', '.ssh')),
  'a two-component credential name inside the mailbox': async fx => fs.mkdirSync(path.join(fx.mailbox, 'S1', '.config', 'gcloud'), { recursive: true }),
  'a credential name inside an export': async fx => withWritable(fx.export('code').dir, () => { fs.chmodSync(path.join(fx.export('code').dir, 'docs'), 0o755); fs.writeFileSync(path.join(fx.export('code').dir, 'docs', '.pgpass'), 'x'); }),
  'a .git entry inside an export': async fx => withWritable(fx.export('code').dir, () => fs.mkdirSync(path.join(fx.export('code').dir, '.git'))),
  'an absolute symbolic link inside an export': async fx => withWritable(fx.export('code').dir, () => fs.symlinkSync(fx.mailbox, path.join(fx.export('code').dir, 'abs'))),
  'a symbolic link inside an export that points outside it': async fx => withWritable(fx.export('code').dir, () => fs.symlinkSync('../../run', path.join(fx.export('code').dir, 'out'))),
  'a chained symbolic link that physically escapes the export': async fx => withWritable(fx.export('code').dir, () => {
    fs.symlinkSync('..', path.join(fx.export('code').dir, 'up'));
    fs.symlinkSync('up/../run', path.join(fx.export('code').dir, 'chain'));
  }),
  'a symbolic link in the reviewer skill folder': async fx => fs.symlinkSync('SKILL.md', path.join(fx.skill, 'alias.md')),
  'a FIFO in the reviewer skill folder': async fx => makeFifo(path.join(fx.skill, 'pipe')),
  'a credential name in the reviewer skill folder': async fx => fs.writeFileSync(path.join(fx.skill, '.netrc'), 'x'),
  'a .git directory in the reviewer skill folder': async fx => fs.mkdirSync(path.join(fx.skill, '.git')),
};
for (const [name, make] of Object.entries(REFUSED_TREES)) {
  t(`spec27-special-files: ${name} is refused and the staging directory is removed`, () => withFixture({}, async fx => {
    await make(fx);
    await expectRefusal(fx, {}, /./);
    assert.equal(stagingEntries(fx).length, 0);
  }));
}
t('spec27-special-files: a symbolic link listed in the manifest and resolving inside the export is accepted, relative or chained', () => withFixture({}, async fx => {
  withWritable(fx.export('code').dir, () => fs.symlinkSync('link', path.join(fx.export('code').dir, 'chained')));
  const text = (await import('./helpers/fixtures.mjs')).buildManifestText(fx.export('code').dir);
  fs.writeFileSync(fx.export('code').manifest, text);
  const sha = (await import('./helpers/fixtures.mjs')).sha(text);
  const result = await fx.run({ set: { '--manifest-sha256': `code=${sha}` } });
  assert.equal(result.code, 0, result.stderr);
}));
t('spec27-special-files: a symbolic link that the manifest does not list is refused', () => withFixture({}, async fx => {
  withWritable(fx.export('code').dir, () => fs.symlinkSync('src/a.py', path.join(fx.export('code').dir, 'extra-link')));
  await expectRefusal(fx, {}, /code/);
}));
t('spec27-special-files: --exclude of the offending subtree lets the launch proceed and the subtree is absent from the copy', () => withFixture({}, async fx => {
  const offending = path.join(fx.mailbox, 'S1', 'scratch-other');
  fs.mkdirSync(path.join(offending, '.git'), { recursive: true });
  makeFifo(path.join(offending, 'pipe'));
  fs.symlinkSync('x', path.join(offending, 'ln'));
  fs.writeFileSync(path.join(offending, '.npmrc'), 'x');
  await expectRefusal(fx, {}, /./);
  const result = prepared(fx, { add: [['--exclude', 'S1/scratch-other']] });
  assert.ok(result.staging, JSON.stringify(result));
  try {
    assert.deepEqual(result.excluded, ['S1/scratch-other']);
    assert.equal(fs.existsSync(path.join(result.staging.mailbox, 'S1', 'scratch-other')), false);
    assert.ok(fs.existsSync(path.join(result.staging.mailbox, 'S1', 'note.md')));
  } finally { result.cleanup?.(); }
  assert.equal(stagingEntries(fx).length, 0);
}));
t('spec27-special-files: --exclude must exist, stay relative and not contain the ticket, a manifest or an export', () => withFixture({ exports: [{ role: 'code', place: 'inside' }] }, async fx => {
  for (const value of ['S1/missing', 'S2', 'S2/export-code', 'S2/export-code/src', '.', 'orchestrator/tickets.json/x']) {
    await expectRefusal(fx, { add: [['--exclude', value]] }, /--exclude/).catch(error => { error.message = `${value}: ${error.message}`; throw error; });
  }
  await expectRefusal(fx, { add: [['--exclude', 'S2/manifest-code.json']] }, /--exclude/);
  await expectRefusal(fx, { add: [['--exclude', 'S2/ticket-fx-S2-r1.md']] }, /--exclude/);
}));

// spec10-snapshot: the copy is what is verified and used, never the live tree.
t('spec10-snapshot: edits of the live ticket, export file and export directory after the copy change nothing that is verified or recorded', () => withFixture({}, async fx => {
  let seen;
  const original = attempt(() => treeHash(fx.export('code').dir));
  const afterSnapshot = info => {
    seen = info;
    fs.appendFileSync(fx.ticket, 'edited after the copy\n');
    const live = fx.export('code').dir;
    withWritable(path.join(live, 'src'), () => { fs.chmodSync(path.join(live, 'src', 'a.py'), 0o644); fs.writeFileSync(path.join(live, 'src', 'a.py'), 'print(2)\n'); });
    fs.renameSync(live, `${live}-old`);
    fs.mkdirSync(live);
    fs.writeFileSync(path.join(live, 'other.txt'), 'a different directory\n');
  };
  const result = prepared(fx, {}, { afterSnapshot });
  assert.ok(result.staging, JSON.stringify(result));
  try {
    assert.ok(seen?.staging, 'the hook sees the staging paths');
    assert.equal(result.ticket.sha256, fx.ticketSha, 'the recorded ticket hash is that of the copy');
    assert.equal(result.manifests.code.sha256, fx.export('code').manifestSha);
    assert.equal(fs.readFileSync(path.join(result.exports.code.copy, 'src', 'a.py'), 'utf8'), 'print(1)\n', 'the plan uses the copy');
    assert.equal(fs.readFileSync(path.join(result.staging.mailbox, 'S2', path.basename(fx.ticket)), 'utf8'), fx.ticketText);
    assert.equal(result.exports.code.tree_sha256, original, 'the recorded export hash is that of the copy');
    assert.equal(fs.existsSync(path.join(result.exports.code.copy, 'other.txt')), false);
  } finally { result.cleanup?.(); }
}));
t('spec10-snapshot: editing the COPY of the ticket or of an export file is refused with exit code 2', () => withFixture({}, async fx => {
  const editTicketCopy = info => {
    const file = path.join(info.mailbox, 'S2', path.basename(fx.ticket));
    withWritable(path.dirname(file), () => { fs.chmodSync(file, 0o644); fs.appendFileSync(file, 'x'); });
  };
  const editExportCopy = info => {
    const file = path.join(info.exports.code, 'src', 'a.py');
    withWritable(path.dirname(file), () => { fs.chmodSync(file, 0o444); });
    withWritable(path.dirname(file), () => { fs.chmodSync(file, 0o644); fs.writeFileSync(file, 'print(9)\n'); fs.chmodSync(file, 0o444); });
  };
  for (const [name, hook, pattern] of [['the ticket copy', editTicketCopy, /ticket/], ['an export file copy', editExportCopy, /code/]]) {
    const before = listing(fx.base);
    const outcome = await fx.run({ deps: { afterSnapshot: hook } });
    assert.equal(outcome.code, 2, `${name}: ${outcome.stderr}`);
    assert.match(outcome.stderr, pattern, name);
    assert.deepEqual(listing(fx.base), before, `${name}: no effect`);
  }
}));
t('spec10-snapshot: an export inside the mailbox is verified and used from the mailbox copy', () => withFixture({ exports: [{ role: 'code', place: 'inside' }] }, async fx => {
  const result = prepared(fx, {}, { afterSnapshot: () => withWritable(path.join(fx.export('code').dir, 'src'), () => { fs.chmodSync(path.join(fx.export('code').dir, 'src', 'a.py'), 0o644); fs.writeFileSync(path.join(fx.export('code').dir, 'src', 'a.py'), 'live edit\n'); }) });
  assert.ok(result.staging, JSON.stringify(result));
  try {
    assert.equal(result.exports.code.copy, path.join(result.staging.mailbox, 'S2', 'export-code'));
    assert.equal(fs.readFileSync(path.join(result.exports.code.copy, 'src', 'a.py'), 'utf8'), 'print(1)\n');
    assert.equal(result.exports.code.inside_mailbox, true);
  } finally { result.cleanup?.(); }
}));

t('snapshot: the staging directory has a marker, mode 0700, the modes of A2.5.4, and the mount points of A2.3.4', () => withFixture({}, async fx => {
  const result = prepared(fx, {});
  assert.ok(result.staging, JSON.stringify(result));
  try {
    const dir = result.staging.dir;
    assert.equal(path.dirname(dir), fx.staging);
    assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(dir, '.acoder-staging'), 'utf8').trim(), result.staging.runId);
    const copy = result.staging.mailbox;
    assert.equal(fs.lstatSync(copy).mode & 0o777, 0o555);
    assert.equal(fs.lstatSync(path.join(copy, 'S1', 'note.md')).mode & 0o777, 0o444);
    assert.equal(fs.lstatSync(path.join(copy, 'S1')).mode & 0o777, 0o555);
    assert.equal(fs.lstatSync(path.join(copy, 'S2')).mode & 0o777, 0o555);
    assert.equal(fs.lstatSync(path.join(copy, 'orchestrator', 'tickets.json')).mode & 0o777, 0o444);
    const scratch = path.join(copy, 'S2', `scratch-${fx.tag}`);
    assert.ok(fs.lstatSync(scratch).isDirectory() && fs.readdirSync(scratch).length === 0, 'an empty scratch directory in the copy');
    for (const name of [`report-${fx.tag}.md`, `report-${fx.tag}.json`]) {
      const stat = fs.lstatSync(path.join(copy, 'S2', name));
      assert.ok(stat.isFile() && stat.size === 0, `${name}: an empty file in the copy`);
    }
    const exported = result.exports.code.copy;
    assert.equal(exported, path.join(result.staging.dir, 'export-code'));
    assert.equal(fs.lstatSync(path.join(exported, 'src', 'a.py')).mode & 0o777, 0o444, 'export modes follow the source');
    assert.equal(fs.lstatSync(path.join(exported, 'bin', 'run')).mode & 0o777, 0o555);
    assert.equal(fs.readlinkSync(path.join(exported, 'link')), 'src/a.py');
    assert.equal(fs.existsSync(fx.writable.scratch), false, 'nothing in the live mailbox');
    assert.ok(fs.existsSync(path.join(result.staging.skill, 'SKILL.md')), 'the reviewer skill is copied');
  } finally { result.cleanup?.(); }
  assert.equal(stagingEntries(fx).length, 0, 'cleanup removes the staging directory, also read-only directories');
}));
t('snapshot: the export modes of the SOURCE are kept (a 0644 file stays 0644) and never taken from the manifest', () => withFixture({}, async fx => {
  withWritable(path.join(fx.export('code').dir, 'src'), () => fs.chmodSync(path.join(fx.export('code').dir, 'src', 'a.py'), 0o644));
  const outcome = await fx.run({});
  assert.equal(outcome.code, 2);
  assert.match(outcome.stderr, /mode/);
}));

t('snapshot: cleanup deletes only a directory whose marker matches', () => withFixture({}, async fx => {
  const { removeStaging } = await import('../lib/snapshot.mjs');
  const decoy = path.join(fx.base, 'decoy');
  fs.mkdirSync(decoy);
  fs.writeFileSync(path.join(decoy, 'keep.txt'), 'x');
  assert.notEqual(attempt(() => removeStaging(decoy, 'some-run-id')), undefined);
  assert.ok(fs.existsSync(path.join(decoy, 'keep.txt')), 'no marker: not deleted');
  fs.writeFileSync(path.join(decoy, '.acoder-staging'), 'other-run\n');
  assert.notEqual(attempt(() => removeStaging(decoy, 'some-run-id')), undefined);
  assert.ok(fs.existsSync(path.join(decoy, 'keep.txt')), 'another run id: not deleted');
  fs.writeFileSync(path.join(decoy, '.acoder-staging'), 'some-run-id\n');
  assert.equal(attempt(() => removeStaging(decoy, 'some-run-id')), undefined);
  assert.equal(fs.existsSync(decoy), false);
}));

// Limits: the byte and entry limits refuse.
t('snapshot limits: --snapshot-max-bytes and the 200000 entry limit refuse and remove the staging directory', () => withFixture({}, async fx => {
  assert.equal(ENTRY_LIMIT, 200000);
  await expectRefusal(fx, { add: [['--snapshot-max-bytes', '10']] }, /bytes|snapshot/);
  assert.equal(stagingEntries(fx).length, 0);
  const result = await fx.run({ add: [['--snapshot-max-bytes', '100000']] });
  assert.equal(result.code, 0, result.stderr);
  const source = path.join(fx.base, 'many');
  fs.mkdirSync(source);
  for (let index = 0; index < 6; index += 1) fs.writeFileSync(path.join(source, `f${index}`), 'x');
  const target = path.join(fx.base, 'many-copy');
  const context = { kind: 'payload', limits: { bytes: 1000, entries: 5 }, counters: { bytes: 0, entries: 0 }, label: 'many' };
  assert.match(attempt(() => copyTree(source, target, context)).thrown, /entr/);
  const roomy = { kind: 'payload', limits: { bytes: 1000, entries: 6 }, counters: { bytes: 0, entries: 0 }, label: 'many' };
  fs.rmSync(target, { recursive: true, force: true });
  assert.equal(attempt(() => copyTree(source, target, roomy)), undefined);
  assert.equal(roomy.counters.entries, 6);
  assert.equal(roomy.counters.bytes, 6);
}));

t('snapshot race: a file replaced by a link after the lstat is not copied through the link', () => withFixture({}, async fx => {
  const source = path.join(fx.base, 'race-src');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'victim.txt'), 'original\n');
  const secret = path.join(fx.base, 'secret.txt');
  fs.writeFileSync(secret, 'outside secret\n');
  const target = path.join(fx.base, 'race-copy');
  const context = {
    kind: 'payload', label: 'race', limits: { bytes: 1000, entries: 10 }, counters: { bytes: 0, entries: 0 },
    afterLstat: live => { fs.rmSync(live); fs.symlinkSync(secret, live); },
  };
  assert.match(attempt(() => copyTree(source, target, context)).thrown ?? '', /changed while it was copied|ELOOP|too many|symbolic/i);
  const copied = path.join(target, 'victim.txt');
  assert.equal(fs.existsSync(copied) ? fs.readFileSync(copied, 'utf8').includes('outside secret') : false, false, 'the secret is not in the copy');
}));
t('snapshot race: the same file replaced by a different regular file after the lstat is refused (the identity check)', () => withFixture({}, async fx => {
  const source = path.join(fx.base, 'race-src2');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'victim.txt'), 'original\n');
  const context = {
    kind: 'payload', label: 'race', limits: { bytes: 1000, entries: 10 }, counters: { bytes: 0, entries: 0 },
    afterLstat: live => { fs.rmSync(live); fs.writeFileSync(live, 'a different file\n'); },
  };
  assert.match(attempt(() => copyTree(source, path.join(fx.base, 'race-copy2'), context)).thrown ?? '', /changed while it was copied/);
}));
t('snapshot: a symbolic link, a FIFO and a credential name in a payload tree are refused', () => withFixture({}, async fx => {
  const kinds = { 'a symbolic link': dir => fs.symlinkSync('x', path.join(dir, 'l')), 'a .git entry': dir => fs.mkdirSync(path.join(dir, '.GIT')), 'a credential name': dir => fs.writeFileSync(path.join(dir, '.PgPass'), 'x') };
  for (const [name, make] of Object.entries(kinds)) {
    const source = fs.mkdtempSync(path.join(fx.base, 'payload-'));
    make(source);
    const context = { kind: 'payload', label: 'payload', limits: { bytes: 1000, entries: 10 }, counters: { bytes: 0, entries: 0 } };
    assert.match(attempt(() => copyTree(source, `${source}-copy`, context)).thrown ?? '', /not allowed/, name);
  }
}));
