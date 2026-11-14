// Runs the sidecar core on a Unix socket in a fresh temporary directory, in front of the stub endpoint, with the connection recorder
// as its upstream connect seam and the real `openai` profile. Everything is removed afterwards. No container, no network beyond the
// loopback address.
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import nodeTest from 'node:test';
import { createSidecar } from '../../container/proxy.mjs';
import * as openai from '../../providers/openai.mjs';
import { validateEvent } from '../../lib/events.mjs';
import { createRecorder } from './connection-recorder.mjs';
import { fixtureBase, forceRemove, mustAsync } from './fixtures.mjs';
import { syntheticKey } from './key-forms.mjs';
import { ENDPOINT_HOST, OPENSSL_MISSING, makeCertificates, startStub } from './stub-endpoint.mjs';

export const RUN_ID = 'a'.repeat(32);
export const ALLOWLIST = [ENDPOINT_HOST];

// G11: a sidecar test has its own time limit and is skipped with the reason when `openssl` is absent. Registered from the calling file.
export const sidecarTest = (test = nodeTest) => (name, fn, timeout = 30000) => test(name, { timeout, skip: OPENSSL_MISSING }, fn);

// options: cert ('good' | 'other' | 'self'), scenario (the stub's answer), limits, release (default true: phase agent).
export async function withSidecar(options, fn) {
  // A short directory name: the path of a Unix socket is limited to about 100 bytes.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fixtureBase(), 'acs-')));
  const cleanups = [() => forceRemove(base)];
  try {
    const certs = makeCertificates(base);
    const stub = await startStub({ tls: certs[options.cert ?? 'good'], scenario: options.scenario });
    cleanups.unshift(() => stub.close());
    const recorder = createRecorder(stub.port);
    const key = syntheticKey();
    const events = [];
    const config = {
      run_id: RUN_ID, endpoint: { host: ENDPOINT_HOST, path: '/v1' }, allowlist: ALLOWLIST,
      limits: { calls: 50, tokens: 1000000, max_in_flight: 4, ...options.limits },
    };
    const sidecar = await mustAsync(async () => createSidecar({
      config, profile: options.profile ?? openai, key,
      deps: { connect: recorder.connect, ca: [...tls.rootCertificates, certs.ca], emit: event => events.push(event) },
    }));
    const socket = path.join(base, 's');
    await mustAsync(() => sidecar.listen(socket));
    cleanups.unshift(() => sidecar.close());
    if (options.release !== false) sidecar.release(Date.now() + 600000);
    // Waits until `count` request events were emitted (the event is emitted when the request ends, after the answer).
    const requestEvents = async (count, timeoutMs = 5000) => {
      const until = Date.now() + timeoutMs;
      while (events.filter(event => event.event === 'request').length < count && Date.now() < until) await new Promise(resolve => setImmediate(resolve));
      return events.filter(event => event.event === 'request');
    };
    return await fn({ socket, stub, recorder, key, events, requestEvents, sidecar, certs, config });
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
}

// Every emitted line is a valid sidecar event (A3.5, lib/events.mjs).
export const invalidEvents = events => events.map(event => validateEvent('sidecar', event, { allowlist: ALLOWLIST })).filter(problems => problems.length > 0);
