// runReview(options, deps): the run sequence of A6.6 on real containers. This part holds the launch plan and the payloads (A2.1, A2.2);
// the sequence itself follows below.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEventLine, parseSupervisorLine } from './events.mjs';
import { PLACEHOLDER_KEY, agentEnvNames, buildPlan, containerBaseUrl, endpointParts, hostsFile, resolvConf } from './plan.mjs';
import { checkImageAndRuntime, prepare } from './prepare.mjs';
import { buildRecord, canonicalHash, launcherSection, makeRunId, preparedSections, recordNames, writeRecord } from './record.mjs';
import { createRedactor, emptyScan, SCAN_BOUNDS, scanTree } from './redact.mjs';
import { createRuntime, findRuntime } from './runtime.mjs';
import { createDiskController } from './budget.mjs';
import { Refusal, safe } from './refusal.mjs';
import { removeStaging } from './snapshot.mjs';
import { evaluateRun } from './state.mjs';

export const LAUNCHER_VERSION = '0.1.0';
const LAUNCHER_ROOT = fileURLToPath(new URL('..', import.meta.url));
const AGENT_PROGRAMS = ['container/entry.mjs', 'container/probe.mjs', 'container/relay.mjs'];
const EGRESS_PROGRAMS = ['container/proxy.mjs', 'container/accounting.mjs'];
// A8.3: the names a runtime adds to every container by itself (recorded; U1 and P8 accept them besides the plan).
export const INJECTED_ENV = { docker: ['HOME', 'HOSTNAME', 'TERM'], podman: ['HOME', 'HOSTNAME', 'TERM', 'container'] };
const sha256 = text => createHash('sha256').update(text).digest('hex');

// The plan of one attempt (A15 of plan.mjs) with the probe input of the supervisor (A8.3 ACODER_PROBE_INPUT). p6: the addresses P6 must
// not reach, [{address, port}], known only once the sidecar runs; the plan is built again with them before the agent container is created.
export function planFor({ options, settings, prepared, adapters, providers, image, runtimeName, runId, eventPrefix, nonce, uid, gid, p6 = [] }) {
  const { host, path: endpointPath } = endpointParts(settings.endpoint);
  const command = adapters[settings.agent].command({
    model: settings.model, effort: settings.effort, provider: { id: settings.provider, baseUrl: containerBaseUrl(settings.endpoint), placeholderKey: PLACEHOLDER_KEY },
    firstMessage: `This is an acoder container launch. TICKET ${prepared.tag} at ${options.ticket}`, workdir: prepared.writable.scratch,
  });
  const skillSha256 = canonicalHash(prepared.staging.skill);
  const profile = providers?.[settings.provider];
  const allowedPath = `${endpointPath}${profile?.requests?.[0]?.suffix ?? '/responses'}`;
  const { writable } = prepared;
  const probeInput = {
    nonce, run_id: runId, tag: prepared.tag, ticket_sha256: prepared.ticket.sha256, skill_sha256: skillSha256,
    hosts_sha256: sha256(hostsFile([host])), resolv_sha256: sha256(resolvConf()), allowed_names: [host],
    probe_paths: { allowed: allowedPath, denied: `${endpointPath}/acoder-probe-denied` }, p6,
    env_names: agentEnvNames(command.env, image.env_names), env_allowance: INJECTED_ENV[runtimeName], uid, gid,
    paths: {
      ticket: options.ticket, ledger: path.join(options.mailbox, 'orchestrator', 'tickets.json'), beside: path.join(writable.stage, `acoder-probe-${nonce}`),
      scratch: writable.scratch, report_md: writable.reportMd, report_json: writable.reportJson,
    },
  };
  return buildPlan({
    runtime: runtimeName, runId, tag: prepared.tag, ticketSha256: prepared.ticket.sha256, skillSha256, launcherVersion: LAUNCHER_VERSION,
    uid, gid, image: image.id, imageEnvNames: image.env_names, mailbox: options.mailbox,
    exports: options.exports.map(({ role }) => ({ role, dir: prepared.exports[role].dir, insideMailbox: prepared.exports[role].inside_mailbox })),
    staging: {
      dir: prepared.staging.dir, mailbox: prepared.staging.mailbox, agentPayload: path.join(prepared.staging.dir, 'agent-payload'), egressPayload: path.join(prepared.staging.dir, 'egress-payload'),
      exports: Object.fromEntries(options.exports.map(({ role }) => [role, prepared.exports[role].copy])),
    },
    writable: { scratch: writable.scratch, reportMd: writable.reportMd, reportJson: writable.reportJson }, scratchSize: options.scratchSize, limits: settings.limits,
    endpoint: settings.endpoint, provider: { id: settings.provider }, agent: command, extraCa: options.extraCaCert !== null, eventPrefix, probeInput,
  });
}

function writeNew(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
}

// A source file of the payload is read with no-follow (a link is never copied).
function readSource(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}

function makeReadOnly(directory) {
  for (const name of fs.readdirSync(directory)) {
    const full = path.join(directory, name);
    const info = fs.lstatSync(full);
    if (info.isDirectory()) makeReadOnly(full);
    else if (info.isFile()) fs.chmodSync(full, 0o444);
  }
  fs.chmodSync(directory, 0o555);
}

// A2.1 M1 and A2.2 E1: the agent payload (supervisor, probe, relay, the skill copy made by the snapshot, run.json, the agent command file,
// /etc/hosts and /etc/resolv.conf) and the egress payload (sidecar, accounting, provider profile, egress.json, optional ca.pem), both in
// the staging directory and read-only. sidecarProgram (test seam deps.sidecarProgram) replaces proxy.mjs.
export function stagePayloads({ plan, prepared, options, sidecarProgram = null }) {
  const agentDir = path.join(prepared.staging.dir, 'agent-payload');
  const egressDir = path.join(prepared.staging.dir, 'egress-payload');
  fs.chmodSync(agentDir, 0o700);
  for (const relative of AGENT_PROGRAMS) writeNew(path.join(agentDir, relative), readSource(path.join(LAUNCHER_ROOT, relative)));
  for (const [relative, text] of Object.entries(plan.payload_files.agent)) writeNew(path.join(agentDir, relative), text);
  fs.mkdirSync(egressDir, { mode: 0o700 });
  for (const relative of EGRESS_PROGRAMS) {
    const from = relative === 'container/proxy.mjs' && sidecarProgram !== null ? sidecarProgram : path.join(LAUNCHER_ROOT, relative);
    writeNew(path.join(egressDir, relative), readSource(from));
  }
  const providerId = JSON.parse(plan.payload_files.egress['egress.json']).provider.id;
  writeNew(path.join(egressDir, 'providers', `${providerId}.mjs`), readSource(path.join(LAUNCHER_ROOT, 'providers', `${providerId}.mjs`)));
  for (const [relative, text] of Object.entries(plan.payload_files.egress)) writeNew(path.join(egressDir, relative), text);
  if (options.extraCaCert !== null) writeNew(path.join(egressDir, 'ca.pem'), readSource(options.extraCaCert));
  for (const dir of [path.join(agentDir, 'container'), path.join(agentDir, 'etc'), egressDir]) makeReadOnly(dir);
  for (const name of ['run.json', 'agent-command.json']) fs.chmodSync(path.join(agentDir, name), 0o444);
  fs.chmodSync(agentDir, 0o555);
  return { agent: agentDir, egress: egressDir };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The gate checks H1 to H4 and U1, U2 (A3.6), as pure functions over `inspect` answers and events. Each returns {result, detail}.

const ok = () => ({ result: 'pass', detail: null });
const bad = detail => ({ result: 'fail', detail });
export const CHECK_IDS = ['H1', 'H2', 'H3', 'H4', 'U1', 'U2', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === new Set(a).size && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// The planned tmpfs options by target, read from the create arguments.
function tmpfsOptions(createArgs) {
  const options = {};
  createArgs.forEach((item, index) => { if (item === '--tmpfs') { const value = createArgs[index + 1]; options[value.slice(0, value.indexOf(':'))] = value.slice(value.indexOf(':') + 1); } });
  return options;
}

const HOST_MNT = '/host_mnt';
// Docker Desktop reports the two single-file binds over /etc/hosts and /etc/resolv.conf with its VM prefix /host_mnt before the host path
// (r35 deviation 8). The prefix is removed there only; every other source is compared exactly as reported (F-38-08).
const HOST_MNT_TARGETS = ['/etc/hosts', '/etc/resolv.conf'];
const MOUNT_KINDS = ['bind', 'volume', 'tmpfs'];

// The mounts of an inspected container in the shape of A9 (kind, source, target, mode), tmpfs options kept for H2. A mount whose type is
// not one of the three, or whose read-write flag is not a boolean, is marked `unknown` (it fails H2 and H3) and recorded as a read-write
// bind: a mount is never read as read-only without the runtime saying so.
export function inspectedMounts(info, container, planMounts = []) {
  const out = [];
  for (const mount of Array.isArray(info?.Mounts) ? info.Mounts : []) {
    const known = MOUNT_KINDS.includes(mount.Type) && typeof mount.RW === 'boolean';
    const kind = MOUNT_KINDS.includes(mount.Type) ? mount.Type : 'bind';
    const target = mount.Destination;
    const planned = planMounts.find(entry => entry.container === container && entry.target === target);
    const prefixed = HOST_MNT_TARGETS.includes(target) && typeof mount.Source === 'string' && mount.Source.startsWith(`${HOST_MNT}/`);
    const source = kind === 'volume' ? (mount.Name ?? null) : prefixed ? mount.Source.slice(HOST_MNT.length) : (mount.Source ?? null);
    out.push({
      container, target, source, kind, mode: mount.RW === false ? 'ro' : 'rw', persistent: kind === 'bind', role: planned?.role ?? (kind === 'volume' ? 'socket' : 'payload'),
      options: kind === 'tmpfs' ? null : undefined, unknown: !known,
    });
  }
  for (const [target, options] of Object.entries(info?.HostConfig?.Tmpfs ?? {})) {
    out.push({ container, target, source: null, kind: 'tmpfs', mode: 'rw', persistent: false, role: 'work', options: typeof options === 'string' && options !== '' ? options : null, unknown: false });
  }
  return out;
}

// The inspected mounts in the order of the plan (inspect lists them in its own order); a mount the plan does not name comes last. The
// record's mount_summary compares its lists with the plan's in order (A9).
function inPlanOrder(mounts, planMounts) {
  const at = mount => { const index = planMounts.findIndex(entry => entry.container === mount.container && entry.target === mount.target); return index < 0 ? planMounts.length : index; };
  return mounts.map((mount, index) => ({ mount, index })).sort((a, b) => at(a.mount) - at(b.mount) || a.index - b.index).map(entry => entry.mount);
}

function sameMounts(info, plan, container) {
  const planned = plan.mounts.filter(mount => mount.container === container);
  const options = tmpfsOptions(container === 'agent' ? plan.agent.create : plan.egress.create);
  const key = mount => JSON.stringify([mount.target, mount.kind, mount.kind === 'tmpfs' ? null : mount.source, mount.mode, mount.kind === 'tmpfs' ? mount.options : null]);
  const inspected = inspectedMounts(info, container, plan.mounts);
  if (inspected.some(mount => mount.unknown)) return false;
  const seen = inspected.map(key).sort();
  const wanted = planned.map(mount => key({ ...mount, options: options[mount.target] })).sort();
  return JSON.stringify(seen) === JSON.stringify(wanted);
}

// The hardening both containers share (A2.1, A2.2): read-only root, all capabilities dropped, no-new-privileges and no seccomp setting,
// not privileged, no host namespace, no device, no published port, log driver none.
function hardening(info) {
  const host = info.HostConfig ?? {};
  const security = Array.isArray(host.SecurityOpt) ? host.SecurityOpt : [];
  if (host.ReadonlyRootfs !== true) return 'root_writable';
  if (!sameSet(host.CapDrop ?? [], ['ALL']) || (host.CapAdd ?? []).length > 0) return 'capabilities';
  if (security.some(option => /seccomp|unconfined/i.test(option))) return 'seccomp_option';
  if (!sameSet(security, ['no-new-privileges'])) return 'security_options';
  if (host.Privileged !== false) return 'privileged';
  if (host.PidMode === 'host' || host.IpcMode === 'host' || host.UTSMode === 'host' || (host.UsernsMode === 'host')) return 'host_namespace';
  if ((host.Devices ?? []).length > 0 || (host.DeviceRequests ?? []).length > 0) return 'device';
  if (Object.keys(host.PortBindings ?? {}).length > 0 || host.PublishAllPorts === true) return 'published_port';
  if (host.LogConfig?.Type !== 'none') return 'log_driver';
  if ((host.VolumesFrom ?? []).length > 0) return 'volumes_from';
  return null;
}

const userOf = ids => `${ids.uid}:${ids.gid}`;

export function checkH1(info) {
  if (info === null) return bad('inspect_failed');
  return info.HostConfig?.NetworkMode === 'none' && sameSet(Object.keys(info.Networks ?? {}), ['none']) ? ok() : bad('network');
}

export function checkH2(info, plan, ids) {
  if (info === null) return bad('inspect_failed');
  if (!sameMounts(info, plan, 'agent')) return bad('mounts');
  const problem = hardening(info);
  if (problem !== null) return bad(problem);
  if (info.Config?.User !== userOf(ids)) return bad('user');
  if (JSON.stringify(info.Config?.Entrypoint) !== '["node"]' || JSON.stringify(info.Config?.Cmd) !== '["/acoder/container/entry.mjs"]') return bad('entry_point');
  if (!sameSet(info.Config?.EnvNames, plan.agent.env_names)) return bad('env_names');
  if (info.HostConfig?.PidsLimit !== 512) return bad('pids_limit');
  return ok();
}

export function checkH3(info, plan, ids, network) {
  if (info === null) return bad('inspect_failed');
  if (info.HostConfig?.NetworkMode !== network || !sameSet(Object.keys(info.Networks ?? {}), [network])) return bad('network');
  if (!sameMounts(info, plan, 'egress')) return bad('mounts');
  const problem = hardening(info);
  if (problem !== null) return bad(problem);
  if (info.Config?.User !== userOf(ids)) return bad('user');
  if (JSON.stringify(info.Config?.Entrypoint) !== '["node"]' || JSON.stringify(info.Config?.Cmd) !== '["/acoder/container/proxy.mjs"]') return bad('entry_point');
  if (!sameSet(info.Config?.EnvNames, plan.egress.env_names)) return bad('env_names');
  if (info.HostConfig?.PidsLimit !== 128) return bad('pids_limit');
  return ok();
}

// H4: the planned volume (driver, options, label); EXT carries the run label and has no container but the sidecar. An EXT given by the test
// seam deps.egressNetwork is not the launcher's, so only its attachment is checked (detail egress_network_injected is recorded by the caller).
export function checkH4(volume, network, plan, { networkCreated, sidecarId }) {
  if (volume === null) return bad('volume_missing');
  const uidgid = /uid=(\d+),gid=(\d+)/.exec(plan.volume.create.join(' '));
  const wanted = { device: 'tmpfs', o: `size=1m,uid=${uidgid?.[1]},gid=${uidgid?.[2]},mode=0750`, type: 'tmpfs' };
  if (volume.Driver !== 'local' || JSON.stringify(Object.fromEntries(Object.entries(volume.Options ?? {}).sort())) !== JSON.stringify(wanted)) return bad('volume_options');
  if (volume.Labels?.['acoder.run'] !== plan.run_id) return bad('volume_label');
  if (network === null) return bad('network_missing');
  if (networkCreated && network.Labels?.['acoder.run'] !== plan.run_id) return bad('network_label');
  const others = Object.keys(network.Containers ?? {}).filter(id => id !== sidecarId);
  if (networkCreated && others.length > 0) return bad('network_shared');
  return ok();
}

// A8.3: the injected names a check observed besides the plan, as one fixed code of the record: injected:<names sorted, comma-joined>, or
// injected:none. Only names of the runtime's allowance get here (anything else has already failed the check), never a value.
const injectedCode = names => `injected:${names.length === 0 ? 'none' : [...names].sort().join(',')}`;

// U1 (with D-R32): the ready event's configuration hash and variable names, the phase from the first probe answer (the first local request
// event: phase probe), and both clock samples inside their brackets (A3.6: bracket 0 to 10000 ms, sample within it widened by 1000 ms). A
// pass records the injected names the sidecar showed (A8.3).
export function checkU1({ ready, readyCount, firstLocal, clocks }, { configSha256, envNames, allowance }) {
  if (readyCount !== 1 || ready === null) return bad('ready_missing');
  if (ready.config_sha256 !== configSha256) return bad('config_hash');
  const allowed = new Set([...envNames, ...allowance]);
  if (!envNames.every(name => ready.env_names.includes(name)) || !ready.env_names.every(name => allowed.has(name))) return bad('env_names');
  if (firstLocal === null || firstLocal.phase !== 'probe') return bad('phase');
  for (const clock of clocks) {
    if (clock === null || clock.sample === null) return bad('clock_protocol');
    const length = clock.end - clock.start;
    if (length < 0 || length > 10000 || clock.sample < clock.start - 1000 || clock.sample > clock.end + 1000) return bad('clock_skew');
  }
  return { result: 'pass', detail: injectedCode(ready.env_names.filter(name => !envNames.includes(name))) };
}

// A8.3: P8's pass carries the injected names as a code of the event protocol (fixed lower-case codes only): injected_<names in lower case,
// sorted, joined by _> or injected_none. The record holds them as injected:<names> of this runtime's allowance; a code that names anything
// else, a name twice or out of order is a protocol failure. A failed P8 is kept as it is.
export function p8Record(entry, allowance) {
  if (entry.result !== 'pass') return { result: entry.result, detail: entry.detail };
  const match = /^injected_([a-z]+(?:_[a-z]+)*)$/.exec(entry.detail ?? '');
  if (match === null) return bad('protocol');
  if (match[1] === 'none') return { result: 'pass', detail: injectedCode([]) };
  const byCode = new Map(allowance.map(name => [name.toLowerCase(), name]));
  const parts = match[1].split('_');
  const names = parts.map(part => byCode.get(part));
  const ordered = parts.every((part, index) => index === 0 || parts[index - 1] < part);
  return names.every(name => name !== undefined) && ordered ? { result: 'pass', detail: injectedCode(names) } : bad('protocol');
}

export function checkU2(upstreams, host) {
  if (upstreams.length !== 1) return bad(upstreams.length === 0 ? 'upstream_missing' : 'upstream_duplicate');
  const [event] = upstreams;
  return event.host === host && event.handshake === 'ok' && event.address !== null ? ok() : bad('handshake');
}

// P4 and P5 are corroborated by the sidecar's own request events (A3.6): the probe value, phase probe, the decisions and reasons, and no
// forwarded request at all.
export function corroborate(results, requests, nonce) {
  const mine = requests.filter(event => event.probe === nonce && event.phase === 'probe');
  const has = (decision, reason) => mine.some(event => event.decision === decision && event.reason === reason);
  const forwarded = requests.some(event => event.decision === 'forwarded');
  return results.map(entry => {
    if (entry.result !== 'pass') return entry;
    if (entry.id === 'P4' && !(has('refused', 'acoder_host_not_allowed') && has('refused', 'acoder_path_not_allowed'))) return { ...entry, result: 'fail', detail: 'not_corroborated' };
    if (entry.id === 'P5' && (forwarded || !(mine.some(event => event.decision === 'local' && event.status === 200) && has('refused', 'acoder_not_released')))) return { ...entry, result: 'fail', detail: 'not_corroborated' };
    return entry;
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The run sequence (A6.6): V validate (runtime, image), S snapshot, E2 mailbox effects, E3 runtime resources, G gate, R release, A agent
// runs, T stop, C scan and evaluate, F finalize. Test seams (deps; none is reachable from a flag, an environment variable or a file):
// adapters, providers, home, runtime (a function that wraps the runtime wrapper), planTransform, egressNetwork, hooks {afterSnapshot,
// beforeRelease, afterStop}, sidecarProgram, clock {now, gateMs}. SIGINT and SIGTERM are handled while a run is in progress (A6.8).

export const GATE_MS = 90000;
const RELEASE_LEAD_MS = 5000;
const SUMMARY_WAIT_MS = 10000;
const STOP_GRACE_SECONDS = 10;
const CLOCK_WAIT_MS = 10000;
const KEY_ENV = 'ACODER_UPSTREAM_KEY';
const STAGING_ATTEMPTS = 30;
const STAGING_RETRY_MS = 500;
// `review cleanup` runs right after the containers of a killed launcher ended by themselves: a longer bound for the same release.
const CLEANUP_STAGING_ATTEMPTS = 120;
const INTERRUPTS = ['SIGINT', 'SIGTERM'];
// The supervisor's deadline event counts as the wall clock only when the launcher's own clock agrees within this margin (clock samples may
// differ by 1000 ms, A3.6); a prefixed line after the release is only a hint (A3.5).
const DEADLINE_MARGIN_MS = 2000;
const EGRESS_LOG_MAX = 10000;
const FACT_BOUNDS = { maxEntries: 200000, maxDepth: 64 };

// One state boundary failure: `state` is the A6.6 state that failed; `detail` the error detail of a not-started record.
class Boundary extends Error {
  constructor(state, detail, cause = null) {
    super(`${state}: ${detail}`);
    this.state = state;
    this.detail = detail;
    this.cause = cause;
  }
}

// A notifier: until(predicate, ms) resolves true once the predicate holds after a notify, false when ms passed first.
function notifier() {
  const waiting = new Set();
  return {
    notify: () => { for (const check of [...waiting]) check(); },
    until: (predicate, ms) => new Promise(resolve => {
      if (predicate()) { resolve(true); return; }
      const check = () => { if (predicate()) { waiting.delete(check); clearTimeout(timer); resolve(true); } };
      const timer = setTimeout(() => { waiting.delete(check); resolve(predicate()); }, Math.max(0, ms));
      waiting.add(check);
    }),
  };
}

// A bounded wait whose timer ends with it: a timer left running would keep the launcher process alive after its result (F-38-10).
function within(promise, ms, fallback = undefined) {
  let timer;
  const late = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// The lines of a stream, one call per complete line.
function eachLine(stream, onLine) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', text => {
    pending += text;
    for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
      onLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  });
  stream.on('end', () => { if (pending !== '') onLine(pending); pending = ''; });
}

// An attached container: its standard input is the control channel, its standard output the event lines (A3.5).
function attachTo(runtime, name, { onLine, onError, changed }) {
  const child = runtime.attach(name);
  const state = { exit: null };
  eachLine(child.stdout, onLine);
  eachLine(child.stderr, onError);
  child.stdin.on('error', () => {});
  const exited = new Promise(resolve => {
    child.on('error', () => { state.exit ??= { code: null, signal: null }; changed(); resolve(state.exit); });
    child.on('close', (code, signal) => { state.exit ??= { code, signal }; changed(); resolve(state.exit); });
  });
  return {
    child, exited, state,
    write: line => { if (child.stdin.writable) child.stdin.write(`${line}\n`); },
    end: () => { try { child.stdin.end(); } catch { /* closed */ } },
  };
}

function withoutKey(env, keyName) {
  const copy = { ...env };
  delete copy[keyName];
  delete copy[KEY_ENV];
  return copy;
}

const nowIso = ms => new Date(ms).toISOString();
const hex = bytes => randomBytes(bytes).toString('hex');

function lstatOrNull(file) { try { return fs.lstatSync(file); } catch { return null; } }

// A9 reports: regular files read with no-follow, at most the scan's report bound (A8.6, F-38-09). A report over the bound, or one that
// cannot be opened or read, is recorded by its size only (no hash, it does not parse): it is never read into memory. io and maxBytes are
// test seams (the file system functions used, the bound).
export function reportFacts(writable, tag, { io = fs, maxBytes = SCAN_BOUNDS.reportMaxBytes } = {}) {
  const read = file => {
    let info;
    try { info = io.lstatSync(file); } catch { info = null; }
    if (info === null || !info.isFile()) return { exists: false, bytes: 0, sha256: null, text: null };
    const unread = bytes => ({ exists: true, bytes, sha256: null, text: null });
    let fd;
    try { fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return unread(info.size); }
    try {
      const opened = io.fstatSync(fd);
      if (!opened.isFile() || opened.size > maxBytes) return unread(opened.size);
      // One byte more than the bound: a file that grew past it since the stat is still not read whole.
      const buffer = Buffer.alloc(opened.size + 1);
      let length = 0;
      for (let got = -1; got !== 0 && length < buffer.length;) {
        got = io.readSync(fd, buffer, length, buffer.length - length, null);
        length += got;
      }
      if (length > maxBytes || length > opened.size) return unread(Math.max(length, opened.size));
      const data = buffer.subarray(0, length);
      return { exists: true, bytes: length, sha256: createHash('sha256').update(data).digest('hex'), text: data.toString('utf8') };
    } catch { return unread(info.size); } finally { io.closeSync(fd); }
  };
  const md = read(writable.reportMd);
  const json = read(writable.reportJson);
  let parsed = null;
  try { parsed = json.text === null ? null : JSON.parse(json.text); } catch { parsed = null; }
  const parses = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  return {
    md: { path: writable.reportMd, exists: md.exists, bytes: md.bytes, sha256: md.sha256 },
    json: { path: writable.reportJson, exists: json.exists, bytes: json.bytes, sha256: json.sha256, parses, session_matches: parses && parsed.session === tag },
  };
}

// The snapshot of the inputs (A6.6 C): the copy of the mailbox and of every export, hashed before the agent starts and again after the stop.
function inputsHash(prepared) {
  return [prepared.staging.mailbox, ...Object.values(prepared.exports).map(entry => entry.copy)].map(dir => canonicalHash(dir)).join(':');
}

// A6.8: SIGINT and SIGTERM are taken over while the run is in progress (the launcher then stops, scans and records instead of dying).
export async function runReview(input, deps = {}) {
  const changed = notifier();
  const interrupt = { signal: null };
  const handlers = INTERRUPTS.map(signal => [signal, () => { interrupt.signal ??= signal; changed.notify(); }]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try { return await launch(input, deps, { changed, interrupt }); } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

async function launch({ options, settings, env }, deps, { changed, interrupt }) {
  const adapters = deps.adapters;
  const providers = deps.providers;
  const now = deps.clock?.now ?? Date.now;
  const gateMs = deps.clock?.gateMs ?? GATE_MS;
  const hooks = deps.hooks ?? {};
  const transform = deps.planTransform ?? (plan => plan);
  const launched = now();
  const started = process.hrtime.bigint();
  const elapsedSeconds = () => Number(process.hrtime.bigint() - started) / 1e9;
  // Every wait ends early on an interrupt; halt(state) then ends the attempt at that state (A6.8).
  const until = (predicate, ms) => changed.until(() => interrupt.signal !== null || predicate(), ms);
  const halt = state => { if (interrupt.signal !== null) throw new Boundary(state, 'interrupted'); };
  const refuseInterrupted = () => { if (interrupt.signal !== null) throw new Refusal('the launch was interrupted before any effect'); };

  // V: the runtime and the image (A10.3, A8.4). The run id labels every resource from here on.
  const runId = makeRunId();
  const hostEnv = withoutKey(env, options.apiKeyEnv);
  let runtime = createRuntime({ ...findRuntime(options.runtime, hostEnv), env: hostEnv, runId });
  if (typeof deps.runtime === 'function') runtime = deps.runtime(runtime);
  const checked = await checkImageAndRuntime(options, runtime);
  refuseInterrupted();

  // S: staging, snapshot and verification (refusals remove the staging directory themselves).
  const prepared = prepare(options, env, { home: deps.home, afterSnapshot: hooks.afterSnapshot });
  if (interrupt.signal !== null) { prepared.cleanup(); refuseInterrupted(); }
  const { tag } = prepared;
  const writable = { ...prepared.writable, startedRecord: path.join(prepared.writable.stage, `run-${prepared.tag}.started.json`) };
  const key = env[options.apiKeyEnv];
  const redactor = createRedactor(key);
  const ids = { uid: process.getuid(), gid: process.getgid() };
  const names = { agent: `acoder-agent-${runId}`, egress: `acoder-sidecar-${runId}`, volume: `acoder-egress-${runId}`, network: deps.egressNetwork ?? `acoder-ext-${runId}` };

  const ctx = {
    runId, tag, prepared, checked, plan: null, basePlan: null, checks: Object.fromEntries(CHECK_IDS.map(id => [id, { result: 'not_run', detail: 'not_reached' }])),
    mounts: [], requests: [], sidecarEvents: [], supervisorEvents: [], summary: null, created: { volume: false, network: false, egress: false, agent: false },
    agentStarted: false, released: null, startedFile: false, logRedactions: 0, conditions: new Set(), budgetKinds: [], agentExit: { code: null, signal: null, outcome: null },
    reportInodes: {}, parser: adapters[settings.agent].createParser(), limited: false, stopping: false, inputsHash: null,
  };
  // A6.5: budget_kind is the first limit, by the order in which the launcher learned of it.
  const learn = kind => { if (!ctx.budgetKinds.includes(kind)) ctx.budgetKinds.push(kind); };
  let log = null;
  const logLine = (source, line) => {
    if (log === null) return;
    const { text, count } = redactor.redactString(`${nowIso(now())} ${source} ${line}\n`);
    ctx.logRedactions += count;
    try { fs.writeSync(log, text); } catch { /* the log is best effort; the record says what happened */ }
  };
  const closeLog = () => { if (log !== null) { fs.closeSync(log); log = null; } };

  let sidecar = null;
  let supervisor = null;
  try {
    // E2: the mailbox effects (A2.3.4) and the log. The log's path is known before any effect: when an exclusive creation fails part way
    // (a report file already exists), the log and the not-started record are still written beside it (A6.6, F-38-02); what exists is
    // never overwritten or removed.
    ctx.logPath = recordNames({ stageDir: writable.stage, tag, runId, started: false }).log;
    const openLog = () => fs.openSync(ctx.logPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.mkdirSync(writable.scratch, { mode: 0o700 });
      for (const [label, file] of [['md', writable.reportMd], ['json', writable.reportJson]]) {
        fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
        const info = fs.lstatSync(file);
        if (!info.isFile() || info.nlink !== 1) throw new Error('a report file is not a new regular file');
        ctx.reportInodes[label] = info.ino;
      }
      log = openLog();
    } catch (error) {
      if (log === null) { try { log = openLog(); } catch { /* the stage folder takes no log; the record is attempted and its failure reported */ } }
      throw new Boundary('E2', 'runtime_failure', error);
    }
    logLine('launcher', `run ${runId} tag ${tag}`);

    // E3: payloads, volume, network EXT, the sidecar (created, checked by H3 and H4, started), the agent container (created, checked by H1, H2).
    const eventPrefix = hex(16);
    const nonce = hex(16);
    const planArgs = { options, settings, prepared, adapters, providers, image: checked.image, runtimeName: runtime.name, runId, eventPrefix, nonce, uid: ids.uid, gid: ids.gid };
    const gateEnds = () => Math.max(0, ctx.gateDeadline - now());
    try {
      ctx.basePlan = planFor(planArgs);
      ctx.plan = transform(structuredClone(ctx.basePlan));
      stagePayloads({ plan: ctx.plan, prepared, options, sidecarProgram: deps.sidecarProgram ?? null });
      // A9 (F-38-01): the payload and skill hashes, taken once from the trees just staged (the trees the containers mount); every record
      // of this attempt carries these values, also after the staging directory is gone.
      ctx.launcher = Object.freeze(launcherSection({
        version: LAUNCHER_VERSION, agentPayload: path.join(prepared.staging.dir, 'agent-payload'), egressPayload: path.join(prepared.staging.dir, 'egress-payload'), skill: prepared.staging.skill,
      }));
      ctx.inputsHash = inputsHash(prepared);
      const must = async (args, extra = {}) => {
        const result = await runtime.call(args, extra);
        if (result.code !== 0) throw new Error(`the runtime refused ${args.slice(0, 2).join(' ')}`);
        return result;
      };
      await must(ctx.plan.volume.create);
      ctx.created.volume = true;
      halt('E3');
      if (deps.egressNetwork === undefined) { await must(ctx.plan.network.create); ctx.created.network = true; }
      halt('E3');
      const egressCreate = deps.egressNetwork === undefined ? ctx.plan.egress.create : ctx.plan.egress.create.map(item => (item === ctx.plan.network.name ? deps.egressNetwork : item));
      const sidecarId = (await must(egressCreate, { extraEnv: { [KEY_ENV]: key } })).stdout.trim();
      ctx.created.egress = true;
      halt('E3');
      const egressInfo = await runtime.inspect('container', names.egress);
      ctx.mounts.push(...inspectedMounts(egressInfo, 'egress', ctx.basePlan.mounts));
      ctx.checks.H3 = checkH3(egressInfo, deps.egressNetwork === undefined ? ctx.basePlan : { ...ctx.basePlan }, ids, names.network);
      ctx.checks.H4 = checkH4(await runtime.inspect('volume', names.volume), await runtime.inspect('network', names.network), ctx.basePlan, { networkCreated: ctx.created.network, sidecarId });
      if (ctx.checks.H3.result !== 'pass' || ctx.checks.H4.result !== 'pass') throw new Boundary('G', 'gate_failed');

      ctx.gateDeadline = now() + gateMs;
      sidecar = attachTo(runtime, names.egress, {
        changed: changed.notify,
        onError: line => logLine('sidecar-stderr', line),
        onLine: line => {
          logLine('sidecar', line);
          const parsed = parseEventLine('sidecar', line, { allowlist: ctx.plan.allowlist });
          if (!parsed.ok) { ctx.sidecarInvalid = true; changed.notify(); return; }
          ctx.sidecarEvents.push(parsed.event);
          if (parsed.event.event === 'request') ctx.requests.push(parsed.event);
          if (parsed.event.event === 'summary') ctx.summary = parsed.event;
          if (parsed.event.event === 'fatal') ctx.sidecarFatal = true;
          if (parsed.event.event === 'limit') {
            // A6.4: usage_unreported is an error condition, the other kinds are budgets; either way the launcher stops the run.
            if (parsed.event.kind === 'usage_unreported') ctx.conditions.add('usage_unreported');
            else learn(parsed.event.kind);
            ctx.limited = true;
          }
          changed.notify();
        },
      });
      const sidecarOf = kind => ctx.sidecarEvents.filter(event => event.event === kind);
      await until(() => sidecarOf('ready').length > 0 && sidecarOf('upstream').length > 0, gateEnds());
      halt('E3');
      const upstream = sidecarOf('upstream')[0] ?? null;
      const running = await runtime.inspect('container', names.egress);
      const sidecarAddress = running?.Networks?.[names.network]?.IPAddress ?? null;
      const network = await runtime.inspect('network', names.network);
      const gateway = network?.IPAM?.Config?.find(entry => typeof entry?.Gateway === 'string')?.Gateway ?? null;
      const p6 = [
        ...(upstream?.address ? [{ address: upstream.address, port: 443 }] : []),
        ...[gateway, sidecarAddress].filter(address => typeof address === 'string' && address !== '').flatMap(address => [53, 80, 443].map(port => ({ address, port }))),
      ];
      ctx.basePlan = planFor({ ...planArgs, p6 });
      ctx.plan = transform(structuredClone(ctx.basePlan));
      await must(ctx.plan.agent.create);
      ctx.created.agent = true;
      halt('E3');
      const agentInfo = await runtime.inspect('container', names.agent);
      ctx.mounts.unshift(...inspectedMounts(agentInfo, 'agent', ctx.basePlan.mounts));
      ctx.checks.H1 = checkH1(agentInfo);
      ctx.checks.H2 = checkH2(agentInfo, ctx.basePlan, ids);
      if (ctx.checks.H1.result !== 'pass' || ctx.checks.H2.result !== 'pass') throw new Boundary('G', 'gate_failed');
    } catch (error) {
      if (error instanceof Boundary) throw error;
      throw new Boundary('E3', 'runtime_failure', error);
    }

    // G: the agent container's supervisor runs the probes; the launcher corroborates them and brackets one clock sample of each container.
    supervisor = attachTo(runtime, names.agent, {
      changed: changed.notify,
      onError: line => logLine('agent-stderr', line),
      onLine: line => {
        const parsed = parseSupervisorLine(line, { prefix: eventPrefix, agentStarted: ctx.agentStarted });
        if (parsed.kind === 'event') {
          logLine('supervisor', JSON.stringify(parsed.event));
          ctx.supervisorEvents.push(parsed.event);
          if (parsed.event.event === 'agent_started') ctx.agentStarted = true;
        } else if (parsed.kind === 'invalid') { logLine('supervisor', 'invalid event line'); ctx.supervisorInvalid = true; }
        else { logLine('agent', line); if (ctx.agentStarted) ctx.parser.push(line); }
        changed.notify();
      },
    });
    const sup = kind => ctx.supervisorEvents.filter(event => event.event === kind);
    const side = kind => ctx.sidecarEvents.filter(event => event.event === kind);
    // The supervisor's probes make four requests; their events are awaited whatever they say (corroborate() matches them to the nonce).
    await until(() => sup('probes').length > 0 && side('ready').length > 0 && side('upstream').length > 0 && ctx.requests.length >= 4, gateEnds());
    halt('G');
    const clocks = [];
    for (const [channel, events] of [[sidecar, side], [supervisor, sup]]) {
      if (now() >= ctx.gateDeadline || channel.state.exit !== null) { clocks.push(null); continue; }
      const start = now();
      channel.write('CLOCK');
      const got = await until(() => events('clock').length > 0, Math.min(CLOCK_WAIT_MS, gateEnds()));
      const end = now();
      clocks.push(got && events('clock').length === 1 ? { start, end, sample: events('clock')[0].clock_epoch_ms } : null);
    }
    // A late, duplicated or malformed event fails its check (A3.6).
    await until(() => false, 200);
    halt('G');
    const inTime = now() <= ctx.gateDeadline;
    const firstLocal = ctx.requests.find(event => event.decision === 'local') ?? null;
    ctx.checks.U1 = !inTime || ctx.sidecarInvalid ? bad('protocol') : checkU1(
      { ready: side('ready')[0] ?? null, readyCount: side('ready').length, firstLocal, clocks: side('clock').length > 1 || sup('clock').length > 1 ? [null] : clocks },
      { configSha256: createHash('sha256').update(ctx.plan.payload_files.egress['egress.json']).digest('hex'), envNames: ctx.basePlan.egress.env_names, allowance: INJECTED_ENV[runtime.name] },
    );
    ctx.checks.U2 = !inTime ? bad('late') : checkU2(side('upstream'), ctx.basePlan.allowlist[0]);
    const probes = sup('probes');
    const results = probes.length === 1 && !ctx.supervisorInvalid && inTime ? corroborate(probes[0].results, ctx.requests, nonce) : [];
    for (const id of CHECK_IDS.filter(name => name.startsWith('P'))) {
      const found = results.filter(entry => entry.id === id);
      const entry = found.length === 1 ? { result: found[0].result, detail: found[0].detail } : bad(probes.length === 0 ? 'probes_missing' : 'protocol');
      ctx.checks[id] = id === 'P8' && found.length === 1 ? p8Record(entry, INJECTED_ENV[runtime.name]) : entry;
    }
    if (CHECK_IDS.some(id => ctx.checks[id].result !== 'pass')) throw new Boundary('G', 'gate_failed');

    // R: release instant T five seconds ahead; one absolute deadline; PHASE agent acknowledged, the started file, then RELEASE at T.
    const releaseAt = now() + RELEASE_LEAD_MS;
    const deadline = releaseAt + settings.limits.wall_seconds * 1000;
    sidecar.write(`PHASE agent ${deadline}`);
    const phased = await until(() => side('phase').length > 0, releaseAt - now());
    halt('R');
    if (!phased) throw new Boundary('R', 'runtime_failure');
    try {
      const fd = fs.openSync(writable.startedRecord, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
      try {
        fs.writeSync(fd, `${JSON.stringify({
          format: 'acoder-run-started/1', run_id: runId, tag, ticket_sha256: prepared.ticket.sha256, time: nowIso(now()),
          resources: { agent: names.agent, egress: names.egress, volume: names.volume, network: names.network, staging: prepared.staging.dir },
        }, null, 2)}\n`);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      ctx.startedFile = true;
    } catch (error) { throw new Boundary('R', 'runtime_failure', error); }
    await hooks.beforeRelease?.({ runId, names, endAgentInput: () => supervisor.end(), endSidecarInput: () => sidecar.end() });
    halt('R');
    if (now() > releaseAt) throw new Boundary('R', 'runtime_failure');
    await until(() => false, releaseAt - now());
    halt('R');
    supervisor.write(`RELEASE ${runId} ${deadline}`);
    ctx.released = now();
    const releasedMono = process.hrtime.bigint();
    logLine('launcher', 'released');

    // A: the agent runs until it ends, the wall clock fires, a limit is reported, the disk bound is reached, the sidecar ends or fails, or
    // the launcher is interrupted (A6.5, A3.7, A8.6). The disk controller samples from the release on (A8.6).
    const wallMs = settings.limits.wall_seconds * 1000;
    const wallLeft = () => wallMs - Number(process.hrtime.bigint() - releasedMono) / 1e6;
    const disk = createDiskController({
      scratch: writable.scratch, files: [writable.reportMd, writable.reportJson, ctx.logPath], limitBytes: settings.limits.scratch_max_bytes,
      onStop: () => { if (!ctx.stopping) { learn('disk'); ctx.diskStopped = true; changed.notify(); } },
    });
    disk.run().catch(() => { /* a failed sample is not a stop; the post-run scan still runs */ });
    const stopNow = () => supervisor.state.exit !== null || sidecar.state.exit !== null || ctx.limited || ctx.diskStopped === true || interrupt.signal !== null
      || ctx.sidecarInvalid === true || ctx.sidecarFatal === true || wallLeft() <= 0;
    while (!stopNow()) await changed.until(stopNow, Math.max(1, wallLeft()));

    // T: the stop (A6.5, A6.6). A sidecar that failed or ended on its own is a pre-existing failure: A3.7 immediate error stop. Otherwise
    // STOP first, its summary awaited (at most 10 s), and only then the agent container is signalled (10 s grace, then kill).
    ctx.stopping = true;
    disk.stop();
    if (interrupt.signal !== null) ctx.conditions.add('interrupted');
    if (wallLeft() <= 0 || (sup('deadline').length > 0 && wallLeft() <= DEADLINE_MARGIN_MS)) learn('wall_clock');
    const agentRunning = () => supervisor.state.exit === null;
    const signalAgent = async args => {
      const result = await runtime.call(args, { timeoutMs: (STOP_GRACE_SECONDS + 20) * 1000 });
      if (result.code === 0 || !agentRunning()) return;
      ctx.conditions.add('runtime_failure');
      logLine('launcher', `the runtime failed ${args[0]} of the agent container`);
      await runtime.call(['kill', names.agent]);
    };
    if (ctx.sidecarInvalid === true || ctx.sidecarFatal === true) {
      ctx.conditions.add('egress_protocol_error');
      await runtime.call(['kill', names.egress]);
      if (agentRunning()) await signalAgent(['kill', names.agent]);
    } else if (sidecar.state.exit !== null && ctx.summary === null) {
      ctx.conditions.add('egress_sidecar_exited');
      if (agentRunning()) await signalAgent(['kill', names.agent]);
    } else {
      if (ctx.summary === null) {
        sidecar.write('STOP');
        await changed.until(() => ctx.summary !== null || sidecar.state.exit !== null, SUMMARY_WAIT_MS);
      }
      if (ctx.summary === null) { ctx.conditions.add('egress_protocol_error'); await runtime.call(['kill', names.egress]); }
      if (agentRunning()) await signalAgent(['stop', '--time', String(STOP_GRACE_SECONDS), names.agent]);
    }
    const agentExit = await within(supervisor.exited, 30000, { code: null, signal: null });
    await within(sidecar.exited, 15000);
    await hooks.afterStop?.({ runId, names, staging: prepared.staging.dir, snapshot: prepared.staging.mailbox });
    const parsed = ctx.parser.result();
    const code = agentExit.code;
    ctx.agentExit = { code, signal: null, outcome: adapters[settings.agent].outcome({ code, signal: null, parsed }) };
    ctx.advisory = { ...parsed.advisory, counted_by: `adapter:${settings.agent}` };
    ctx.agentStarted = sup('agent_started').length > 0 || ctx.agentStarted;
    return await finishStarted(ctx, { runtime, names, options, settings, writable, redactor, key, now, launched, elapsedSeconds, closeLog });
  } catch (error) {
    const boundary = error instanceof Boundary ? error : new Boundary(ctx.startedFile ? 'R' : 'E3', 'runtime_failure', error);
    if (ctx.startedFile) {
      ctx.conditions.add(boundary.detail === 'interrupted' ? 'interrupted' : 'runtime_failure');
      logLine('launcher', `failure after the started file: ${boundary.detail}`);
      supervisor?.end();
      sidecar?.end();
      return await finishStarted(ctx, { runtime, names, options, settings, writable, redactor, key, now, launched, elapsedSeconds, closeLog });
    }
    logLine('launcher', `not started: ${boundary.state} ${boundary.detail}`);
    supervisor?.end();
    sidecar?.end();
    closeLog();
    return finishNotStarted(ctx, boundary, { runtime, names, options, settings, writable, redactor, now, launched, elapsedSeconds, sidecar, supervisor });
  }
}

const zeroTotals = () => ({ forwarded: 0, refused_probe: 0, refused_agent: 0, refused_by_reason: {}, bytes_up: 0, bytes_down: 0, key_reflections: 0 });
function totalsFrom(ctx) {
  if (ctx.summary !== null) {
    const { forwarded, refused_probe: refusedProbe, refused_agent: refusedAgent, refused_by_reason: byReason, bytes_up: up, bytes_down: down, key_reflections: reflections } = ctx.summary;
    return { forwarded, refused_probe: refusedProbe, refused_agent: refusedAgent, refused_by_reason: { ...byReason }, bytes_up: up, bytes_down: down, key_reflections: reflections };
  }
  const totals = zeroTotals();
  for (const event of ctx.requests) {
    if (event.decision === 'forwarded') totals.forwarded += 1;
    if (event.decision === 'refused') {
      totals[event.phase === 'probe' ? 'refused_probe' : 'refused_agent'] += 1;
      totals.refused_by_reason[event.reason] = (totals.refused_by_reason[event.reason] ?? 0) + 1;
    }
    totals.bytes_up += event.bytes_up;
    totals.bytes_down += event.bytes_down;
  }
  return totals;
}

// A6.7: containers, volume, network, staging; the names that remain.
async function cleanupRun(ctx, runtime, names) {
  const leftovers = await runtime.remove({
    containers: [ctx.created.agent ? names.agent : null, ctx.created.egress ? names.egress : null].filter(Boolean),
    volume: ctx.created.volume ? names.volume : null, network: ctx.created.network ? names.network : null,
  }).catch(() => [names.agent, names.egress, names.volume, names.network]);
  // Docker Desktop releases a nested mount point of the snapshot a moment after the container is gone (ENOTEMPTY until then): the
  // removal is retried for a bounded time, and what still remains is named in the record.
  for (let attempt = 1; ; attempt += 1) {
    try { ctx.prepared.cleanup(); break; } catch {
      if (attempt >= STAGING_ATTEMPTS) { leftovers.push(ctx.prepared.staging.dir); break; }
      await new Promise(resolve => setTimeout(resolve, STAGING_RETRY_MS));
    }
  }
  return leftovers;
}

// A9 egress_log: the request events without their event and probe fields, at most 10000 entries (the totals stay exact).
export function egressLogOf(requests) {
  const log = requests.slice(0, EGRESS_LOG_MAX).map(({ event: unusedEvent, probe: unusedProbe, ...entry }) => entry);
  return { log, truncated: requests.length > EGRESS_LOG_MAX };
}

// A9 inputs.scratch_git_entries and scratch_symlinks_outside: entries named `.git` in any letter case, and links whose target is absolute
// or leaves scratch, found with lstat and readdir only (nothing is followed or opened). complete is false when a bound is reached or an
// entry cannot be read; the counts are then lower bounds.
export function scratchFacts(scratch, bounds = {}) {
  const limits = { ...FACT_BOUNDS, ...bounds };
  const facts = { git_entries: 0, symlinks_outside: 0, complete: true };
  let entries = 0;
  const walk = (directory, depth) => {
    let found;
    try { found = fs.readdirSync(directory); } catch { facts.complete = false; return; }
    if (depth + 1 > limits.maxDepth && found.length > 0) { facts.complete = false; return; }
    for (const name of found) {
      entries += 1;
      if (entries > limits.maxEntries) { facts.complete = false; return; }
      const full = path.join(directory, name);
      const info = lstatOrNull(full);
      if (info === null) continue;
      if (name.toLowerCase() === '.git') facts.git_entries += 1;
      if (info.isSymbolicLink()) {
        let target;
        try { target = fs.readlinkSync(full); } catch { facts.complete = false; continue; }
        const resolved = path.resolve(directory, target);
        if (path.isAbsolute(target) || (resolved !== scratch && !resolved.startsWith(`${scratch}/`))) facts.symlinks_outside += 1;
      } else if (info.isDirectory()) walk(full, depth + 1);
      if (!facts.complete) return;
    }
  };
  walk(scratch, 0);
  return facts;
}

function recordValuesOf(ctx, { options, settings, writable, now, launched, elapsedSeconds, names }) {
  const { prepared, checked } = ctx;
  // An attempt that ended before its payloads were staged mounted nothing: its hashes are all zero.
  const unstaged = '0'.repeat(64);
  const totals = totalsFrom(ctx);
  const egress = egressLogOf(ctx.requests);
  const sections = preparedSections(prepared, options);
  return {
    run_id: ctx.runId, tag: ctx.tag,
    launcher: { ...(ctx.launcher ?? { version: LAUNCHER_VERSION, agent_payload_sha256: unstaged, egress_payload_sha256: unstaged, skill_sha256: unstaged }) },
    agent: { name: settings.agent, cli_version: null, model: settings.model, effort: settings.effort },
    provider: { id: settings.provider, endpoint: settings.endpoint, max_in_flight: settings.limits.max_in_flight },
    ...sections, inputs: { ...sections.inputs, ...(ctx.inputs ?? {}) },
    image: checked.image, runtime: checked.runtime,
    mounts: inPlanOrder(ctx.mounts, ctx.basePlan?.mounts ?? []).map(({ options: unusedOptions, unknown: unusedUnknown, ...mount }) => mount), plan_mounts: ctx.basePlan?.mounts ?? [],
    network: {
      agent_network: 'none', egress_network: names.network, egress_network_created: ctx.created.network, allowlist: ctx.basePlan?.allowlist ?? [endpointParts(settings.endpoint).host],
      extra_ca_cert: options.extraCaCert !== null,
    },
    isolation_checks: CHECK_IDS.map(id => ({ id, ...ctx.checks[id] })),
    egress_log: egress.log, egress_log_truncated: egress.truncated, egress_totals: totals,
    limits: { wall_seconds: settings.limits.wall_seconds, calls: settings.limits.calls, tokens: settings.limits.tokens, scratch_max_bytes: settings.limits.scratch_max_bytes },
    usage: {
      calls_forwarded: totals.forwarded, tokens: ctx.summary?.tokens ?? null, usage_missing: ctx.summary?.usage_missing ?? 0, admitted_after_token_limit: ctx.summary?.admitted_after_token_limit ?? 0,
      in_flight_at_limit: ctx.summary?.in_flight_at_limit ?? null, counted_by: 'egress', advisory: ctx.advisory ?? null,
    },
    times: { launched: nowIso(launched), released: ctx.released === null ? null : nowIso(ctx.released), ended: nowIso(now()), wall_seconds: Math.round(elapsedSeconds() * 1000) / 1000 },
    agent_exit: ctx.agentExit, reports: reportFacts(writable, ctx.tag), scratch_symlinks_outside: ctx.symlinksOutside ?? 0,
  };
}

function removeEmptyReports(ctx, writable, onlyOwn) {
  const leftovers = [];
  for (const [label, file] of [['md', writable.reportMd], ['json', writable.reportJson]]) {
    const info = lstatOrNull(file);
    if (info?.isFile() && info.size === 0 && (!onlyOwn || info.ino === ctx.reportInodes[label])) { try { fs.rmSync(file); } catch { leftovers.push(file); } }
  }
  return leftovers;
}

// A not-started attempt (states E2 to R before the started file): containers and resources removed, empty reports and the empty scratch
// directory removed, the not-started record and log kept (A6.6). Exit code 1, outcome not-started.
async function finishNotStarted(ctx, boundary, { runtime, names, options, settings, writable, redactor, now, launched, elapsedSeconds, sidecar, supervisor }) {
  await within(Promise.all([sidecar?.exited, supervisor?.exited].filter(Boolean)), 15000);
  const leftovers = await cleanupRun(ctx, runtime, names);
  leftovers.push(...removeEmptyReports(ctx, writable, true));
  try { if (lstatOrNull(writable.scratch)?.isDirectory()) fs.rmdirSync(writable.scratch); } catch { leftovers.push(writable.scratch); }
  if (ctx.logPath === undefined) {
    return { outcome: 'not-started', exit_code: 1, record: '-', tag: ctx.tag, run_id: ctx.runId, leftovers, state: boundary.state, detail: boundary.detail };
  }
  const values = {
    ...recordValuesOf(ctx, { options, settings, writable, now, launched, elapsedSeconds, names }),
    agent_started: false, exit_reason: null, budget_kind: null, error_detail: boundary.detail, conditions: [], secret_scan: emptyScan(),
    cleanup: { status: leftovers.length === 0 ? 'complete' : 'incomplete', leftovers }, log_path: ctx.logPath,
  };
  values.reports = reportFacts(writable, ctx.tag);
  values.secret_scan.log_redactions = ctx.logRedactions;
  const file = recordNames({ stageDir: writable.stage, tag: ctx.tag, runId: ctx.runId, started: false }).record;
  const record = buildRecord(values);
  // A stage folder that takes no file: the attempt has no record, and the error names the path that could not be written (F-38-02).
  try { writeRecord(file, record, redactor); } catch (failure) {
    const error = `the not-started record ${file} could not be written (${failure?.code ?? 'failed'})`;
    return { outcome: 'not-started', exit_code: 1, record: '-', tag: ctx.tag, run_id: ctx.runId, leftovers, state: boundary.state, detail: boundary.detail, error };
  }
  return { outcome: 'not-started', exit_code: 1, record: file, tag: ctx.tag, run_id: ctx.runId, leftovers, state: boundary.state, detail: boundary.detail };
}

// A started run: C (the snapshot re-hash while the staging directory exists, cleanup of the runtime resources and the staging directory,
// the secret scan after both containers are gone, the record facts, the reason by precedence) and F (the record, exclusive; A6.6).
async function finishStarted(ctx, { runtime, names, options, settings, writable, redactor, key, now, launched, elapsedSeconds, closeLog }) {
  let unchanged;
  try { unchanged = ctx.inputsHash !== null && inputsHash(ctx.prepared) === ctx.inputsHash; } catch { unchanged = false; }
  if (!unchanged) ctx.conditions.add('input_snapshot_changed');
  if ((ctx.summary?.key_reflections ?? 0) > 0) ctx.conditions.add('secret_found');
  const leftovers = await cleanupRun(ctx, runtime, names);
  leftovers.push(...removeEmptyReports(ctx, writable, false));
  const recordPaths = recordNames({ stageDir: writable.stage, tag: ctx.tag, runId: ctx.runId, started: true });
  closeLog();
  try { fs.renameSync(ctx.logPath, recordPaths.log); } catch { /* the not-started name stays */ }
  const logPath = lstatOrNull(recordPaths.log) === null ? ctx.logPath : recordPaths.log;
  const facts = scratchFacts(writable.scratch);
  const scan = scanTree({ key, scratch: writable.scratch, files: [writable.reportMd, writable.reportJson, logPath] });
  ctx.inputs = { unchanged_at_end: unchanged, scratch_git_entries: facts.git_entries, scratch_git_entries_complete: facts.complete && scan.status !== 'incomplete' };
  ctx.symlinksOutside = facts.symlinks_outside;
  const values = recordValuesOf(ctx, { options, settings, writable, now, launched, elapsedSeconds, names });
  const decision = evaluateRun({
    flags: [...ctx.conditions], budgetKinds: ctx.budgetKinds, tokensLowerBound: (ctx.summary?.usage_missing ?? 0) > 0, scan_status: scan.status,
    agent: ctx.agentStarted ? ctx.agentExit : null, egress_log: values.egress_log, reports: values.reports,
  });
  const record = buildRecord({
    ...values, agent_started: ctx.agentStarted, exit_reason: decision.exit_reason, budget_kind: decision.budget_kind, error_detail: decision.error_detail, conditions: decision.conditions,
    secret_scan: { ...scan.secret_scan, log_redactions: ctx.logRedactions }, cleanup: { status: leftovers.length === 0 ? 'complete' : 'incomplete', leftovers }, log_path: logPath,
  });
  writeRecord(recordPaths.record, record, redactor);
  return { outcome: decision.outcome, exit_code: decision.exit_code, record: recordPaths.record, tag: ctx.tag, run_id: ctx.runId, leftovers };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// `acoder review cleanup --mailbox <dir> --ticket <file>` (A6.9, A1.4): recovery after a killed launcher. It reads the started file (or,
// without one, the run ids of the ticket's not-started files, since the labels hold only the run id), removes the containers, volumes and
// networks labelled with those run ids (listed by the label key and filtered here, A6.9) and the staging directory named in the started
// file (only with its marker), and writes `run-<tag>.crashed.json`. It never starts anything and never makes a started ticket launchable.
const CLEANUP_FLAGS = ['--mailbox', '--ticket'];
const TICKET_FILE = /^ticket-([A-Za-z0-9._-]{1,120})\.md$/;
const RUN_ID_TEXT = '\\d{8}T\\d{6}Z-[0-9a-f]{6}';
const STAGING_MARKER = '.acoder-staging';
const LISTS = [
  ['container', ['ps', '--all', '--filter', 'label=acoder.run', '--format', '{{.Names}}\t{{.Label "acoder.run"}}'], name => ['rm', '--force', name]],
  ['volume', ['volume', 'ls', '--filter', 'label=acoder.run', '--format', '{{.Name}}\t{{.Label "acoder.run"}}'], name => ['volume', 'rm', '--force', name]],
  ['network', ['network', 'ls', '--filter', 'label=acoder.run', '--format', '{{.Name}}\t{{.Label "acoder.run"}}'], name => ['network', 'rm', name]],
];

function parseCleanup(argv) {
  const found = {};
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!CLEANUP_FLAGS.includes(flag)) throw new Refusal(`usage: acoder review cleanup --mailbox <dir> --ticket <file>; unknown argument ${safe(flag)}`);
    if (Object.hasOwn(found, flag)) throw new Refusal(`${flag} is given more than once`);
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Refusal(`${flag} needs an absolute path`);
    found[flag] = path.resolve(value);
  }
  for (const flag of CLEANUP_FLAGS) if (!Object.hasOwn(found, flag)) throw new Refusal(`usage: acoder review cleanup --mailbox <dir> --ticket <file>; ${flag} is missing`);
  const ticket = found['--ticket'];
  const mailbox = found['--mailbox'];
  const tag = TICKET_FILE.exec(path.basename(ticket))?.[1];
  if (tag === undefined) throw new Refusal('--ticket must name a file ticket-<tag>.md');
  if (!ticket.startsWith(`${mailbox}/`)) throw new Refusal('--ticket must lie inside --mailbox');
  return { tag, stage: path.dirname(ticket) };
}

// The started file of this ticket, or null when there is none; anything else in its place is a refusal.
function readStarted(file, tag) {
  const info = lstatOrNull(file);
  if (info === null) return null;
  let started = null;
  try { started = info.isFile() ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { started = null; }
  const valid = started?.format === 'acoder-run-started/1' && started.tag === tag && new RegExp(`^${RUN_ID_TEXT}$`).test(String(started.run_id))
    && typeof started.resources?.staging === 'string' && path.isAbsolute(started.resources.staging);
  if (!valid) throw new Refusal(`the started file ${safe(file)} is not a started file of this ticket`);
  return started;
}

// The staging directory named in the started file is removed only when it carries the launcher's marker (A6.7); the removal is retried
// for a bounded time (60 s), since Docker Desktop releases a nested mount point a moment after the container is gone.
async function removeNamedStaging(dir) {
  const info = lstatOrNull(dir);
  if (info === null) return 'absent';
  const marker = lstatOrNull(path.join(dir, STAGING_MARKER));
  const id = marker?.isFile() ? fs.readFileSync(path.join(dir, STAGING_MARKER), 'utf8').trim() : '';
  if (!info.isDirectory() || !path.basename(dir).startsWith('acoder-staging-') || !/^[0-9a-f]{32}$/.test(id)) return 'kept';
  for (let attempt = 1; ; attempt += 1) {
    try { removeStaging(dir, id); return 'removed'; } catch {
      if (attempt >= CLEANUP_STAGING_ATTEMPTS) return 'kept';
      await new Promise(resolve => setTimeout(resolve, STAGING_RETRY_MS));
    }
  }
}

async function labelledResources(runtime) {
  const out = [];
  for (const [kind, args, removal] of LISTS) {
    const result = await runtime.call(args);
    if (result.code !== 0) throw new Error(`the runtime could not list the labelled ${kind}s`);
    for (const line of result.stdout.split('\n')) {
      const [name, run] = line.trim().split('\t');
      if (name && run) out.push({ kind, name, run, removal: removal(name) });
    }
  }
  return out;
}

export async function reviewCleanup(argv, env, deps = {}, io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const { tag, stage } = parseCleanup(argv);
    const crashedFile = path.join(stage, `run-${tag}.crashed.json`);
    if (lstatOrNull(crashedFile) !== null) throw new Refusal(`${safe(crashedFile)} already exists`);
    const started = readStarted(path.join(stage, `run-${tag}.started.json`), tag);
    const attempt = new RegExp(`^run-${tag.replace(/[.]/g, '\\.')}\\.notstarted-(${RUN_ID_TEXT})\\.(?:json|log)$`);
    const runIds = started !== null ? [started.run_id] : [...new Set(fs.readdirSync(stage).map(name => attempt.exec(name)?.[1]).filter(Boolean))].sort();
    let runtime = createRuntime({ ...findRuntime(null, withoutKey(env, KEY_ENV)), env: withoutKey(env, KEY_ENV), runId: runIds[0] ?? 'cleanup' });
    if (typeof deps.runtime === 'function') runtime = deps.runtime(runtime);
    await runtime.answers();
    const removed = [];
    const leftovers = [];
    const mine = (await labelledResources(runtime)).filter(entry => runIds.includes(entry.run));
    for (const entry of mine) await runtime.call(entry.removal);
    const remaining = new Set((await labelledResources(runtime)).map(entry => entry.name));
    for (const entry of mine) (remaining.has(entry.name) ? leftovers : removed).push(entry.name);
    if (started !== null) {
      const outcome = await removeNamedStaging(started.resources.staging);
      if (outcome === 'removed') removed.push(started.resources.staging);
      if (outcome === 'kept') leftovers.push(started.resources.staging);
    } else {
      for (const file of [path.join(stage, `scratch-${tag}`), path.join(stage, `report-${tag}.md`), path.join(stage, `report-${tag}.json`)]) {
        if (lstatOrNull(file) !== null) io.stdout.write(`owner action: inspect and remove ${safe(file)}\n`);
      }
      io.stdout.write('owner action: the staging directory cannot be located without a started file; inspect the staging parent for acoder-staging-* directories\n');
    }
    const crashed = { format: 'acoder-run-crashed/1', run_id: started?.run_id ?? (runIds.length === 1 ? runIds[0] : null), tag, started: started !== null, removed, time: nowIso(Date.now()) };
    writeNew(crashedFile, `${JSON.stringify(crashed, null, 2)}\n`);
    for (const name of removed) io.stdout.write(`removed: ${safe(name)}\n`);
    for (const name of leftovers) io.stderr.write(`leftover: ${safe(name)}\n`);
    io.stdout.write(`crashed record: ${safe(crashedFile)}\n`);
    return leftovers.length === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof Refusal) { io.stderr.write(`refused: ${error.message}\n`); return 2; }
    io.stderr.write(`error: ${safe(error?.message ?? error)}\n`);
    return 1;
  }
}
