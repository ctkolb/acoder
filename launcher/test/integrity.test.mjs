import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseManifest, readSmallFile, sha256File, treeHash, verifyExport, writeManifest } from '../lib/integrity.mjs';
import nodeTest from 'node:test';
import { BIN, attempt, buildManifestText, expectRefusal, forceRemove, listing, makeFixture, sha, withFixture, withWritable, thrownOf } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own. The test is registered from this file, so that the mutation runner can count it per module.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, fn);

const hex = char => char.repeat(64);

// S2-AC9 (dod7-mismatch): one case per mismatch kind of A7.4; the stage folder is byte-for-byte unchanged and the staging directory is gone.
const live = fx => fx.export('code').dir;
const MISMATCHES = {
  'a path in the export that is not in the manifest': { kind: /not in the manifest|extra/, edit: fx => withWritable(live(fx), () => fs.writeFileSync(path.join(live(fx), 'extra.txt'), 'x')) },
  'a manifest path missing from the export': { kind: /missing/, edit: fx => withWritable(path.join(live(fx), 'docs'), () => { fs.chmodSync(path.join(live(fx), 'docs', 'readme.txt'), 0o644); fs.rmSync(path.join(live(fx), 'docs', 'readme.txt')); }) },
  'a file where the manifest has a directory': { kind: /type/, edit: fx => withWritable(live(fx), () => { forceRemove(path.join(live(fx), 'docs')); fs.writeFileSync(path.join(live(fx), 'docs'), 'x'); fs.chmodSync(path.join(live(fx), 'docs'), 0o444); }) },
  'a directory where the manifest has a file': { kind: /type/, edit: fx => withWritable(path.join(live(fx), 'src'), () => { fs.rmSync(path.join(live(fx), 'src', 'a.py')); fs.mkdirSync(path.join(live(fx), 'src', 'a.py'), { mode: 0o555 }); }) },
  'a file where the manifest has a link': { kind: /type/, edit: fx => withWritable(live(fx), () => { fs.rmSync(path.join(live(fx), 'link')); fs.writeFileSync(path.join(live(fx), 'link'), 'x'); fs.chmodSync(path.join(live(fx), 'link'), 0o444); }) },
  'a link where the manifest has a file': { kind: /type/, edit: fx => withWritable(path.join(live(fx), 'docs'), () => { fs.chmodSync(path.join(live(fx), 'docs', 'readme.txt'), 0o644); fs.rmSync(path.join(live(fx), 'docs', 'readme.txt')); fs.symlinkSync('../src/a.py', path.join(live(fx), 'docs', 'readme.txt')); }) },
  'a file mode that differs (mode only)': { kind: /mode/, edit: fx => fs.chmodSync(path.join(live(fx), 'src', 'a.py'), 0o644) },
  'an executable bit that differs (mode only)': { kind: /mode/, edit: fx => fs.chmodSync(path.join(live(fx), 'bin', 'run'), 0o755) },
  'a directory mode that differs': { kind: /mode/, edit: fx => fs.chmodSync(path.join(live(fx), 'docs'), 0o755) },
  'a root mode that differs': { kind: /root/, edit: fx => fs.chmodSync(live(fx), 0o755) },
  'a different file SHA-256 with the same size': { kind: /sha256|content|hash/, edit: fx => withWritable(path.join(live(fx), 'src'), () => { fs.chmodSync(path.join(live(fx), 'src', 'a.py'), 0o644); fs.writeFileSync(path.join(live(fx), 'src', 'a.py'), 'print(2)\n'); fs.chmodSync(path.join(live(fx), 'src', 'a.py'), 0o444); }) },
  'a different link target': { kind: /target/, edit: fx => withWritable(live(fx), () => { fs.rmSync(path.join(live(fx), 'link')); fs.symlinkSync('bin/run', path.join(live(fx), 'link')); }) },
};
for (const [name, { kind, edit }] of Object.entries(MISMATCHES)) {
  t(`dod7-mismatch: ${name}`, () => withFixture({}, async fx => {
    edit(fx);
    const result = await expectRefusal(fx, {}, /code/);
    assert.match(result.stderr, kind);
    assert.equal(fs.readdirSync(fx.staging).length, 0, 'the staging directory is gone');
  }));
}
t('dod7-mismatch: a link whose target is absolute, or leaves the export by chained resolution, is refused', () => withFixture({}, async fx => {
  const before = listing(fx.stage);
  withWritable(live(fx), () => fs.symlinkSync(fx.mailbox, path.join(live(fx), 'link-abs')));
  const result = await expectRefusal(fx, {}, /./);
  assert.match(result.stderr, /link|target/);
  assert.deepEqual(listing(fx.stage), before);
}));
t('dod7-mismatch: a manifest hash that differs, and a ticket hash that differs', () => withFixture({}, async fx => {
  const manifest = await expectRefusal(fx, { set: { '--manifest-sha256': `code=${hex('d')}` } }, /manifest hash mismatch/);
  assert.match(manifest.stderr, /code/);
  const ticket = await expectRefusal(fx, { set: { '--ticket-sha256': hex('e') } }, /ticket hash mismatch/);
  assert.doesNotMatch(ticket.stderr, new RegExp(fx.ticketSha), 'only the mismatch is named');
  fs.appendFileSync(fx.export('code').manifest, ' ');
  await expectRefusal(fx, {}, /manifest hash mismatch/);
}));
t('dod7-mismatch: the message names the role, the kind and at most 20 differing paths', () => withFixture({}, async fx => {
  withWritable(live(fx), () => { for (let index = 0; index < 25; index += 1) fs.writeFileSync(path.join(live(fx), `extra-${String(index).padStart(2, '0')}.txt`), 'x'); });
  const result = await expectRefusal(fx, {}, /code/);
  const named = result.stderr.match(/extra-\d\d\.txt/g) ?? [];
  assert.equal(named.length, 20);
  assert.match(result.stderr, /25/);
}));
t('dod7-mismatch: with two exports the second one is verified too and named', () => withFixture({ exports: [{ role: 'code' }, { role: 'docs' }] }, async fx => {
  withWritable(path.join(fx.export('docs').dir, 'src'), () => fs.chmodSync(path.join(fx.export('docs').dir, 'src', 'a.py'), 0o644));
  const result = await expectRefusal(fx, {}, /docs/);
  assert.doesNotMatch(result.stderr, /\bcode\b/);
}));

// dod7-recorded: the recorded values of the prepare step.
t('dod7-recorded: the returned values are the ticket hash, the manifest hashes and the export hashes of the copy', () => withFixture({ exports: [{ role: 'code' }, { role: 'docs', place: 'inside' }] }, async fx => {
  const { parseReviewRun } = await import('../lib/args.mjs');
  const { prepare } = await import('../lib/prepare.mjs');
  const result = attempt(() => prepare(parseReviewRun(fx.argv().slice(2)), fx.env, {}));
  assert.ok(result.staging, JSON.stringify(result));
  try {
    assert.equal(result.tag, fx.tag);
    assert.equal(result.ticket.sha256, fx.ticketSha);
    assert.deepEqual(result.writable, { stage: fx.stage, scratch: fx.writable.scratch, reportMd: fx.writable.reportMd, reportJson: fx.writable.reportJson });
    for (const role of ['code', 'docs']) {
      assert.equal(result.manifests[role].sha256, fx.export(role).manifestSha);
      assert.equal(result.manifests[role].source_commit, 'a'.repeat(40));
      assert.equal(result.exports[role].tree_sha256, attempt(() => treeHash(result.exports[role].copy)));
      assert.equal(result.exports[role].tree_sha256, attempt(() => treeHash(fx.export(role).dir)), 'the copy has the content, modes and links of the source');
    }
    assert.notEqual(result.exports.code.tree_sha256, 'a'.repeat(64));
    assert.equal(result.exports.code.inside_mailbox, false);
    assert.equal(result.exports.docs.inside_mailbox, true);
    assert.equal(result.exports.code.entries, 7, 'the entries of the manifest');
    assert.match(result.skillSha256, /^[0-9a-f]{64}$/);
    assert.ok(result.snapshot.bytes > 0 && result.snapshot.entries > 0);
  } finally { result.cleanup?.(); }
}));
t('dod7-recorded: the tree hash covers type, mode and link target (directory against empty file, mode only, target only)', () => withFixture({}, async fx => {
  const make = name => { const dir = path.join(fx.base, name); fs.mkdirSync(dir); return dir; };
  const hashOf = dir => attempt(() => treeHash(dir));
  const a = make('t-a');
  const b = make('t-b');
  fs.mkdirSync(path.join(a, 'thing'));
  fs.writeFileSync(path.join(b, 'thing'), '');
  assert.notEqual(hashOf(a), hashOf(b), 'a directory differs from an empty file');
  assert.match(hashOf(a), /^[0-9a-f]{64}$/);
  const c = make('t-c');
  const d = make('t-d');
  for (const dir of [c, d]) fs.writeFileSync(path.join(dir, 'f'), 'same\n');
  fs.chmodSync(path.join(c, 'f'), 0o444);
  fs.chmodSync(path.join(d, 'f'), 0o644);
  assert.notEqual(hashOf(c), hashOf(d), 'mode only');
  const e = make('t-e');
  const f = make('t-f');
  fs.symlinkSync('one', path.join(e, 'l'));
  fs.symlinkSync('two', path.join(f, 'l'));
  assert.notEqual(hashOf(e), hashOf(f), 'link target only');
  const g = make('t-g');
  const h = make('t-h');
  fs.writeFileSync(path.join(g, 'l'), 'one');
  fs.symlinkSync('one', path.join(h, 'l'));
  assert.notEqual(hashOf(g), hashOf(h), 'a file against a link with the same text');
  const i = make('t-i');
  const j = make('t-j');
  fs.mkdirSync(path.join(i, 'd'));
  fs.mkdirSync(path.join(j, 'd'));
  fs.chmodSync(path.join(i, 'd'), 0o555);
  fs.chmodSync(path.join(j, 'd'), 0o755);
  assert.notEqual(hashOf(i), hashOf(j), 'directory mode only');
  const k = make('t-k');
  fs.writeFileSync(path.join(k, 'f'), 'same\n');
  fs.chmodSync(path.join(k, 'f'), 0o444);
  assert.equal(hashOf(k), hashOf(c), 'the same listing gives the same hash whatever the directory name');
  for (const dir of [i, j]) fs.chmodSync(path.join(dir, 'd'), 0o755);
}));

// S2-AC9 (spec11-modes).
const exportWith = (fx, role, transform) => {
  const dir = fx.export(role).dir;
  const text = buildManifestText(dir, 'a'.repeat(40), transform);
  fs.writeFileSync(fx.export(role).manifest, text);
  return sha(text);
};
t('spec11-modes: the normal pairs are accepted', () => withFixture({}, async fx => {
  const result = await fx.run({});
  assert.equal(result.code, 0, result.stderr);
}));
t('spec11-modes: two trees with equal content but a different mode are refused (file, executable, directory, root)', () => withFixture({}, async fx => {
  const cases = [
    () => fs.chmodSync(path.join(live(fx), 'src', 'a.py'), 0o644), () => fs.chmodSync(path.join(live(fx), 'bin', 'run'), 0o755),
    () => fs.chmodSync(path.join(live(fx), 'docs'), 0o755), () => fs.chmodSync(live(fx), 0o755),
  ];
  const originals = [0o444, 0o555, 0o555, 0o555];
  const files = [path.join(live(fx), 'src', 'a.py'), path.join(live(fx), 'bin', 'run'), path.join(live(fx), 'docs'), live(fx)];
  for (const [index, change] of cases.entries()) {
    change();
    await expectRefusal(fx, {}, /mode|root/);
    fs.chmodSync(files[index], originals[index]);
  }
  assert.equal((await fx.run({})).code, 0);
}));
t('spec11-modes: a manifest pair 100644/0555, 100755/0444, 040000/0755, 120000 with a mode, and a root mode other than 0555 are refused', () => withFixture({}, async fx => {
  const bad = {
    'file 100644 with 0555': m => { m.entries.find(e => e.path === 'src/a.py').mode = '0555'; },
    'file 100755 with 0444': m => { m.entries.find(e => e.path === 'bin/run').mode = '0444'; },
    'file 100644 with 0644': m => { m.entries.find(e => e.path === 'src/a.py').mode = '0644'; },
    'directory 040000 with 0755': m => { m.entries.find(e => e.path === 'docs').mode = '0755'; },
    'symlink with a mode field': m => { m.entries.find(e => e.path === 'link').mode = '0777'; },
    'source mode of a file 100664': m => { m.entries.find(e => e.path === 'src/a.py').source_mode = '100664'; },
    'root mode 0755': m => { m.root_mode = '0755'; },
    'root mode 0444': m => { m.root_mode = '0444'; },
  };
  for (const [name, change] of Object.entries(bad)) {
    const digest = exportWith(fx, 'code', m => { change(m); return m; });
    await expectRefusal(fx, { set: { '--manifest-sha256': `code=${digest}` } }, /export code: .*manifest/).catch(error => { error.message = `${name}: ${error.message}`; throw error; });
  }
}));

// parseManifest: the format of A7.2.
const validManifest = () => ({
  format: 'acoder-export-manifest/2', source_commit: 'a'.repeat(40), source_commit_provenance: 'asserted', root_mode: '0555',
  entries: [
    { path: 'bin', type: 'dir', mode: '0555', source_mode: '040000' }, { path: 'bin/run', type: 'file', mode: '0555', source_mode: '100755', sha256: hex('1') },
    { path: 'link', type: 'symlink', target: 'bin/run', source_mode: '120000' }, { path: 'src.py', type: 'file', mode: '0444', source_mode: '100644', sha256: hex('2') },
  ],
});
const parsed = change => { const m = validManifest(); change(m); return attempt(() => parseManifest(JSON.stringify(m))); };
t('manifest format: the example of A7.2 is accepted and every deviation is refused', () => {
  const ok = parsed(() => {});
  assert.equal(ok.thrown, undefined);
  assert.equal(ok.source_commit, 'a'.repeat(40));
  assert.equal(ok.entries.length, 4);
  assert.equal(parsed(m => { m.source_commit = 'b'.repeat(64); }).thrown, undefined, 'a 64-hex commit');
  const refused = {
    'another format': m => { m.format = 'acoder-export-manifest/1'; }, 'an unknown field': m => { m.extra = 1; }, 'a missing field': m => { delete m.root_mode; },
    'provenance other than asserted': m => { m.source_commit_provenance = 'verified'; }, 'a short commit': m => { m.source_commit = 'a'.repeat(39); }, 'an upper-case commit': m => { m.source_commit = 'A'.repeat(40); },
    'a 41-character commit': m => { m.source_commit = 'a'.repeat(41); }, 'an unknown entry field': m => { m.entries[0].extra = 1; }, 'an entry missing sha256': m => { delete m.entries[1].sha256; },
    'a dir with a sha256': m => { m.entries[0].sha256 = hex('1'); }, 'a link without a target': m => { delete m.entries[2].target; }, 'a link with a sha256': m => { m.entries[2].sha256 = hex('1'); },
    'an unknown type': m => { m.entries[0].type = 'fifo'; }, 'a duplicate path': m => { m.entries[3].path = 'link'; }, 'an unsorted list': m => { m.entries.reverse(); },
    'an absolute path': m => { m.entries[0].path = '/bin'; }, 'a dot-dot segment': m => { m.entries[3].path = '../src.py'; }, 'a dot segment': m => { m.entries[3].path = './src.py'; },
    'an empty segment': m => { m.entries[3].path = 'a//b'; }, 'a trailing slash': m => { m.entries[0].path = 'bin/'; }, 'a backslash path': m => { m.entries[3].path = 'a\\b'; },
    'a bad sha256': m => { m.entries[3].sha256 = 'XYZ'; }, 'an upper-case sha256': m => { m.entries[3].sha256 = hex('A'); }, 'entries not a list': m => { m.entries = {}; },
    'a mode with three digits': m => { m.entries[3].mode = '444'; }, 'a number mode': m => { m.entries[3].mode = 444; },
  };
  for (const [name, change] of Object.entries(refused)) assert.ok(parsed(change).thrown, `${name}: should be refused`);
  assert.ok(thrownOf(() => parseManifest('not json')));
  assert.ok(thrownOf(() => parseManifest('[]')));
  assert.ok(thrownOf(() => parseManifest('null')));
});
t('manifest verify: verifyExport lists each mismatch kind for a directory (unit)', () => withFixture({}, async fx => {
  const manifest = attempt(() => parseManifest(buildManifestText(live(fx))));
  assert.deepEqual(attempt(() => verifyExport(live(fx), manifest)), []);
  const bad = { ...manifest, entries: manifest.entries.filter(e => e.path !== 'src/a.py') };
  const found = attempt(() => verifyExport(live(fx), bad));
  assert.deepEqual(found, [{ kind: 'extra', path: 'src/a.py' }]);
}));

// S2-AC10 (spec22-source-commit): `acoder export manifest` is exactly A7.6; no git program is needed.
const noGitEnv = fx => { const empty = path.join(fx.base, 'empty-path'); fs.mkdirSync(empty); return { PATH: empty }; };
const runExport = (fx, args, env) => spawnSync(process.execPath, [BIN, 'export', 'manifest', ...args], { env, encoding: 'utf8', timeout: 20000 });
t('spec22-source-commit: a missing, short, upper-case or non-hex commit is a usage error', () => withFixture({}, async fx => {
  const env = noGitEnv(fx);
  const out = path.join(fx.base, 'm.json');
  const dir = live(fx);
  const before = listing(fx.base);
  for (const commit of [null, 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(63), '', 'HEAD', 'a'.repeat(40).replace('a', ' ')]) {
    const args = ['--export', dir, '--out', out, ...(commit === null ? [] : ['--source-commit', commit])];
    const run = runExport(fx, args, env);
    assert.equal(run.status, 2, `${commit}: ${run.stderr}`);
    assert.match(run.stderr, /source-commit/);
    assert.equal(run.stderr.trimEnd().split('\n').length, 1);
  }
  assert.deepEqual(listing(fx.base), before, 'no file is written');
  assert.equal(fs.existsSync(out), false);
}));
t('spec22-source-commit: a written manifest is accepted by the verifier for the same directory, with PATH that has no git', () => withFixture({}, async fx => {
  const env = noGitEnv(fx);
  assert.equal(spawnSync('git', ['--version'], { env, encoding: 'utf8' }).error?.code, 'ENOENT', 'the test PATH has no git');
  for (const commit of ['c'.repeat(40), 'd'.repeat(64)]) {
    const out = path.join(fx.base, `m-${commit.length}.json`);
    const run = runExport(fx, ['--export', live(fx), '--source-commit', commit, '--out', out], env);
    assert.equal(run.status, 0, run.stderr);
    const text = fs.readFileSync(out, 'utf8');
    assert.equal(run.stdout.trim(), sha(text), 'prints the SHA-256 of the file it wrote');
    const manifest = attempt(() => parseManifest(text));
    assert.equal(manifest.source_commit, commit);
    assert.deepEqual(attempt(() => verifyExport(live(fx), manifest)), []);
    assert.equal(manifest.source_commit_provenance, 'asserted');
    assert.equal(manifest.entries.find(e => e.path === 'bin/run').source_mode, '100755');
    assert.equal(manifest.entries.find(e => e.path === 'src/a.py').source_mode, '100644');
    assert.equal(manifest.entries.find(e => e.path === 'docs').source_mode, '040000');
    // the same file is accepted by the launcher for the same export
    fs.copyFileSync(out, fx.export('code').manifest);
    const launched = await fx.run({ set: { '--manifest-sha256': `code=${sha(text)}` } });
    assert.equal(launched.code, 0, launched.stderr);
  }
}));
t('spec22-source-commit: an output path that exists, lies inside the export or is relative is refused; an export that is not read-only is refused', () => withFixture({}, async fx => {
  const env = noGitEnv(fx);
  const commit = 'e'.repeat(40);
  const exists = path.join(fx.base, 'exists.json');
  fs.writeFileSync(exists, 'keep');
  const before = listing(fx.base);
  let run = runExport(fx, ['--export', live(fx), '--source-commit', commit, '--out', exists], env);
  assert.equal(run.status, 2);
  assert.equal(fs.readFileSync(exists, 'utf8'), 'keep');
  run = runExport(fx, ['--export', live(fx), '--source-commit', commit, '--out', path.join(live(fx), 'm.json')], env);
  assert.equal(run.status, 2);
  run = runExport(fx, ['--export', live(fx), '--source-commit', commit, '--out', 'relative.json'], env);
  assert.equal(run.status, 2);
  run = runExport(fx, ['--export', live(fx), '--source-commit', commit, '--out', path.join(fx.base, 'no-dir', 'm.json')], env);
  assert.equal(run.status, 2);
  fs.symlinkSync(exists, path.join(fx.base, 'dangling-out'));
  fs.rmSync(exists);
  run = runExport(fx, ['--export', live(fx), '--source-commit', commit, '--out', path.join(fx.base, 'dangling-out')], env);
  assert.equal(run.status, 2, 'an output that is a symbolic link is not followed');
  assert.equal(fs.existsSync(exists), false);
  fs.rmSync(path.join(fx.base, 'dangling-out'));
  assert.deepEqual(listing(fx.base).filter(line => !line.startsWith('exists')), before.filter(line => !line.startsWith('exists')).filter(line => !line.startsWith('dangling')));
  for (const change of [() => fs.chmodSync(path.join(live(fx), 'src', 'a.py'), 0o644), () => fs.chmodSync(path.join(live(fx), 'docs'), 0o755), () => fs.chmodSync(path.join(live(fx), 'bin', 'run'), 0o700), () => fs.chmodSync(live(fx), 0o755)]) {
    change();
    const out = path.join(fx.base, `ro-${Math.random().toString(16).slice(2)}.json`);
    run = runExport(fx, ['--export', live(fx), '--source-commit', commit, '--out', out], env);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /not in read-only form/);
    assert.equal(fs.existsSync(out), false);
    fs.chmodSync(path.join(live(fx), 'src', 'a.py'), 0o444);
    fs.chmodSync(path.join(live(fx), 'docs'), 0o555);
    fs.chmodSync(path.join(live(fx), 'bin', 'run'), 0o555);
    fs.chmodSync(live(fx), 0o555);
  }
}));
t('spec22-source-commit: the export walk refuses special files, .git, credential names and escaping links like the copier', () => withFixture({}, async fx => {
  const env = noGitEnv(fx);
  const commit = 'f'.repeat(40);
  const out = path.join(fx.base, 'special.json');
  for (const change of [
    () => fs.mkdirSync(path.join(live(fx), '.git')), () => fs.writeFileSync(path.join(live(fx), '.npmrc'), 'x'), () => fs.symlinkSync('/etc', path.join(live(fx), 'abs')), () => fs.symlinkSync('../../run', path.join(live(fx), 'out')),
    () => spawnSync('mkfifo', [path.join(live(fx), 'pipe')]),
  ]) {
    fs.chmodSync(live(fx), 0o755);
    change();
    const run = runExport(fx, ['--export', live(fx), '--source-commit', commit, '--out', out], env);
    assert.equal(run.status, 2, run.stderr);
    assert.equal(fs.existsSync(out), false);
    forceRemove(live(fx));
    fs.mkdirSync(live(fx));
    (await import('./helpers/fixtures.mjs')).buildExportTree(live(fx));
  }
}));
t('spec22-source-commit: export manifest refuses unknown or repeated flags and a missing export or out', () => withFixture({}, async fx => {
  const env = noGitEnv(fx);
  const base = ['--export', live(fx), '--source-commit', 'a'.repeat(40), '--out', path.join(fx.base, 'x.json')];
  for (const args of [[...base, '--bogus', '1'], [...base, '--export', live(fx)], base.slice(2), base.filter((_, i) => i < 4), ['--export', 'rel', ...base.slice(2)]]) {
    const run = runExport(fx, args, env);
    assert.equal(run.status, 2, `${args.join(' ')}: ${run.stdout}${run.stderr}`);
  }
  assert.equal(fs.existsSync(path.join(fx.base, 'x.json')), false);
}));

// Units of the helpers: no link is followed, sizes are bounded, and an escaping link listed in a manifest is a mismatch.
t('integrity units: sha256File and readSmallFile do not follow a link and refuse non-files and large files', () => withFixture({}, async fx => {
  const file = path.join(fx.base, 'plain.txt');
  fs.writeFileSync(file, 'abc');
  assert.equal(attempt(() => sha256File(file)), sha('abc'));
  fs.symlinkSync(file, path.join(fx.base, 'link.txt'));
  assert.ok(thrownOf(() => sha256File(path.join(fx.base, 'link.txt'))), 'a link is not followed');
  assert.ok(thrownOf(() => readSmallFile(path.join(fx.base, 'link.txt'), 'the file', 100)));
  assert.equal(attempt(() => readSmallFile(file, 'the file', 3)), 'abc');
  assert.match(thrownOf(() => readSmallFile(file, 'the file', 2)), /larger/);
  assert.match(thrownOf(() => readSmallFile(fx.base, 'the file', 100)), /regular file/);
}));
t('integrity units: verifyExport reports a link that leaves the export and a different target', () => withFixture({}, async fx => {
  const dir = path.join(fx.base, 'unit-export');
  fs.mkdirSync(dir);
  fs.symlinkSync('../outside', path.join(dir, 'esc'));
  fs.symlinkSync('b', path.join(dir, 'ok'));
  fs.chmodSync(dir, 0o555);
  const manifest = { ...validManifest(), entries: [
    { path: 'esc', type: 'symlink', target: '../outside', source_mode: '120000' }, { path: 'ok', type: 'symlink', target: 'a', source_mode: '120000' },
  ] };
  assert.deepEqual(attempt(() => verifyExport(dir, manifest)), [{ kind: 'link_escape', path: 'esc' }, { kind: 'link_target', path: 'ok' }]);
  fs.chmodSync(dir, 0o755);
}));
t('integrity units: writeManifest refuses more entries than its bound and accepts the bound', () => withFixture({}, async fx => {
  const dir = live(fx);
  const out = path.join(fx.base, 'bounded.json');
  assert.match(thrownOf(() => writeManifest({ exportDir: dir, sourceCommit: 'a'.repeat(40), out, maxEntries: 5 })), /more than 5 entries/);
  assert.equal(fs.existsSync(out), false);
  assert.match(attempt(() => writeManifest({ exportDir: dir, sourceCommit: 'a'.repeat(40), out, maxEntries: 7 })), /^[0-9a-f]{64}$/);
  assert.equal(attempt(() => parseManifest(fs.readFileSync(out, 'utf8'))).entries?.length, 7);
}));
