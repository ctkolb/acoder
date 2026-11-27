// The egress sidecar (A3.2): the only process that holds the model key. It answers the agent's requests on a Unix socket with
// `node:http`, refuses everything outside the allowlist and the provider profile, and forwards the rest to the endpoint over verified
// TLS with the key added. It imports only `node:` modules and accounting.mjs: the provider profile is passed in (A5).
// The launcher drives it with control lines (CLOCK, PHASE agent <deadline>, STOP; A3.5) and reads its event lines. Started as a
// program (`node proxy.mjs`), main() reads /acoder/egress.json and listens on /run/acoder-egress/egress.sock (A3.1).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import readline from 'node:readline';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { createAccounting } from './accounting.mjs';

export const CONFIG_PATH = '/acoder/egress.json';
export const SOCKET_PATH = '/run/acoder-egress/egress.sock';
// A8.5: the only exit code of a failing sidecar; it prints a `fatal` event with a fixed code first.
export const FATAL_EXIT = 70;
// The port of the agent's base URL (plan.mjs, A3.1.5): the Host header may carry it.
export const RELAY_PORT = 8080;
export const MAX_BODY = 32 * 1024 * 1024;
// S3-AC10: the robustness limits of the client side.
export const MAX_HEADER_BYTES = 16384;
export const HEADERS_TIMEOUT_MS = 60000;
export const IDLE_TIMEOUT_MS = 60000;
export const MAX_CONNECTIONS = 64;
const CHECK_INTERVAL_MS = 1000;
const HANDSHAKE_TIMEOUT_MS = 10000;
const MAX_MODEL = 64;
const PROBE_PATH = '/__acoder/probe';
const UPSTREAM_PORT = 443;
const REPLACEMENT = '[REDACTED]';
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'cookie'];
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade'];
const BUDGET_CODES = new Set(['acoder_budget_wall_clock', 'acoder_budget_calls', 'acoder_budget_tokens', 'acoder_usage_unreported']);
// A6.1: the sidecar exits by itself this long after the absolute deadline.
export const DEADLINE_GRACE_MS = 30000;
// The deadline of `PHASE agent <deadline>`: an unsigned decimal integer of epoch milliseconds (A3.6), and a safe integer.
const PHASE_LINE = /^PHASE agent ([0-9]+)$/;
const MAX_TIMER = 2147483647;

// setTimeout for any delay (a single Node timer holds at most about 24.8 days); returns {clear}.
function setTimer(fn, ms) {
  let handle;
  const arm = left => { handle = setTimeout(() => (left > MAX_TIMER ? arm(left - MAX_TIMER) : fn()), Math.min(left, MAX_TIMER)); };
  arm(ms);
  return { clear: () => clearTimeout(handle) };
}

// The key in the forms of A8.6 (raw; base64 and base64url in the three byte alignments; hex; percent-encoded), longest form first.
// Only the characters that depend on the key bytes alone are part of a base64 form.
function keyForms(key) {
  const bytes = Buffer.from(key);
  const base64 = (offset, encoding) => Buffer.concat([Buffer.alloc(offset), bytes]).toString(encoding).slice(Math.ceil((8 * offset) / 6), Math.floor((8 * (offset + bytes.length)) / 6));
  const hex = bytes.toString('hex');
  const percent = [...bytes].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('');
  const forms = [key, hex, hex.toUpperCase(), percent, percent.toUpperCase()];
  for (const offset of [0, 1, 2]) forms.push(base64(offset, 'base64'), base64(offset, 'base64url'));
  return [...new Set(forms)].sort((a, b) => b.length - a.length);
}

// The key redactor (A8.5): a header value has each form replaced; a header whose name holds a form is dropped; a body is redacted as a
// stream. Each replacement or dropped header counts one reflection.
function createRedactor(key) {
  const forms = keyForms(key);
  const pattern = new RegExp(forms.map(form => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  // The proper prefixes of the forms and their first characters: a body's end is held back only when it is one of them (A3.3).
  const prefixes = new Set(forms.flatMap(form => Array.from({ length: form.length - 1 }, (unused, index) => form.slice(0, index + 1))));
  const starts = new Set(forms.map(form => form[0]));
  let reflections = 0;
  const redact = text => text.replace(pattern, () => { reflections += 1; return REPLACEMENT; });
  return {
    redact,
    // A body as a stream of chunks: push(chunk) and end() return the bytes to send. Only the longest end of the text that is a proper
    // prefix of a form (at most longest form - 1 bytes) is held back until more arrive, so a form split across chunks is still found and
    // everything before it is sent at once (A3.3); a form that starts before that end is complete in the text.
    body() {
      const finder = new RegExp(pattern.source, 'g');
      const hold = forms[0].length - 1;
      let held = '';
      const run = (text, keep) => {
        const cut = text.length - keep;
        let out = '';
        let from = 0;
        finder.lastIndex = 0;
        for (let match = finder.exec(text); match !== null && match.index < cut; match = finder.exec(text)) {
          out += `${text.slice(from, match.index)}${REPLACEMENT}`;
          reflections += 1;
          from = finder.lastIndex;
        }
        const until = Math.max(from, cut);
        held = text.slice(until);
        return Buffer.from(`${out}${text.slice(from, until)}`, 'latin1');
      };
      // The length of the longest end of `text` that is a proper prefix of a form; at most `hold` ends are tried, each by its first
      // character before the set, so a chunk costs O(hold) whatever the body's size.
      const pending = text => {
        for (let keep = Math.min(text.length, hold); keep > 0; keep -= 1) {
          if (starts.has(text[text.length - keep]) && prefixes.has(text.slice(-keep))) return keep;
        }
        return 0;
      };
      return {
        push: chunk => {
          const text = `${held}${chunk.toString('latin1')}`;
          return run(text, pending(text));
        },
        end: () => run(held, 0),
      };
    },
    // rawHeaders [name, value, ...] -> the same list without the names in `drop` and without names that hold the key, values redacted.
    headers(rawHeaders, drop) {
      const out = [];
      for (let index = 0; index < rawHeaders.length; index += 2) {
        const name = rawHeaders[index];
        if (drop.has(name.toLowerCase())) continue;
        pattern.lastIndex = 0;
        if (pattern.test(name)) { pattern.lastIndex = 0; reflections += 1; continue; }
        out.push(name, redact(rawHeaders[index + 1]));
      }
      return out;
    },
    count: () => reflections,
  };
}

const headerValues = (rawHeaders, wanted) => rawHeaders.filter((value, index) => index % 2 === 1 && rawHeaders[index - 1].toLowerCase() === wanted);
// The header names a Connection header lists are hop-by-hop too.
const connectionTokens = rawHeaders => headerValues(rawHeaders, 'connection').flatMap(value => value.split(',')).map(token => token.trim().toLowerCase()).filter(Boolean);

// A3.2 step 4: exactly one Host header; lower-cased, with no port or the relay port, it must equal an allowlist entry exactly.
function matchHost(rawHeaders, allowlist) {
  const values = headerValues(rawHeaders, 'host');
  if (values.length !== 1) return null;
  const match = /^([^:]*)(?::(\d+))?$/.exec(values[0].toLowerCase());
  if (match === null || (match[2] !== undefined && match[2] !== String(RELAY_PORT))) return null;
  return allowlist.find(entry => entry === match[1]) ?? null;
}

export function sanitizeModel(text) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(/[^\x20-\x7e]/g, '?').slice(0, MAX_MODEL);
  return clean === '' ? null : clean;
}

const writeLine = event => { process.stdout.write(`${JSON.stringify(event)}\n`); };

// config: the parsed egress.json {run_id, endpoint: {host, path}, allowlist, limits: {calls, tokens, max_in_flight}}; profile: the
// provider profile module (A5); key: the model key. deps (test seams): connect (tls.connect), ca (the trust list; default: the system
// trust store and NODE_EXTRA_CA_CERTS), now (Date.now), emit (prints one event line), exit (ends the process with a code), setTimer, and
// the robustness limits headersTimeoutMs, idleTimeoutMs, maxConnections, checkIntervalMs.
export function createSidecar({ config, profile, key, deps = {} }) {
  const { connect = tls.connect, ca, now = Date.now, emit: print = writeLine, exit = code => process.exit(code) } = deps;
  const { headersTimeoutMs = HEADERS_TIMEOUT_MS, idleTimeoutMs = IDLE_TIMEOUT_MS, maxConnections = MAX_CONNECTIONS, checkIntervalMs = CHECK_INTERVAL_MS } = deps;
  const schedule = deps.setTimer ?? setTimer;
  const { host: endpointHost, path: endpointPath } = config.endpoint;
  const accounting = createAccounting({ calls: config.limits.calls, tokens: config.limits.tokens, maxInFlight: config.limits.max_in_flight });
  const redactor = createRedactor(key);
  const tlsOptions = { host: endpointHost, port: UPSTREAM_PORT, servername: endpointHost, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'], ...(ca === undefined ? {} : { ca }) };
  // After a fatal event nothing more is printed.
  let dead = false;
  const emit = event => { if (!dead) print(event); };
  const connections = new Set();
  // A8.5: an unexpected error prints a fatal event with a code only and ends the process with FATAL_EXIT.
  function fatal(code) {
    if (dead) return;
    print({ event: 'fatal', code });
    dead = true;
    stopped = true;
    deadlineTimer?.clear();
    for (const socket of connections) socket.destroy();
    exit(FATAL_EXIT);
  }
  const guard = fn => (...args) => { try { return fn(...args); } catch { return fatal('internal_error'); } };
  const authHeaders = profile.authHeaders(key);
  const allowed = profile.requests.map(entry => ({ method: entry.method, target: `${endpointPath}${entry.suffix}` }));
  let phase = 'probe';
  let seq = 0;
  // Control state: CLOCK is answered once before any PHASE line; only the first PHASE line can release; STOP ends the sidecar.
  let clocked = false;
  let phaseLines = 0;
  let stopped = false;
  let deadlineTimer = null;
  // The abort functions of the forwarded requests in flight.
  const active = new Set();
  const totals = { refused_probe: 0, refused_agent: 0, refused_by_reason: {}, bytes_up: 0, bytes_down: 0 };

  const iso = ms => new Date(ms).toISOString();
  function begin(req) {
    const probe = req.headers['x-acoder-probe'];
    return {
      event: 'request', seq: (seq += 1), phase, opened: iso(now()), closed: null, host: null, decision: 'refused', reason: null, status: null, complete: false,
      bytes_up: 0, bytes_down: 0, usage: null, response_model: null, probe: phase === 'probe' && typeof probe === 'string' && /^[0-9a-f]{32}$/.test(probe) ? probe : null,
    };
  }
  function end(record) {
    record.closed = iso(now());
    if (record.decision === 'refused') {
      totals[record.phase === 'probe' ? 'refused_probe' : 'refused_agent'] += 1;
      totals.refused_by_reason[record.reason] = (totals.refused_by_reason[record.reason] ?? 0) + 1;
    }
    totals.bytes_up += record.bytes_up;
    totals.bytes_down += record.bytes_down;
    emit(record);
  }
  // A6.5: the retained limit is printed once, at the first refusal for it or before whatever reports the latch otherwise.
  function printPending() {
    const kind = accounting.pendingLimit();
    if (kind === null) return;
    emit({ event: 'limit', kind });
  }

  const errorBody = code => JSON.stringify({ error: { code } });
  // Answers with the fixed status and code and closes the connection (target: a ServerResponse, or the raw socket of CONNECT/Upgrade).
  function answerError(target, status, code) {
    const body = errorBody(code);
    if (target instanceof http.ServerResponse) {
      target.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' });
      target.end(body);
    } else {
      target.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
    }
  }
  function refuse(target, record, status, code) {
    record.decision = 'refused';
    record.reason = code;
    record.status = status;
    record.complete = true;
    if (BUDGET_CODES.has(code)) {
      const kind = accounting.pendingLimit();
      if (kind !== null) emit({ event: 'limit', kind });
    }
    answerError(target, status, code);
    end(record);
  }

  // A3.2 steps 1 to 9, in this order.
  function handle(req, res) {
    // D-S1.d: after STOP a request gets no answer and no event; its connection is destroyed.
    if (stopped) { req.socket.destroy(); return; }
    const record = begin(req);
    // Step 2: the local probe path.
    if (req.method === 'GET' && req.url === PROBE_PATH) {
      const body = JSON.stringify({ run_id: config.run_id, phase });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      Object.assign(record, { decision: 'local', status: 200, complete: true });
      return end(record);
    }
    // Step 3: CONNECT, Upgrade, HTTP other than 1.1, and an Expect header (interim answers are not relayed).
    if (req.method === 'CONNECT' || req.headers.upgrade !== undefined || req.httpVersion !== '1.1' || req.headers.expect !== undefined) return refuse(res, record, 405, 'acoder_method_not_allowed');
    // Step 4: the host.
    const host = matchHost(req.rawHeaders, config.allowlist);
    if (host === null) return refuse(res, record, 403, 'acoder_host_not_allowed');
    record.host = host;
    // Step 5: the request kind, compared exactly (no query string).
    if (!allowed.some(entry => entry.method === req.method && entry.target === req.url)) return refuse(res, record, 403, 'acoder_path_not_allowed');
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > MAX_BODY) return refuse(res, record, 413, 'acoder_body_too_large');
    // Steps 1 and 6: in phase probe a request that passes steps 3 to 6 is not released; in phase agent it is admitted or refused.
    if (phase === 'probe') {
      const code = accounting.check(now());
      return code === null ? refuse(res, record, 403, 'acoder_not_released') : refuse(res, record, 429, code);
    }
    const admission = accounting.admit(now());
    if (!admission.ok) return refuse(res, record, 429, admission.code);
    return forward(req, res, record, admission.id);
  }

  // Steps 7 to 9: the call was counted at admission; the request goes to https://<endpoint host>:443<path> over verified TLS.
  function forward(req, res, record, id) {
    record.decision = 'forwarded';
    const drop = new Set([...CREDENTIAL_HEADERS, ...HOP_BY_HOP, ...connectionTokens(req.rawHeaders), 'host', 'accept-encoding', 'expect']);
    const headers = {};
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      const name = req.rawHeaders[index].toLowerCase();
      if (!drop.has(name)) (headers[name] ??= []).push(req.rawHeaders[index + 1]);
    }
    Object.assign(headers, { host: endpointHost, 'accept-encoding': 'identity' }, authHeaders);

    let secured = false;
    let finished = false;
    let extractor = null;
    const upstream = https.request({
      method: req.method, path: req.url, headers, setHost: false,
      createConnection: () => {
        const socket = connect({ ...tlsOptions });
        socket.once('secureConnect', () => { secured = true; });
        return socket;
      },
    });

    function finish(complete) {
      if (finished) return;
      finished = true;
      record.complete = complete;
      let result = { usage: null, model: null };
      if (extractor !== null) { try { result = extractor.result(); } catch { /* a broken extractor means no usage */ } }
      record.usage = result.usage ?? null;
      const model = sanitizeModel(result.model);
      record.response_model = model === null ? null : sanitizeModel(redactor.redact(model));
      active.delete(abort);
      // A6.5: a deadline that passed before the request closed has latched wall_clock, also when no request or timer read the clock
      // since; the request's missing usage is then a lower bound, not usage_unreported (R31-01).
      accounting.check(now());
      accounting.finish(id, { complete, status: record.status, usage: record.usage });
      if (!complete) printPending();
      end(record);
    }
    // STOP and the deadline exit abort the request: it ends incomplete, with the usage seen so far.
    function abort() {
      upstream.destroy();
      if (!res.destroyed) res.destroy();
      finish(false);
    }
    active.add(abort);
    function fail(status, code) {
      upstream.destroy();
      record.status = status;
      if (!res.headersSent) answerError(res, status, code);
      else res.destroy();
      finish(false);
    }

    upstream.on('error', guard(() => { if (!finished) fail(502, secured ? 'acoder_upstream_error' : 'acoder_upstream_tls'); }));
    res.on('close', guard(() => { if (!finished) { upstream.destroy(); finish(false); } }));

    // The body is streamed, not parsed, and cut off above MAX_BODY.
    req.on('data', guard(chunk => {
      if (finished) return;
      if (record.bytes_up + chunk.length > MAX_BODY) { req.pause(); fail(413, 'acoder_body_too_large'); return; }
      record.bytes_up += chunk.length;
      if (!upstream.write(chunk)) { req.pause(); upstream.once('drain', () => req.resume()); }
    }));
    req.on('end', guard(() => { if (!finished) upstream.end(); }));

    upstream.on('response', guard(answer => {
      if (finished) { answer.destroy(); return; }
      const encoding = answer.headers['content-encoding'];
      if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') { answer.destroy(); fail(502, 'acoder_upstream_encoding'); return; }
      record.status = answer.statusCode;
      const drop = new Set([...HOP_BY_HOP, ...connectionTokens(answer.rawHeaders)]);
      // The redacted body can differ in length from the endpoint's, so it is sent with the framing of this answer.
      drop.add('content-length');
      res.writeHead(answer.statusCode, redactor.headers(answer.rawHeaders, drop));
      extractor = profile.createUsageExtractor(answer.headers['content-type']);
      // The extractor reads the endpoint's bytes; the agent gets them only through the body redactor (A8.5).
      const body = redactor.body();
      answer.on('data', guard(chunk => {
        record.bytes_down += chunk.length;
        try { extractor.push(chunk); } catch { /* a broken extractor means no usage */ }
        const out = body.push(chunk);
        if (out.length > 0 && !res.write(out)) { answer.pause(); res.once('drain', () => answer.resume()); }
      }));
      answer.on('end', guard(() => { if (!finished) { res.end(body.end()); finish(true); } }));
      answer.on('error', guard(() => { if (!finished) { res.destroy(); finish(false); } }));
    }));
  }

  const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES, headersTimeout: headersTimeoutMs, connectionsCheckingInterval: checkIntervalMs }, guard(handle));
  // An idle connection is destroyed after the idle limit; connections above the cap are closed at once (S3-AC10).
  server.setTimeout(idleTimeoutMs);
  server.maxConnections = maxConnections;
  // An Expect: 100-continue request is refused like any other Expect header (step 3), without an interim answer.
  server.on('checkContinue', guard(handle));
  const refuseSocket = guard((req, socket) => {
    socket.on('error', () => {});
    if (stopped) { socket.destroy(); return; }
    refuse(socket, begin(req), 405, 'acoder_method_not_allowed');
  });
  server.on('connect', refuseSocket);
  server.on('upgrade', refuseSocket);
  server.on('connection', socket => {
    if (stopped) { socket.destroy(); return; }
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });

  function summary() {
    const counts = accounting.snapshot();
    return {
      event: 'summary', forwarded: counts.forwarded, refused_probe: totals.refused_probe, refused_agent: totals.refused_agent, refused_by_reason: { ...totals.refused_by_reason },
      bytes_up: totals.bytes_up, bytes_down: totals.bytes_down, key_reflections: redactor.count(), usage_missing: counts.usage_missing,
      admitted_after_token_limit: counts.admitted_after_token_limit, in_flight_at_limit: counts.in_flight_at_limit, tokens: counts.tokens,
    };
  }
  // STOP, end of input and the deadline exit (A3.5, A6.5): latch admissions, abort the requests in flight, print the pending limit and the
  // summary, then exit 0. Later requests are destroyed without an answer (D-S1.d).
  function stop() {
    if (stopped) return;
    stopped = true;
    deadlineTimer?.clear();
    accounting.stop();
    for (const abort of [...active]) abort();
    printPending();
    emit(summary());
    exit(0);
  }
  // The launcher's release (PHASE agent <deadline>): the phase changes once; the deadline refuses later requests and ends the sidecar
  // DEADLINE_GRACE_MS after it.
  // SPEC-14: every client connection open at the switch is destroyed before the phase event, so no connection crosses the boundary.
  function release(deadline) {
    if (phase !== 'probe') throw new Error('released once');
    accounting.setDeadline(deadline);
    for (const socket of connections) socket.destroy();
    connections.clear();
    phase = 'agent';
    emit({ event: 'phase', phase });
    deadlineTimer = schedule(guard(() => { accounting.check(now()); stop(); }), deadline + DEADLINE_GRACE_MS - now());
  }
  // One control line of the launcher (A3.5). A line that is not valid in the current state is rejected and changes nothing; a second
  // PHASE line of any kind is fatal.
  function control(line) {
    if (line === 'STOP') return stop();
    if (stopped) return;
    if (line === 'CLOCK') {
      if (clocked || phaseLines > 0) return;
      clocked = true;
      emit({ event: 'clock', clock_epoch_ms: now() });
      return;
    }
    if (line === 'PHASE' || line.startsWith('PHASE ')) {
      phaseLines += 1;
      if (phaseLines > 1) return fatal('internal_error');
      const match = PHASE_LINE.exec(line);
      const deadline = match === null ? Number.NaN : Number(match[1]);
      if (Number.isSafeInteger(deadline)) release(deadline);
    }
  }
  // U2 (A3.6): resolve the endpoint host and complete a verified TLS handshake on port 443; no HTTP request and no key is sent.
  function handshake() {
    return new Promise(resolve => {
      const socket = connect({ ...tlsOptions });
      let timer = null;
      const report = result => {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
        const address = typeof socket.remoteAddress === 'string' && socket.remoteAddress !== '' ? socket.remoteAddress : null;
        socket.destroy();
        if (!stopped) emit({ event: 'upstream', host: endpointHost, handshake: result, address });
        resolve();
      };
      timer = setTimeout(() => report('failed'), HANDSHAKE_TIMEOUT_MS);
      socket.once('secureConnect', () => report('ok'));
      socket.once('error', () => report('failed'));
    });
  }

  return {
    server, accounting, release, fatal, handshake,
    control: guard(control),
    stop: guard(stop),
    listen: socketPath => new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); }),
    close: () => new Promise(resolve => { deadlineTimer?.clear(); server.closeAllConnections(); server.close(() => resolve()); }),
    phase: () => phase,
    stats: () => ({ key_reflections: redactor.count(), connections: connections.size }),
  };
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasFields = (value, fields) => isObject(value) && Object.keys(value).sort().join() === [...fields].sort().join();
const isPositive = value => Number.isSafeInteger(value) && value > 0;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ENDPOINT_PATH = /^(?:\/[^/\s?#\\]+)*$/;
const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;
// A8.2: the key is at least 16 characters of [A-Za-z0-9_-].
const KEY = /^[A-Za-z0-9_-]{16,}$/;

// egress.json exactly as plan.mjs writes it (A3.1); anything else is refused.
function validConfig(config) {
  if (!hasFields(config, ['run_id', 'provider', 'endpoint', 'allowlist', 'key_env', 'limits', 'extra_ca'])) return false;
  const { run_id: runId, provider, endpoint, allowlist, key_env: keyEnv, limits } = config;
  return typeof runId === 'string' && RUN_ID.test(runId)
    && hasFields(provider, ['id', 'module']) && typeof provider.id === 'string' && typeof provider.module === 'string' && provider.module.startsWith('/')
    && hasFields(endpoint, ['host', 'path']) && typeof endpoint.host === 'string' && HOST_NAME.test(endpoint.host) && typeof endpoint.path === 'string' && ENDPOINT_PATH.test(endpoint.path)
    && Array.isArray(allowlist) && allowlist.every(entry => typeof entry === 'string' && HOST_NAME.test(entry)) && allowlist.includes(endpoint.host)
    && typeof keyEnv === 'string' && VARIABLE_NAME.test(keyEnv)
    && hasFields(limits, ['calls', 'tokens', 'max_in_flight']) && isPositive(limits.calls) && (limits.tokens === null || isPositive(limits.tokens)) && isPositive(limits.max_in_flight)
    && typeof config.extra_ca === 'boolean';
}
// The provider profile of A5, loaded from the path in egress.json.
const validProfile = (profile, id) => profile.id === id && Array.isArray(profile.requests) && profile.requests.every(entry => isObject(entry) && typeof entry.method === 'string' && typeof entry.suffix === 'string')
  && typeof profile.authHeaders === 'function' && typeof profile.createUsageExtractor === 'function';

// Start-up (S3-AC9): the configuration, the key from the variable NAMED there, the profile, the socket (mode 0600, never over an existing
// entry), the `ready` event, the control lines from standard input (end of input is STOP) and the U2 handshake. Every refusal is a
// `fatal` event and exit FATAL_EXIT without listening. options (test seams): configPath, socketPath, env, input, deps (createSidecar's).
export async function main({ configPath = CONFIG_PATH, socketPath = SOCKET_PATH, env = process.env, input = process.stdin, deps = {} } = {}) {
  const print = deps.emit ?? writeLine;
  let ending = false;
  // The process ends once the event lines are written.
  const exit = code => {
    if (ending) return;
    ending = true;
    setTimeout(() => process.exit(code), 2000);
    process.stdout.write('', () => process.exit(code));
  };
  let sidecar = null;
  const fatal = code => {
    if (sidecar !== null) return sidecar.fatal(code);
    if (!ending) print({ event: 'fatal', code });
    return exit(FATAL_EXIT);
  };
  process.on('uncaughtException', () => fatal('internal_error'));
  process.on('unhandledRejection', () => fatal('internal_error'));

  let text;
  let config;
  try {
    text = fs.readFileSync(configPath);
    config = JSON.parse(text.toString('utf8'));
  } catch {
    return fatal('config_invalid');
  }
  if (!validConfig(config)) return fatal('config_invalid');
  const key = env[config.key_env];
  if (typeof key !== 'string' || !KEY.test(key)) return fatal('config_invalid');
  let profile;
  try { profile = await import(pathToFileURL(config.provider.module).href); } catch { return fatal('config_invalid'); }
  if (!validProfile(profile, config.provider.id)) return fatal('config_invalid');
  if (fs.lstatSync(socketPath, { throwIfNoEntry: false }) !== undefined) return fatal('listen_failed');
  let created;
  try { created = createSidecar({ config, profile, key, deps: { ...deps, emit: print, exit } }); } catch { return fatal('config_invalid'); }
  sidecar = created;
  // The socket is created with mode 0600 (no moment with a wider mode) and set to 0600 again.
  const umask = process.umask(0o177);
  try {
    await sidecar.listen(socketPath);
  } catch {
    return fatal('listen_failed');
  } finally {
    process.umask(umask);
  }
  try { fs.chmodSync(socketPath, 0o600); } catch { return fatal('socket_error'); }
  print({ event: 'ready', config_sha256: createHash('sha256').update(text).digest('hex'), env_names: Object.keys(env).sort(), clock_epoch_ms: (deps.now ?? Date.now)() });
  const lines = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on('line', line => sidecar.control(line));
  lines.on('close', () => sidecar.stop());
  return sidecar.handshake();
}

// `node proxy.mjs` in the sidecar container.
const invoked = () => { try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; } };
if (invoked()) main();
