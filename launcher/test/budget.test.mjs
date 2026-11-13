import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import nodeTest from 'node:test';
import { DISK_BOUNDS, DISK_POLL_MS, createDiskController } from '../lib/budget.mjs';
import { must, mustAsync, thrownOf, withFixture } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own. The test is registered from this file, so that the mutation runner can count it per module.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, fn);

const ROOT = '/s/scratch';
const FILES = ['/s/report.md', '/s/report.json', '/s/run.log'];

// A virtual file system with a fake clock: every call can cost time, report a size that depends on the time, or fail on chosen calls.
function world(tree, { latency = () => 0, failures = {} } = {}) {
  const w = { now: 0, calls: [], starts: [], active: 0, maxActive: 0, counts: {}, tree };
  const stats = node => ({ size: typeof node.file === 'function' ? node.file(w.now) : node.file ?? 0, isFile: () => 'file' in node, isDirectory: () => 'dir' in node, isSymbolicLink: () => 'link' in node, isFIFO: () => 'fifo' in node, isSocket: () => 'socket' in node });
  const call = async (op, target, produce) => {
    w.active += 1;
    w.maxActive = Math.max(w.maxActive, w.active);
    try {
      w.calls.push([op, target]);
      if (op === 'readdir' && target === ROOT) w.starts.push(w.now);
      const key = `${op}:${target}`;
      w.counts[key] = (w.counts[key] ?? 0) + 1;
      const before = w.now;
      const failure = failures[key]?.(w.counts[key], before);
      const value = failure ? null : produce(before);
      w.now += latency(target, op);
      if (failure) throw Object.assign(new Error(failure), { code: failure });
      return value;
    } finally { w.active -= 1; }
  };
  const lookup = target => {
    const node = w.tree[target];
    if (node === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return node;
  };
  w.ops = {
    lstat: target => call('lstat', target, () => stats(lookup(target))),
    readdir: target => call('readdir', target, () => {
      const node = lookup(target);
      if (!('dir' in node)) throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
      return [...node.dir];
    }),
  };
  return w;
}

const baseTree = (extra = {}) => ({
  [ROOT]: { dir: ['a.bin', 'sub'] }, [`${ROOT}/a.bin`]: { file: 100 }, [`${ROOT}/sub`]: { dir: ['b.bin'] }, [`${ROOT}/sub/b.bin`]: { file: 200 },
  '/s/report.md': { file: 10 }, '/s/report.json': { file: 20 }, '/s/run.log': { file: 30 }, ...extra,
});
const TOTAL = 360;

function make(w, over = {}) {
  const stops = [];
  let sleeps = 0;
  const controller = must(() => createDiskController({
    scratch: ROOT, files: FILES, limitBytes: 1000, ops: w.ops, now: () => w.now,
    sleep: async ms => { assert.ok(ms >= 0, 'never a negative sleep'); w.now += ms; sleeps += 1; if (sleeps >= (over.polls ?? 4)) controller.stop(); },
    onStop: stop => stops.push({ ...stop, at: w.now }), ...over,
  }));
  return { controller, stops, sleeps: () => sleeps };
}

t('dod5-disk: the constants are the 1000 ms poll and the bounds of A8.6', () => {
  assert.equal(DISK_POLL_MS, 1000);
  assert.deepEqual(DISK_BOUNDS, { maxEntries: 200000, maxDepth: 64, maxTraversalMs: 10000 });
});

t('dod5-disk: the sum counts logical file sizes under scratch plus both reports and the log, each path once, no link followed, no special file opened', () => withFixture({ noExport: true }, async fx => {
  const scratch = fx.writable.scratch;
  fs.mkdirSync(path.join(scratch, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'a.txt'), 'x'.repeat(10));
  fs.writeFileSync(path.join(scratch, 'sub', 'b.txt'), 'y'.repeat(20));
  fs.writeFileSync(path.join(scratch, 'sub', 'deep', 'c.txt'), 'z'.repeat(5));
  fs.linkSync(path.join(scratch, 'a.txt'), path.join(scratch, 'a-again.txt'));
  fs.writeFileSync(path.join(fx.base, 'outside.bin'), 'o'.repeat(100000));
  fs.symlinkSync(path.join(fx.base, 'outside.bin'), path.join(scratch, 'to-file'));
  fs.symlinkSync(fx.base, path.join(scratch, 'to-dir'));
  assert.equal(spawnSync('mkfifo', [path.join(scratch, 'pipe')]).status, 0);
  const socketPath = path.join(scratch, 'sock');
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  try {
    fs.writeFileSync(fx.writable.reportMd, 'm'.repeat(7));
    fs.writeFileSync(fx.writable.reportJson, 'j'.repeat(9));
    const log = path.join(fx.stage, 'run-t.log');
    fs.writeFileSync(log, 'l'.repeat(3));
    const sampleWith = async (files, limitBytes = 1000000) => {
      const controller = must(() => createDiskController({ scratch, files, limitBytes, onStop: () => {} }));
      return mustAsync(() => controller.sample());
    };
    const first = await sampleWith([fx.writable.reportMd, fx.writable.reportJson, log]);
    assert.deepEqual(first, { bytes: 10 + 20 + 5 + 10 + 7 + 9 + 3, stop: null }, 'a hard link is counted under each path, directories, links and special files add nothing');
    assert.equal((await sampleWith([fx.writable.reportMd, fx.writable.reportJson, path.join(fx.stage, 'absent.log')])).bytes, 10 + 20 + 5 + 10 + 7 + 9, 'an absent log is skipped');
    fs.rmSync(fx.writable.reportMd);
    fs.symlinkSync(path.join(fx.base, 'outside.bin'), fx.writable.reportMd);
    assert.equal((await sampleWith([fx.writable.reportMd, fx.writable.reportJson, log])).bytes, 10 + 20 + 5 + 10 + 9 + 3, 'a report that is a link is not followed');
    // At or above the bound is a stop; below is not.
    const exact = 10 + 20 + 5 + 10 + 9 + 3;
    assert.equal((await sampleWith([fx.writable.reportJson, log], exact + 1)).stop, null);
    assert.deepEqual((await sampleWith([fx.writable.reportJson, log], exact)).stop, { budget_kind: 'disk', reason: 'size', bytes: exact });
    assert.equal((await sampleWith([fx.writable.reportJson, log], exact - 1)).stop?.reason, 'size');
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

t('dod5-disk: the controller needs a positive safe integer bound, an absolute scratch path and a list of files', () => {
  const make1 = over => thrownOf(() => createDiskController({ scratch: ROOT, files: FILES, limitBytes: 10, onStop: () => {}, ...over }));
  assert.equal(make1({}), null);
  for (const limitBytes of [0, -1, 1.5, 2 ** 53, '10', null, undefined, Number.NaN]) assert.notEqual(make1({ limitBytes }), null, String(limitBytes));
  for (const scratch of ['s/scratch', '', undefined]) assert.notEqual(make1({ scratch }), null, String(scratch));
  assert.notEqual(make1({ files: undefined }), null);
  assert.notEqual(make1({ files: ['relative.log'] }), null);
  assert.notEqual(make1({ onStop: undefined }), null);
});

t('dod5-disk: the cadence: the first sample at release, then one per 1000 ms; the sum and the threshold with an injected clock', async () => {
  const w = world(baseTree());
  const { controller, stops } = make(w, { polls: 4 });
  const result = await controller.run();
  assert.deepEqual(w.starts, [0, 1000, 2000, 3000], 'the first sample is at once, then every 1000 ms');
  assert.deepEqual(stops, []);
  assert.deepEqual(result, { stopped: false, stop: null });
  assert.equal(w.maxActive, 1);
  assert.deepEqual((await make(world(baseTree())).controller.sample()), { bytes: TOTAL, stop: null });
  // The size is read at every sample: a file that grows is seen at the next one.
  const growing = world(baseTree({ [`${ROOT}/a.bin`]: { file: now => (now < 2500 ? 100 : 900) } }));
  const driven = make(growing, { polls: 10 });
  const final = await driven.controller.run();
  assert.deepEqual(growing.starts, [0, 1000, 2000, 3000]);
  assert.deepEqual(driven.stops, [{ budget_kind: 'disk', reason: 'size', bytes: 1160, at: 3000 }]);
  assert.deepEqual(final, { stopped: true, stop: { budget_kind: 'disk', reason: 'size', bytes: 1160 } });
  assert.equal(driven.sleeps(), 3, 'no sample after the stop');
  // The bound is "at or above": 1000 stops, 999 does not.
  const edge = limit => make(world(baseTree({ '/s/run.log': { file: limit - 330 } })), { polls: 1 }).controller.sample();
  assert.equal((await edge(999)).stop, null);
  assert.equal((await edge(1000)).stop?.reason, 'size');
  assert.equal((await edge(1001)).stop?.reason, 'size');
});

t('dod5-disk: a traversal that takes 1001 ms or 9999 ms continues, never overlaps the next one, and the next starts at the next poll after it; 10000 ms continues and 10001 ms stops', async () => {
  const slow = (cost, polls = 3) => {
    const w = world(baseTree({ [ROOT]: { dir: ['a.bin', 'slow.bin', 'sub'] }, [`${ROOT}/slow.bin`]: { file: 1 } }), { latency: target => (target.endsWith('slow.bin') ? cost : 0) });
    return { w, ...make(w, { polls }) };
  };
  for (const [cost, starts] of [[500, [0, 1000, 2000]], [1000, [0, 1000, 2000]], [1001, [0, 2000, 4000]], [1999, [0, 2000, 4000]], [2001, [0, 3000, 6000]], [9999, [0, 10000, 20000]], [10000, [0, 10000, 20000]]]) {
    const { w, controller, stops } = slow(cost);
    const result = await controller.run();
    assert.deepEqual(w.starts, starts, `a traversal of ${cost} ms: the starts`);
    assert.deepEqual(stops, [], `a traversal of ${cost} ms does not stop`);
    assert.equal(result.stopped, false);
    assert.equal(w.maxActive, 1, `a traversal of ${cost} ms: no two file system calls overlap`);
  }
  const { w, controller, stops } = slow(10001);
  const result = await controller.run();
  assert.deepEqual(w.starts, [0], 'the overlong traversal is the only one');
  assert.deepEqual(stops, [{ budget_kind: 'disk', reason: 'bound_time', bytes: result.stop.bytes, at: 10001 }]);
  assert.equal(result.stop.reason, 'bound_time');
  // The bound counts from the start of the traversal, not from the start of the run.
  const late = world(baseTree({ [ROOT]: { dir: ['a.bin', 'slow.bin', 'sub'] }, [`${ROOT}/slow.bin`]: { file: 1 } }), { latency: target => (target.endsWith('slow.bin') ? 6000 : 0) });
  const second = make(late, { polls: 3 });
  const outcome = await second.controller.run();
  assert.equal(outcome.stopped, false, 'two 6000 ms traversals do not add up to the bound');
  assert.deepEqual(late.starts, [0, 6000, 12000]);
});

t('dod5-disk: a persistent size excess is detected within 21000 ms, with a growth just after a sample started', async () => {
  for (const cost of [0, 1001, 9999, 10000]) {
    // The file that grows is read last in each traversal; the growth happens right after the first sample has read it.
    const growAt = cost + 1;
    const w = world(baseTree({
      [ROOT]: { dir: ['slow.bin', 'a.bin', 'sub'] }, [`${ROOT}/slow.bin`]: { file: 1 }, [`${ROOT}/a.bin`]: { file: now => (now < growAt ? 100 : 5000) },
    }), { latency: target => (target.endsWith('slow.bin') ? cost : 0) });
    const { controller, stops } = make(w, { polls: 50 });
    await controller.run();
    assert.equal(stops.length, 1, `cost ${cost}`);
    assert.equal(stops[0].reason, 'size');
    assert.ok(stops[0].at >= growAt, `cost ${cost}: not before the growth`);
    assert.ok(stops[0].at - growAt <= 21000, `cost ${cost}: detected after ${stops[0].at - growAt} ms`);
  }
  // The worst case of the sheet: the growth right after a sample read the file, an already running sample of 10000 ms and then a sample of 10000 ms.
  const w = world(baseTree({ [ROOT]: { dir: ['a.bin', 'slow.bin', 'sub'] }, [`${ROOT}/slow.bin`]: { file: 1 }, [`${ROOT}/a.bin`]: { file: now => (now < 1 ? 100 : 5000) } }), { latency: target => (target.endsWith('slow.bin') ? 10000 : 0) });
  const { controller, stops } = make(w, { polls: 50 });
  await controller.run();
  assert.ok(stops[0].at <= 21000, `worst case: ${stops[0].at}`);
});

t('dod5-disk: an entry that vanishes after the listing is skipped; a transient directory error that succeeds on retry does not stop; a persistent one does', async () => {
  const code = name => () => name;
  // ENOENT after listing (lstat of a listed entry, and readdir of a listed directory) is skipped.
  for (const key of [`lstat:${ROOT}/a.bin`, `lstat:${ROOT}/sub`, `readdir:${ROOT}/sub`, `lstat:${ROOT}/sub/b.bin`, 'lstat:/s/report.md']) {
    const w = world(baseTree(), { failures: { [key]: code('ENOENT') } });
    const { controller, stops } = make(w, { polls: 5 });
    await controller.run();
    assert.deepEqual(stops, [], `ENOENT on ${key} is skipped, also on every sample`);
  }
  const vanished = world(baseTree(), { failures: { [`lstat:${ROOT}/a.bin`]: code('ENOENT') } });
  assert.equal((await make(vanished).controller.sample()).bytes, TOTAL - 100, 'the vanished entry adds nothing');
  // EACCES or EIO once, then fine: no stop. The same directory failing on two samples in a row: stop.
  for (const errno of ['EACCES', 'EIO']) {
    const once = world(baseTree(), { failures: { [`readdir:${ROOT}/sub`]: calls => (calls === 1 ? errno : null) } });
    const onceRun = make(once, { polls: 5 });
    await onceRun.controller.run();
    assert.deepEqual(onceRun.stops, [], `${errno} once`);
    const twice = world(baseTree(), { failures: { [`readdir:${ROOT}/sub`]: calls => (calls <= 2 ? errno : null) } });
    const twiceRun = make(twice, { polls: 5 });
    const result = await twiceRun.controller.run();
    assert.equal(twiceRun.stops.length, 1, `${errno} twice`);
    assert.equal(twiceRun.stops[0].reason, 'unreadable');
    assert.equal(result.stop.reason, 'unreadable');
    assert.deepEqual(twice.starts, [0, 1000], 'the second failure of the same directory stops at the second sample');
    // Every other poll: never two in a row.
    const alternating = world(baseTree(), { failures: { [`readdir:${ROOT}/sub`]: calls => (calls % 2 === 1 ? errno : null) } });
    const alternatingRun = make(alternating, { polls: 8 });
    await alternatingRun.controller.run();
    assert.deepEqual(alternatingRun.stops, [], `${errno} on alternate samples`);
    // Another directory fails on each sample: each fails once only.
    const moving = world(baseTree({ [ROOT]: { dir: ['a.bin', 'sub', 'sub2'] }, [`${ROOT}/sub2`]: { dir: [] } }), {
      failures: { [`readdir:${ROOT}/sub`]: calls => (calls === 1 ? errno : null), [`readdir:${ROOT}/sub2`]: calls => (calls === 2 ? errno : null) },
    });
    const movingRun = make(moving, { polls: 5 });
    await movingRun.controller.run();
    assert.deepEqual(movingRun.stops, [], `${errno} in different directories`);
  }
  // The same rule for a file that cannot be examined (lstat fails with something other than ENOENT) and for a report.
  for (const key of [`lstat:${ROOT}/a.bin`, 'lstat:/s/report.json']) {
    const persistent = world(baseTree(), { failures: { [key]: code('EIO') } });
    const run = make(persistent, { polls: 5 });
    await run.controller.run();
    assert.equal(run.stops.length, 1, key);
    assert.equal(run.stops[0].reason, 'unreadable', key);
    const transient = world(baseTree(), { failures: { [key]: calls => (calls === 1 ? 'EIO' : null) } });
    const quiet = make(transient, { polls: 5 });
    await quiet.controller.run();
    assert.deepEqual(quiet.stops, [], key);
  }
  // A directory that turns into a file (ENOTDIR on the read of an entry that was listed as a directory), twice in a row, is a persistent type change.
  const changed = world(baseTree({ [`${ROOT}/sub`]: { dir: ['b.bin'] } }), { failures: { [`readdir:${ROOT}/sub`]: () => 'ENOTDIR' } });
  const changedRun = make(changed, { polls: 5 });
  await changedRun.controller.run();
  assert.equal(changedRun.stops.length, 1);
  assert.equal(changedRun.stops[0].reason, 'type_change');
  const changedOnce = world(baseTree(), { failures: { [`readdir:${ROOT}/sub`]: calls => (calls === 1 ? 'ENOTDIR' : null) } });
  const changedOnceRun = make(changedOnce, { polls: 5 });
  await changedOnceRun.controller.run();
  assert.deepEqual(changedOnceRun.stops, []);
});

t('dod5-disk: the traversal bounds: 200000 entries, depth 64, and only lstat and readdir are ever asked of the file system', async () => {
  const names = count => Array.from({ length: count }, (_, index) => `f${index}`);
  const flat = count => Object.fromEntries([[ROOT, { dir: names(count) }], ...names(count).map(name => [`${ROOT}/${name}`, { file: 0 }])]);
  const tooMany = world({ ...baseTree(), ...flat(200001) });
  const manyRun = make(tooMany, { polls: 2 });
  const manyResult = await manyRun.controller.run();
  assert.equal(manyResult.stop.reason, 'bound_entries', 'more than 200000 entries stops with the disk budget');
  assert.equal(manyRun.stops.length, 1);
  const exactly = world({ ...baseTree(), ...flat(200000) });
  assert.deepEqual(await make(exactly).controller.sample(), { bytes: 60, stop: null }, '200000 entries are within the bound');
  const chain = depth => {
    const tree = baseTree();
    let parent = ROOT;
    tree[ROOT] = { dir: ['d1'] };
    for (let level = 1; level <= depth; level += 1) {
      const here = `${parent}/d${level}`;
      tree[here] = { dir: level < depth ? [`d${level + 1}`] : ['leaf'] };
      if (level === depth) tree[`${here}/leaf`] = { file: 7 };
      parent = here;
    }
    return tree;
  };
  assert.deepEqual(await make(world(chain(63))).controller.sample(), { bytes: 67, stop: null }, 'a leaf at depth 64 is read');
  const deep = await make(world(chain(64))).controller.sample();
  assert.equal(deep.stop?.reason, 'bound_depth', 'a leaf at depth 65 is beyond the bound');
  // Only lstat and readdir are used: nothing is opened, so a FIFO or a socket cannot block the controller.
  const requested = new Set();
  const w = world(baseTree({ [`${ROOT}/pipe`]: { fifo: true }, [`${ROOT}/sock`]: { socket: true }, [`${ROOT}/link`]: { link: true }, [ROOT]: { dir: ['a.bin', 'sub', 'pipe', 'sock', 'link'] } }));
  const watched = new Proxy(w.ops, { get: (target, property) => { requested.add(property); return target[property]; } });
  const result = await make(w, { ops: watched }).controller.sample();
  assert.deepEqual(result, { bytes: TOTAL, stop: null }, 'special files and links add nothing');
  assert.deepEqual([...requested].sort(), ['lstat', 'readdir']);
  assert.ok(!w.calls.some(([op, target]) => op === 'readdir' && /pipe|sock|link/.test(target)), 'a FIFO, a socket or a link is never read as a directory');
});

t('dod5-disk: the stop signal is given once, with the disk kind, and the controller can be stopped from outside', async () => {
  const w = world(baseTree({ [`${ROOT}/a.bin`]: { file: 5000 } }));
  const { controller, stops } = make(w, { polls: 10 });
  const result = await controller.run();
  assert.equal(stops.length, 1);
  assert.deepEqual(stops[0], { budget_kind: 'disk', reason: 'size', bytes: 5260, at: 0 });
  assert.deepEqual(result, { stopped: true, stop: { budget_kind: 'disk', reason: 'size', bytes: 5260 } });
  assert.deepEqual(w.starts, [0], 'the loop ends at the stop');
  const again = await controller.run();
  assert.equal(stops.length, 1, 'a stopped controller does not signal again');
  assert.equal(again.stopped, true);
  // stop() before the first sample: the run ends without a sample.
  const idle = world(baseTree());
  const quiet = make(idle, { polls: 3 });
  quiet.controller.stop();
  assert.deepEqual(await quiet.controller.run(), { stopped: false, stop: null });
  assert.deepEqual(idle.starts, []);
  // A failing onStop does not hide the stop: the result still reports it.
  const loud = world(baseTree({ [`${ROOT}/a.bin`]: { file: 5000 } }));
  const failing = make(loud, { onStop: () => { throw new Error('handler failed'); } });
  assert.equal((await failing.controller.run()).stop.reason, 'size');
});
