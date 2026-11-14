// The egress sidecar (A3.2): the only process that holds the model key. It answers the agent's requests on a Unix socket with
// `node:http`, refuses everything outside the allowlist and the provider profile, and forwards the rest to the endpoint over verified
// TLS with the key added. It imports only `node:` modules and accounting.mjs: the provider profile is passed in (A5).
// The launcher drives it with control lines (CLOCK, PHASE agent <deadline>, STOP; A3.5) and reads its event lines.
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import { createAccounting } from './accounting.mjs';

// The port of the agent's base URL (plan.mjs, A3.1.5): the Host header may carry it.
export const RELAY_PORT = 8080;
export const MAX_BODY = 32 * 1024 * 1024;
const MAX_HEADER_BYTES = 16384;
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

// The key in the forms of A8.6 (raw; base64 and base64url in the three byte alignments; hex; percent-encoded), as one pattern,
// longest form first. Only the characters that depend on the key bytes alone are part of a base64 form.
function keyPattern(key) {
  const bytes = Buffer.from(key);
  const base64 = (offset, encoding) => Buffer.concat([Buffer.alloc(offset), bytes]).toString(encoding).slice(Math.ceil((8 * offset) / 6), Math.floor((8 * (offset + bytes.length)) / 6));
  const hex = bytes.toString('hex');
  const percent = [...bytes].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('');
  const forms = [key, hex, hex.toUpperCase(), percent, percent.toUpperCase()];
  for (const offset of [0, 1, 2]) forms.push(base64(offset, 'base64'), base64(offset, 'base64url'));
  const unique = [...new Set(forms)].sort((a, b) => b.length - a.length);
  return new RegExp(unique.map(form => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
}

// Header redaction (A8.5): a value has each form replaced; a header whose name holds a form is dropped. Each counts one reflection.
function createHeaderRedactor(key) {
  const pattern = keyPattern(key);
  let reflections = 0;
  const redact = text => text.replace(pattern, () => { reflections += 1; return REPLACEMENT; });
  return {
    redact,
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
// trust store and NODE_EXTRA_CA_CERTS), now (Date.now), emit (prints one event line), exit (ends the process with a code), setTimer.
export function createSidecar({ config, profile, key, deps = {} }) {
  const { connect = tls.connect, ca, now = Date.now, emit = writeLine, exit = code => process.exit(code) } = deps;
  const schedule = deps.setTimer ?? setTimer;
  const { host: endpointHost, path: endpointPath } = config.endpoint;
  const accounting = createAccounting({ calls: config.limits.calls, tokens: config.limits.tokens, maxInFlight: config.limits.max_in_flight });
  const redactor = createHeaderRedactor(key);
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
        const socket = connect({ host: endpointHost, port: UPSTREAM_PORT, servername: endpointHost, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'], ...(ca === undefined ? {} : { ca }) });
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

    upstream.on('error', () => { if (!finished) fail(502, secured ? 'acoder_upstream_error' : 'acoder_upstream_tls'); });
    res.on('close', () => { if (!finished) { upstream.destroy(); finish(false); } });

    // The body is streamed, not parsed, and cut off above MAX_BODY.
    req.on('data', chunk => {
      if (finished) return;
      if (record.bytes_up + chunk.length > MAX_BODY) { req.pause(); fail(413, 'acoder_body_too_large'); return; }
      record.bytes_up += chunk.length;
      if (!upstream.write(chunk)) { req.pause(); upstream.once('drain', () => req.resume()); }
    });
    req.on('end', () => { if (!finished) upstream.end(); });

    upstream.on('response', answer => {
      if (finished) { answer.destroy(); return; }
      const encoding = answer.headers['content-encoding'];
      if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') { answer.destroy(); fail(502, 'acoder_upstream_encoding'); return; }
      record.status = answer.statusCode;
      const drop = new Set([...HOP_BY_HOP, ...connectionTokens(answer.rawHeaders)]);
      res.writeHead(answer.statusCode, redactor.headers(answer.rawHeaders, drop));
      extractor = profile.createUsageExtractor(answer.headers['content-type']);
      answer.on('data', chunk => {
        record.bytes_down += chunk.length;
        try { extractor.push(chunk); } catch { /* a broken extractor means no usage */ }
        if (!res.write(chunk)) { answer.pause(); res.once('drain', () => answer.resume()); }
      });
      answer.on('end', () => { if (!finished) { res.end(); finish(true); } });
      answer.on('error', () => { if (!finished) { res.destroy(); finish(false); } });
    });
  }

  const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, handle);
  // An Expect: 100-continue request is refused like any other Expect header (step 3), without an interim answer.
  server.on('checkContinue', handle);
  const refuseSocket = (req, socket) => {
    socket.on('error', () => {});
    if (stopped) { socket.destroy(); return; }
    refuse(socket, begin(req), 405, 'acoder_method_not_allowed');
  };
  server.on('connect', refuseSocket);
  server.on('upgrade', refuseSocket);
  server.on('connection', socket => { if (stopped) socket.destroy(); });

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
  function release(deadline) {
    if (phase !== 'probe') throw new Error('released once');
    accounting.setDeadline(deadline);
    phase = 'agent';
    emit({ event: 'phase', phase });
    deadlineTimer = schedule(() => { accounting.check(now()); stop(); }, deadline + DEADLINE_GRACE_MS - now());
  }
  // One control line of the launcher (A3.5). A line that is not valid in the current state is rejected and changes nothing.
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
      if (phaseLines > 1) return;
      const match = PHASE_LINE.exec(line);
      const deadline = match === null ? Number.NaN : Number(match[1]);
      if (Number.isSafeInteger(deadline)) release(deadline);
    }
  }

  return {
    server, accounting, control, release, stop,
    listen: socketPath => new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); }),
    close: () => new Promise(resolve => { deadlineTimer?.clear(); server.closeAllConnections(); server.close(() => resolve()); }),
    phase: () => phase,
    stats: () => ({ key_reflections: redactor.count() }),
  };
}
