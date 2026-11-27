// The disk controller of A8.6 (S4 wires it into the run): it samples the logical size of scratch, both reports and the log every 1000 ms
// while the agent runs, with lstat and readdir only (nothing is opened or followed), and signals a disk stop at or above the bound.
import fs from 'node:fs';
import path from 'node:path';

export const DISK_POLL_MS = 1000;
export const DISK_BOUNDS = { maxEntries: 200000, maxDepth: 64, maxTraversalMs: 10000 };

class Stop extends Error {}

const absolute = value => typeof value === 'string' && path.isAbsolute(value);

// scratch, files (the two reports and the log), limitBytes: positive safe integer; onStop(stop) is called once with
// {budget_kind: 'disk', reason, bytes}. ops, now, sleep and bounds are test seams (the production run passes none).
export function createDiskController({
  scratch, files, limitBytes, onStop, ops = { lstat: fs.promises.lstat, readdir: fs.promises.readdir }, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), bounds = {},
}) {
  if (!absolute(scratch)) throw new Error('the scratch path must be absolute');
  if (!Array.isArray(files) || !files.every(absolute)) throw new Error('the files must be absolute paths');
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) throw new Error('the disk bound is a positive safe integer');
  if (typeof onStop !== 'function') throw new Error('onStop is required');
  const limits = { ...DISK_BOUNDS, ...bounds };
  let failedBefore = new Set();
  let stopped = null;
  let halted = false;

  // One traversal. Nothing is counted twice per path and nothing is followed; a failure that happens on two samples in a row stops.
  async function sample() {
    const start = now();
    const failedNow = new Set();
    let total = 0;
    let entries = 0;
    const check = () => { if (now() - start > limits.maxTraversalMs) throw new Stop('bound_time'); };
    const SKIP = Symbol('skip');
    async function call(target, name) {
      let value;
      try { value = await ops[name](target); } catch (error) {
        if (error?.code !== 'ENOENT') {
          if (failedBefore.has(target)) throw new Stop(error?.code === 'ENOTDIR' ? 'type_change' : 'unreadable');
          failedNow.add(target);
        }
        check();
        return SKIP;
      }
      check();
      return value;
    }
    async function walk(directory, depth) {
      const names = await call(directory, 'readdir');
      if (names === SKIP) return;
      if (depth + 1 > limits.maxDepth && names.length > 0) throw new Stop('bound_depth');
      for (const name of names) {
        entries += 1;
        if (entries > limits.maxEntries) throw new Stop('bound_entries');
        const full = path.join(directory, name);
        const info = await call(full, 'lstat');
        if (info === SKIP) continue;
        if (info.isFile()) total += info.size;
        else if (info.isDirectory()) await walk(full, depth + 1);
      }
    }
    try {
      await walk(scratch, 0);
      for (const file of files) {
        const info = await call(file, 'lstat');
        if (info !== SKIP && info.isFile()) total += info.size;
      }
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
      return { bytes: total, stop: { budget_kind: 'disk', reason: error.message, bytes: total } };
    }
    failedBefore = failedNow;
    return { bytes: total, stop: total >= limitBytes ? { budget_kind: 'disk', reason: 'size', bytes: total } : null };
  }

  // A sample at the start (the release) and then one at every poll after the previous one finished: a long traversal runs to its bound and
  // the next starts at the next 1000 ms poll, never overlapping it.
  async function run() {
    while (!halted && stopped === null) {
      const started = now();
      const result = await sample();
      if (result.stop !== null) {
        stopped = result.stop;
        try { onStop(result.stop); } catch { /* the stop is reported in the result too */ }
        break;
      }
      if (halted) break;
      const polls = Math.max(1, Math.ceil((now() - started) / DISK_POLL_MS));
      await sleep(Math.max(0, started + polls * DISK_POLL_MS - now()));
    }
    return stopped === null ? { stopped: false, stop: null } : { stopped: true, stop: stopped };
  }

  return { sample, run, stop: () => { halted = true; } };
}
