import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { IMAGE_ID, imageAnswer, makeFakeRuntime } from './helpers/fake-runtime.mjs';
import { lastLine, LAUNCHER, runMain, withFixture } from './helpers/fixtures.mjs';
import { treeHash } from './helpers/tree-hash.mjs';

// G11: every test has a finite time limit of its own and is registered from this file.
const t = (name, fn, timeout = 60000) => nodeTest(name, { timeout }, fn);
const ZERO = '0'.repeat(64);
const REPORT_BOUND = 16777216;

// One launch on the fake runtime (no container): `volume create` (the first runtime effect after E2) is refused unless options.call says
// otherwise; options.afterSnapshot runs in the snapshot hook. Returns {code, stdout, stderr, last, record, staging, seen}.
async function launch(fx, { afterSnapshot = () => {}, onVolume = () => {} } = {}) {
  const fake = makeFakeRuntime();
  const seen = { staging: null };
  try {
    fake.setImage(imageAnswer());
    const runtime = real => ({
      ...real,
      call: async (args, extra) => {
        if (args[0] === 'volume' && args[1] === 'create') { onVolume(seen); return { code: 1, stdout: '', stderr: 'refused by the test' }; }
        return real.call(args, extra);
      },
    });
    const out = await runMain(fx.argv({ set: { '--image': IMAGE_ID }, drop: ['--dry-run'] }), {
      env: fake.env(fx.env), deps: { launchEnabled: true, runtime, hooks: { afterSnapshot: data => { seen.staging = data.staging; afterSnapshot(data); } } },
    });
    const last = lastLine(out.stdout).split(' ');
    const file = last[4];
    const record = file !== undefined && file !== '-' && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    return { ...out, last, record, file, seen };
  } finally { fake.cleanup(); }
}

// F-38-01 (R37-01; A9, S4-AC15): the payload and skill hashes are taken once from the staged trees, right after staging; a failure after
// staging (here the volume) still records the hashes of those trees, computed independently by the test while they exist.
t('S4-AC15 (A9): after a refused volume creation the not-started record carries the hashes of the staged payloads and skill, not zero', () => withFixture({ noExport: true }, async fx => {
  let expected = null;
  const run = await launch(fx, { onVolume: seen => { expected = ['agent-payload', 'egress-payload', 'agent-payload/skill'].map(dir => treeHash(path.join(seen.staging, dir))); } });
  assert.equal(run.code, 1, run.stderr);
  assert.equal(run.last[3], 'not-started');
  assert.ok(expected !== null && expected.every(hash => hash !== ZERO), 'the staged trees were hashed while they existed');
  assert.equal(fs.existsSync(run.seen.staging), false, 'the staging directory is removed');
  assert.ok(run.record !== null, 'a not-started record was written');
  const { launcher } = run.record;
  assert.deepEqual([launcher.agent_payload_sha256, launcher.egress_payload_sha256, launcher.skill_sha256], expected, 'the hashes of the trees that were staged');
}));

// F-38-02 (R37-02; A6.6 E2, SPEC-09): an exclusive creation that fails in E2 (the JSON report already exists) leaves the competing file
// unchanged, removes only what this attempt made, and still writes the attempt log and the not-started record.
t('A6.6 E2: a report file that already exists fails E2; the competing file is unchanged and the not-started record and log are written', () => withFixture({ noExport: true }, async fx => {
  const competing = 'a competing report\n';
  const run = await launch(fx, { afterSnapshot: () => fs.writeFileSync(fx.writable.reportJson, competing, { flag: 'wx' }) });
  assert.equal(run.code, 1, run.stderr);
  assert.equal(run.last[3], 'not-started');
  assert.equal(fs.readFileSync(fx.writable.reportJson, 'utf8'), competing, 'the competing file survives unchanged');
  assert.equal(fs.existsSync(fx.writable.reportMd), false, 'the empty report this attempt made is removed');
  assert.equal(fs.existsSync(fx.writable.scratch), false, 'the empty scratch directory this attempt made is removed');
  assert.ok(run.record !== null, `a not-started record was written: ${run.stdout} ${run.stderr}`);
  assert.match(path.basename(run.file), new RegExp(`^run-${fx.tag}\\.notstarted-\\d{8}T\\d{6}Z-[0-9a-f]{6}\\.json$`));
  assert.equal(run.record.error_detail, 'runtime_failure');
  assert.equal(run.record.log_path, run.file.replace(/\.json$/, '.log'));
  assert.ok(fs.existsSync(run.record.log_path), 'the attempt log exists');
  assert.equal(fs.existsSync(run.seen.staging), false, 'the staging directory is removed');
  const sha = createHash('sha256').update(competing).digest('hex');
  assert.deepEqual(run.record.reports.json, { path: fx.writable.reportJson, exists: true, bytes: competing.length, sha256: sha, parses: false, session_matches: false });
}));

t('A6.6 E2: a stage folder that cannot be written gives not-started without a record and an error naming the stage folder', () => withFixture({ noExport: true }, async fx => {
  const before = fs.readdirSync(fx.stage).sort();
  let run;
  try {
    run = await launch(fx, { afterSnapshot: () => fs.chmodSync(fx.stage, 0o555) });
  } finally { fs.chmodSync(fx.stage, 0o755); }
  assert.equal(run.code, 1, run.stderr);
  assert.deepEqual(run.last.slice(3), ['not-started', '-']);
  assert.ok(run.stderr.split('\n').some(line => line.startsWith('error: ') && line.includes(fx.stage)), `the error names the stage folder: ${run.stderr}`);
  assert.deepEqual(fs.readdirSync(fx.stage).sort(), before, 'nothing was created in the stage folder');
}));

// F-38-09: a report over the scan's report bound is not read in full by the record facts: its size is recorded, its hash is not (a sparse
// file: the test allocates nothing).
t('A9 reports: a report over the scan bound is recorded by its size without being read (no hash, does not parse)', () => withFixture({ noExport: true }, async fx => {
  const run = await launch(fx, {
    afterSnapshot: () => { const fd = fs.openSync(fx.writable.reportJson, 'wx', 0o600); try { fs.ftruncateSync(fd, REPORT_BOUND + 1); } finally { fs.closeSync(fd); } },
  });
  assert.equal(run.code, 1, run.stderr);
  assert.ok(run.record !== null, `a not-started record was written: ${run.stdout} ${run.stderr}`);
  assert.deepEqual(run.record.reports.json, { path: fx.writable.reportJson, exists: true, bytes: REPORT_BOUND + 1, sha256: null, parses: false, session_matches: false });
  assert.equal(fs.statSync(fx.writable.reportJson).size, REPORT_BOUND + 1, 'the oversize file is left as it was');
}));

// F-38-10: no timer of the run outlives the result: a launcher process ends promptly after main() returned.
t('a launcher process ends promptly once main() returned (no timer of the run keeps it alive)', () => withFixture({ noExport: true }, async fx => {
  const fake = makeFakeRuntime();
  try {
    fake.setImage(imageAnswer());
    const spec = path.join(fake.dir, 'spec.json');
    fs.writeFileSync(spec, JSON.stringify({ argv: fx.argv({ set: { '--image': IMAGE_ID }, drop: ['--dry-run'] }), env: fake.env(fx.env), failVolume: true }));
    const child = spawn(process.execPath, [path.join(LAUNCHER, 'test/helpers/run-child.mjs'), spec], { stdio: ['ignore', 'pipe', 'pipe'] });
    let returned = null;
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; if (returned === null && text.includes('main returned\n')) returned = Date.now(); });
    child.stderr.resume();
    const killer = setTimeout(() => child.kill('SIGKILL'), 40000);
    const [code] = await new Promise(resolve => child.on('close', (...end) => resolve(end)));
    const ended = Date.now();
    clearTimeout(killer);
    assert.ok(returned !== null, `main() returned: ${text}`);
    assert.match(text, / not-started /);
    assert.equal(code, 1);
    assert.ok(ended - returned < 5000, `the process ended ${ended - returned} ms after main() returned`);
  } finally { fake.cleanup(); }
}));

// F-38-09, direct: the bytes the record facts read are counted through the file-system seam; a report over the bound (here a small bound
// and a sparse file of the real bound plus one) is never read, one within it is read once.
t('A9 reports: the record facts read no byte of a report over the bound and exactly the bytes of one within it', () => withFixture({ noExport: true }, async fx => {
  const { reportFacts } = await import('../lib/run.mjs');
  let read = 0;
  const io = { ...fs, readSync: (...args) => { const got = fs.readSync(...args); read += got; return got; } };
  fs.writeFileSync(fx.writable.reportMd, 'x'.repeat(100));
  const fd = fs.openSync(fx.writable.reportJson, 'wx', 0o600);
  try { fs.ftruncateSync(fd, REPORT_BOUND + 1); } finally { fs.closeSync(fd); }
  const facts = reportFacts(fx.writable, fx.tag, { io });
  assert.deepEqual(facts.json, { path: fx.writable.reportJson, exists: true, bytes: REPORT_BOUND + 1, sha256: null, parses: false, session_matches: false });
  assert.equal(facts.md.sha256, createHash('sha256').update('x'.repeat(100)).digest('hex'));
  assert.equal(read, 100, 'only the report within the bound was read');
  read = 0;
  const small = reportFacts(fx.writable, fx.tag, { io, maxBytes: 99 });
  assert.deepEqual(small.md, { path: fx.writable.reportMd, exists: true, bytes: 100, sha256: null });
  assert.equal(read, 0, 'a report one byte over a bound of 99 is not read');
  fs.chmodSync(fx.writable.reportMd, 0o000);
  try {
    assert.deepEqual(reportFacts(fx.writable, fx.tag, { io }).md, { path: fx.writable.reportMd, exists: true, bytes: 100, sha256: null }, 'an unreadable report');
  } finally { fs.chmodSync(fx.writable.reportMd, 0o600); }
}));

// F-40-01 (R39-01; A2.3.4, A6.6 E2): the launcher removes a scratch directory only when THIS attempt created it, proven by the device and
// inode it read right after its exclusive mkdir and found again at removal time. A competing directory (created after the validation phase,
// here in the snapshot hook) makes the exclusive mkdir fail with EEXIST; it survives byte for byte, empty or not, and is not claimed as a
// leftover of this attempt.
const dirState = dir => { const info = fs.lstatSync(dir); return { dev: info.dev, ino: info.ino, mode: info.mode, tree: treeHash(dir) }; };
for (const [label, fill] of [['an empty', () => {}], ['a non-empty', dir => fs.writeFileSync(path.join(dir, 'theirs.txt'), 'competing content\n')]]) {
  t(`A6.6 E2 (F-40-01): ${label} competing scratch directory survives a failed exclusive mkdir unchanged`, () => withFixture({ noExport: true }, async fx => {
    let before = null;
    const run = await launch(fx, { afterSnapshot: () => { fs.mkdirSync(fx.writable.scratch, { mode: 0o755 }); fill(fx.writable.scratch); before = dirState(fx.writable.scratch); } });
    assert.equal(run.code, 1, run.stderr);
    assert.equal(run.last[3], 'not-started');
    assert.ok(fs.existsSync(fx.writable.scratch), 'the competing directory still exists');
    assert.deepEqual(dirState(fx.writable.scratch), before, 'the competing directory is unchanged (device, inode, mode and content)');
    assert.ok(run.record !== null, 'a not-started record was written');
    assert.equal(run.record.error_detail, 'runtime_failure');
    assert.ok(!run.record.cleanup.leftovers.includes(fx.writable.scratch), 'a directory this attempt did not create is not its leftover');
    assert.equal(fs.existsSync(fx.writable.reportMd), false, 'no report file was created after the failed mkdir');
  }));
}

t('A6.6 E2 (F-40-01): the scratch directory this attempt created is removed when E2 fails later (a competing report file)', () => withFixture({ noExport: true }, async fx => {
  const run = await launch(fx, { afterSnapshot: () => fs.writeFileSync(fx.writable.reportMd, 'theirs\n', { flag: 'wx' }) });
  assert.equal(run.code, 1, run.stderr);
  assert.equal(run.last[3], 'not-started');
  assert.equal(fs.existsSync(fx.writable.scratch), false, 'the directory this attempt made is removed');
  assert.equal(fs.readFileSync(fx.writable.reportMd, 'utf8'), 'theirs\n');
  assert.ok(run.record !== null, `a not-started record was written: ${run.stdout} ${run.stderr}`);
  assert.deepEqual(run.record.cleanup, { status: 'complete', leftovers: [] });
}));

t('A6.6 (F-40-01): the scratch directory this attempt created is removed after a later failure (the refused volume)', () => withFixture({ noExport: true }, async fx => {
  let seenDir = null;
  const run = await launch(fx, { onVolume: () => { seenDir = dirState(fx.writable.scratch); } });
  assert.equal(run.code, 1, run.stderr);
  assert.ok(seenDir !== null, 'the attempt had created its scratch directory');
  assert.equal(fs.existsSync(fx.writable.scratch), false, 'and removed it');
  assert.ok(run.record !== null, 'a not-started record was written');
  assert.ok(!run.record.cleanup.leftovers.includes(fx.writable.scratch));
}));

t('A6.6 (F-40-01): a scratch path replaced by another directory after this attempt created it is not removed', () => withFixture({ noExport: true }, async fx => {
  // The original is moved aside, not deleted, so the replacement cannot reuse its inode number (Linux file systems reuse a freed one at once).
  let before = null;
  let originalIno = null;
  const run = await launch(fx, { onVolume: () => {
    originalIno = fs.statSync(fx.writable.scratch).ino;
    fs.renameSync(fx.writable.scratch, `${fx.writable.scratch}.orig`);
    fs.mkdirSync(fx.writable.scratch, { mode: 0o700 });
    before = dirState(fx.writable.scratch);
  } });
  assert.equal(run.code, 1, run.stderr);
  assert.ok(before !== null);
  assert.ok(fs.existsSync(fx.writable.scratch), 'the replacing directory is kept');
  assert.deepEqual(dirState(fx.writable.scratch), before, 'and unchanged');
  assert.notEqual(fs.statSync(fx.writable.scratch).ino, originalIno, 'the replacing directory has another inode than the one this attempt created');
}));
