// Runs the sidecar core on a Unix socket in a fresh temporary directory, in front of the stub endpoint, with the connection recorder
// as its upstream connect seam and the real `openai` profile. Everything is removed afterwards. No container, no network beyond the
// loopback address.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { createSidecar } from '../../container/proxy.mjs';
import * as openai from '../../providers/openai.mjs';
import { validateEvent } from '../../lib/events.mjs';
import { createRecorder } from './connection-recorder.mjs';
import { fixtureBase, forceRemove, must, mustAsync } from './fixtures.mjs';
import { syntheticKey } from './key-forms.mjs';
import { ENDPOINT_HOST, makeCertificates, startStub } from './stub-endpoint.mjs';

export const RUN_ID = 'a'.repeat(32);
export const ALLOWLIST = [ENDPOINT_HOST];

// options: cert ('good' | 'other' | 'self'), scenario (the stub's answer), limits, release (default true: phase agent), profile,
// deps (more test seams for createSidecar: now, setTimer, the robustness limits). `exits` records every exit code the sidecar asks for
// (it never ends the test process); `control(line)` feeds one control line.
export async function withSidecar(options, fn) {
  // A short directory name: the path of a Unix socket is limited to about 100 bytes.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fixtureBase(), 'acs-')));
  const cleanups = [['the temporary directory is removed', () => forceRemove(base)]];
  const left = budgetLeft();
  let failed = false;
  try {
    const certs = makeCertificates(base);
    const stub = await within(startStub({ tls: certs[options.cert ?? 'good'], scenario: options.scenario }), left(), 'the stub endpoint listens');
    cleanups.unshift(['the stub endpoint closes', () => stub.close()]);
    const recorder = createRecorder(stub.port);
    const key = syntheticKey();
    const events = [];
    const exits = [];
    const config = {
      run_id: RUN_ID, endpoint: { host: ENDPOINT_HOST, path: '/v1' }, allowlist: ALLOWLIST,
      limits: { calls: 50, tokens: 1000000, max_in_flight: 4, ...options.limits },
    };
    const sidecar = await mustAsync(async () => createSidecar({
      config, profile: options.profile ?? openai, key,
      deps: {
        connect: recorder.connect, ca: [...tls.rootCertificates, certs.ca], exit: code => exits.push(code), ...options.deps,
        emit: event => { options.onEvent?.(event, sidecar); events.push(event); },
      },
    }));
    const socket = path.join(base, 's');
    await within(mustAsync(() => sidecar.listen(socket)), left(), 'the sidecar listens');
    cleanups.unshift(['the sidecar closes', () => sidecar.close()]);
    if (options.release !== false) sidecar.release(options.deadline ?? Date.now() + 600000);
    // Waits until `count` request events were emitted (the event is emitted when the request ends, after the answer).
    const requestEvents = async (count, timeoutMs = 5000) => {
      const until = Date.now() + timeoutMs;
      while (events.filter(event => event.event === 'request').length < count && Date.now() < until) await new Promise(resolve => setImmediate(resolve));
      return events.filter(event => event.event === 'request');
    };
    const control = line => must(() => sidecar.control(line));
    const ofKind = kind => events.filter(event => event.event === kind);
    return await within(fn({ socket, stub, recorder, key, events, exits, requestEvents, sidecar, certs, config, control, ofKind }), left(), 'the test body');
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await runCleanups(cleanups, failed);
  }
}

// G11: the mutation runner counts a test that ends by its own time limit (or any failure that is not an assertion failure) as no
// evidence of a kill. So every wait of the sidecar tests has a limit of its own, well below the test's limit, and a wait that runs
// out is an assertion failure that names the wait. The start-up steps and the test body share BUDGET_MS from the start of the test,
// and each of the (at most three) cleanups has CLEANUP_MS: 22 s + 3 x 2 s stays below the 30 s limit of a test.
export const BUDGET_MS = 22000;
export const CLEANUP_MS = 2000;
// budgetLeft() starts a budget; calling the function it returns gives the milliseconds that are left of it.
export const budgetLeft = () => { const until = Date.now() + BUDGET_MS; return () => Math.max(0, until - Date.now()); };
const EXPIRED = Symbol('expired');
export async function within(promise, ms, what) {
  let timer;
  const expired = new Promise(resolve => { timer = setTimeout(() => resolve(EXPIRED), ms); });
  try {
    const value = await Promise.race([promise, expired]);
    if (value === EXPIRED) {
      promise.catch(() => {});
      assert.fail(`${what}: not within ${ms} ms`);
    }
    return value;
  } finally {
    clearTimeout(timer);
  }
}

// Runs every cleanup [what, fn] in order, each within CLEANUP_MS, also when an earlier one failed. A failed cleanup fails the test
// only when the test itself passed (`failed` false), so it never hides the test's own failure.
export async function runCleanups(cleanups, failed) {
  let problem = null;
  for (const [what, cleanup] of cleanups) {
    try { await within(Promise.resolve().then(cleanup), CLEANUP_MS, what); } catch (error) { problem ??= error; }
  }
  if (problem !== null && !failed) throw problem;
}

// Waits until predicate() is true or `timeoutMs` passes; returns the last value of predicate().
export async function waitFor(predicate, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  let value = predicate();
  while (!value && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 5));
    value = predicate();
  }
  return value;
}

// A fake timer seam: setTimer(fn, ms) records the call and returns a handle with clear(); fire() runs the pending ones.
export function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false, clear() { timer.cleared = true; } }; timers.push(timer); return timer; },
    fire() { for (const timer of timers.filter(item => !item.cleared)) { timer.cleared = true; timer.fn(); } },
  };
}

// Every emitted line is a valid sidecar event (A3.5, lib/events.mjs).
export const invalidEvents = events => events.map(event => validateEvent('sidecar', event, { allowlist: ALLOWLIST })).filter(problems => problems.length > 0);
