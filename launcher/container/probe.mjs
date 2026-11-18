// The in-container probes P1 to P8 of the gate (A3.6), run by the supervisor before the release. Each probe returns {id, result, detail}
// with a fixed code as detail and never a value (A3.5). Everything the launcher must give comes in ACODER_PROBE_INPUT; the fixed container
// paths are defaults that the unit tests replace. A probe that throws or times out counts as failed. Imports only `node:` modules.
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const pass = id => ({ id, result: 'pass', detail: null });
const fail = (id, detail) => ({ id, result: 'fail', detail });
const PROBE_TIMEOUT_MS = 1000;
const P6_TIMEOUT_MS = 2000;
const DNS_PORT = 53;
const PROBE_NAME = 'acoder-probe.invalid';

// --- P1 (N1): device flags, IPv6 addresses, IPv4 local fib leaves, IPv4 and IPv6 routes, from injected file contents (pure). ---

const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

// The P1 sources under `root` ('/' in the container). devices: null when /sys/class/net cannot be listed; a plain file there
// (bonding_masters) is not a device; a device whose flags file cannot be read has flags null.
export function readP1Sources(root = '/') {
  const netDir = path.join(root, 'sys/class/net');
  let devices = null;
  try {
    devices = fs.readdirSync(netDir).sort()
      .filter(name => !fs.lstatSync(path.join(netDir, name)).isFile())
      .map(name => ({ name, flags: readText(path.join(netDir, name, 'flags')) }));
  } catch { devices = null; }
  const proc = name => readText(path.join(root, 'proc/net', name));
  return { devices, if_inet6: proc('if_inet6'), fib_trie: proc('fib_trie'), route: proc('route'), ipv6_route: proc('ipv6_route') };
}

class Unparseable extends Error {}
const lines = text => text.split('\n').filter(line => line.trim() !== '');
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const isLoopback4 = address => { const match = IPV4.exec(address); return match !== null && match[1] === '127' && match.slice(1).every(part => Number(part) <= 255); };

function upDevices(devices) {
  return devices.filter(({ name, flags }) => {
    if (!/^0x[0-9a-f]+$/i.test(flags.trim())) throw new Unparseable();
    return name !== 'lo' && (Number.parseInt(flags.trim(), 16) & 1) === 1;
  });
}

function badIpv6Addresses(text) {
  return lines(text).filter(line => {
    const match = /^([0-9a-f]{32})\s+[0-9a-f]+\s+[0-9a-f]+\s+[0-9a-f]+\s+[0-9a-f]+\s+(\S+)$/.exec(line.trim());
    if (match === null) throw new Unparseable();
    return match[2] !== 'lo' || match[1] !== `${'0'.repeat(31)}1`;
  });
}

// /proc/net/fib_trie: a LOCAL leaf (`/<len> host LOCAL`) is an address of this namespace; it must lie in 127.0.0.0/8. Other leaves
// (link BROADCAST, UNICAST) are not assigned addresses.
function badIpv4Addresses(text) {
  const found = [];
  let last = null;
  for (const line of lines(text)) {
    const trimmed = line.trim();
    if (/^[A-Za-z][A-Za-z0-9 ]*:$/.test(trimmed)) { last = null; continue; }
    if (/^\+-- \d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}(?: \d+)+$/.test(trimmed)) continue;
    const leaf = /^\|-- (\d{1,3}(?:\.\d{1,3}){3})$/.exec(trimmed);
    if (leaf !== null) { last = leaf[1]; continue; }
    const kind = /^\/(\d{1,2}) ([a-z]+) ([A-Z]+)$/.exec(trimmed);
    if (kind === null || last === null) throw new Unparseable();
    if (kind[3] === 'LOCAL' && !isLoopback4(last)) found.push(last);
  }
  return found;
}

function badIpv4Routes(text) {
  const [header, ...rest] = text.split('\n');
  if (!/^Iface\s+Destination\s+Gateway/.test(header)) throw new Unparseable();
  return rest.filter(line => {
    if (line === '') return false;
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8 || fields[0] === '') throw new Unparseable();
    return fields[0] !== 'lo';
  });
}

function badIpv6Routes(text) {
  return lines(text).filter(line => {
    const match = /^[0-9a-f]{32} [0-9a-f]{2} [0-9a-f]{32} [0-9a-f]{2} [0-9a-f]{32}(?: [0-9a-f]{8}){4}\s+(\S+)$/.exec(line.trim());
    if (match === null) throw new Unparseable();
    return match[1] !== 'lo';
  });
}

// The pure evaluation of P1. Every non-lo device down; IPv6 addresses only ::1 on lo; IPv4 local addresses only 127.0.0.0/8; no route on
// another device; a missing, unreadable or unparseable source fails. Returns {result, detail}.
export function evaluateP1(sources) {
  const { devices, if_inet6: inet6, fib_trie: fib, route, ipv6_route: route6 } = sources ?? {};
  if (!Array.isArray(devices) || devices.length === 0 || devices.some(device => typeof device.flags !== 'string')) return { result: 'fail', detail: 'source_missing' };
  for (const text of [inet6, fib, route, route6]) if (typeof text !== 'string') return { result: 'fail', detail: 'source_missing' };
  try {
    const checks = [
      ['device_up', () => upDevices(devices)], ['ipv6_address', () => badIpv6Addresses(inet6)], ['ipv4_address', () => badIpv4Addresses(fib)],
      ['ipv4_route', () => badIpv4Routes(route)], ['ipv6_route', () => badIpv6Routes(route6)],
    ];
    const found = checks.map(([detail, check]) => [detail, check().length > 0]);
    const first = found.find(([, bad]) => bad);
    return first === undefined ? { result: 'pass', detail: null } : { result: 'fail', detail: first[0] };
  } catch (error) {
    if (error instanceof Unparseable) return { result: 'fail', detail: 'source_unparseable' };
    throw error;
  }
}

export const probeP1 = (root = '/') => ({ id: 'P1', ...evaluateP1(readP1Sources(root)) });

// --- P2 (N4): no DNS answer of any kind and no TCP port 53 on the loopback addresses and the configured name servers; both system lookups fail. ---

export function dnsTargets(resolvText) {
  const servers = (resolvText ?? '').split('\n').map(line => /^\s*nameserver\s+(\S+)\s*$/.exec(line)?.[1]).filter(address => address !== undefined && net.isIP(address) !== 0);
  return [...['127.0.0.1', '::1', '127.0.0.11'], ...servers].map(address => ({ address, port: DNS_PORT }));
}

// A DNS query (type A, class IN) for acoder-probe.invalid.
function dnsQuery() {
  const header = Buffer.from([0x4a, 0x43, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const name = Buffer.concat([...PROBE_NAME.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);
  return Buffer.concat([header, name, Buffer.from([0x00, 0x01, 0x00, 0x01])]);
}

// Resolves true when any datagram comes back within timeoutMs.
function udpAnswers({ address, port }, timeoutMs) {
  return new Promise(resolve => {
    let socket;
    try { socket = dgram.createSocket(net.isIPv6(address) ? 'udp6' : 'udp4'); } catch { resolve(false); return; }
    const done = answered => { clearTimeout(timer); try { socket.close(); } catch { /* closed */ } resolve(answered); };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.on('message', () => done(true));
    socket.on('error', () => done(false));
    socket.send(dnsQuery(), port, address, error => { if (error) done(false); });
  });
}

// Resolves true when a TCP connection is accepted within timeoutMs.
function tcpConnects({ address, port }, timeoutMs) {
  return new Promise(resolve => {
    if (net.isIP(address) === 0) { resolve(false); return; }
    const socket = net.connect({ host: address, port });
    const done = connected => { clearTimeout(timer); socket.destroy(); resolve(connected); };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const systemLookup = name => dns.promises.lookup(name, { all: true });
const resolves = async (lookup, name) => { try { const answer = await lookup(name); return Array.isArray(answer) ? answer.length > 0 : Boolean(answer); } catch { return false; } };

export async function probeP2({ targets, lookup = systemLookup, timeoutMs = PROBE_TIMEOUT_MS }) {
  const udp = await Promise.all(targets.map(target => udpAnswers(target, timeoutMs)));
  if (udp.some(Boolean)) return fail('P2', 'dns_answer');
  const tcp = await Promise.all(targets.map(target => tcpConnects(target, timeoutMs)));
  if (tcp.some(Boolean)) return fail('P2', 'dns_tcp');
  const names = await Promise.all(['example.com', PROBE_NAME].map(name => resolves(lookup, name)));
  if (names.some(Boolean)) return fail('P2', 'name_resolved');
  return pass('P2');
}

// --- P3 (N4): the launcher's /etc files by hash; each allowed name resolves to 127.0.0.1 only. ---

const fileSha = file => { try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } };

export async function probeP3(input, { paths = {}, lookup = systemLookup } = {}) {
  const { hosts = '/etc/hosts', resolv = '/etc/resolv.conf' } = paths;
  if (fileSha(hosts) !== input.hosts_sha256) return fail('P3', 'hosts_changed');
  if (fileSha(resolv) !== input.resolv_sha256) return fail('P3', 'resolv_changed');
  for (const name of input.allowed_names) {
    let answer;
    try { answer = await lookup(name); } catch { return fail('P3', 'allowed_name'); }
    if (!Array.isArray(answer) || answer.length === 0 || answer.some(entry => entry.address !== '127.0.0.1')) return fail('P3', 'allowed_name');
  }
  return pass('P3');
}

// --- P4 and P5 (N2, N3, N5): through the relay, with the probe header the launcher matches against the sidecar's request events. ---

function relayRequest({ relayPort, method, target, host, nonce }) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: relayPort, method, path: target, setHost: false, agent: false, timeout: 5000, headers: { host, 'x-acoder-probe': nonce, 'content-type': 'application/json', connection: 'close' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        resolve({ status: res.statusCode, body });
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(method === 'POST' ? '{}' : undefined);
  });
}
const refusedWith = (answer, status, code) => answer !== null && answer.status === status && answer.body?.error?.code === code;

export async function probeP4P5(input, { relayPort = 8080 } = {}) {
  const [host] = input.allowed_names;
  const request = (method, target, hostHeader) => relayRequest({ relayPort, method, target, host: hostHeader, nonce: input.nonce });
  const otherHost = await request('POST', input.probe_paths.allowed, 'denied.invalid');
  const otherPath = await request('POST', input.probe_paths.denied, `${host}:8080`);
  const p4 = !refusedWith(otherHost, 403, 'acoder_host_not_allowed') ? fail('P4', 'host_not_refused')
    : !refusedWith(otherPath, 403, 'acoder_path_not_allowed') ? fail('P4', 'path_not_refused') : pass('P4');
  const probe = await request('GET', '/__acoder/probe', `${host}:8080`);
  const forwardable = await request('POST', input.probe_paths.allowed, `${host}:8080`);
  const probeOk = probe !== null && probe.status === 200 && probe.body?.run_id === input.run_id && probe.body?.phase === 'probe';
  const p5 = !probeOk ? fail('P5', 'probe_path_failed') : !refusedWith(forwardable, 403, 'acoder_not_released') ? fail('P5', 'released_before_release') : pass('P5');
  return [p4, p5];
}

// --- P6 (N1, N2): no TCP connection to the upstream address, the EXT gateway and the sidecar's EXT address. ---

export async function probeP6(input, { timeoutMs = P6_TIMEOUT_MS } = {}) {
  if (!Array.isArray(input.p6) || input.p6.some(target => net.isIP(String(target?.address)) === 0 || !Number.isInteger(target?.port))) return fail('P6', 'input_invalid');
  const connected = await Promise.all(input.p6.map(target => tcpConnects(target, timeoutMs)));
  return connected.some(Boolean) ? fail('P6', 'connected') : pass('P6');
}

// --- P7 (DoD 2, 4): the read-only places refuse a write; scratch and both reports accept one; the marker matches the environment. ---

// true when the file could be created (it is removed again at once).
function creates(file) {
  try { fs.writeFileSync(file, '', { flag: 'wx' }); } catch { return false; }
  try { fs.rmSync(file); } catch { /* the probe still reports the write */ }
  return true;
}
function opensForWriting(file) {
  try { fs.closeSync(fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW)); return true; } catch { return false; }
}

export async function probeP7(input, { paths = {} } = {}) {
  const { roots = ['/', '/acoder', '/run/acoder-egress'], marker = '/acoder/run.json' } = paths;
  const { beside, ledger, scratch, report_md: md, report_json: json } = input.paths;
  const name = `acoder-probe-${input.nonce}`;
  const readOnly = [creates(beside), opensForWriting(ledger), ...roots.map(root => creates(path.join(root, name)))];
  if (readOnly.some(Boolean)) return fail('P7', 'readonly_writable');
  if (!creates(path.join(scratch, name)) || !opensForWriting(md) || !opensForWriting(json)) return fail('P7', 'writable_refused');
  let run = null;
  try { run = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { run = null; }
  if (run?.tag !== input.tag || run?.ticket_sha256 !== input.ticket_sha256) return fail('P7', 'marker_mismatch');
  return pass('P7');
}

// --- P8 (DoD 8): the effective environment names, user and group, capabilities, no-new-privileges and seccomp. ---

export async function probeP8(input, { env = process.env, uid = process.getuid(), gid = process.getgid(), status = readText('/proc/self/status') } = {}) {
  const names = Object.keys(env).filter(key => env[key] !== undefined);
  const planned = new Set(input.env_names);
  const allowed = new Set([...input.env_names, ...(input.env_allowance ?? [])]);
  if (![...planned].every(name => names.includes(name)) || !names.every(name => allowed.has(name))) return fail('P8', 'env_names');
  if (uid !== input.uid || gid !== input.gid) return fail('P8', 'ids');
  if (typeof status !== 'string') return fail('P8', 'status_unreadable');
  const field = key => new RegExp(`^${key}:\\s*(\\S+)\\s*$`, 'm').exec(status)?.[1] ?? null;
  if (field('CapEff') === null || !/^0+$/.test(field('CapEff'))) return fail('P8', 'capabilities');
  if (field('NoNewPrivs') !== '1') return fail('P8', 'no_new_privileges');
  if (field('Seccomp') !== '2') return fail('P8', 'seccomp');
  // A8.3: the injected names seen besides the plan (all of the allowance, checked above) as one fixed code: injected_<lower-case names,
  // sorted, joined by _> or injected_none; the launcher records it as injected:<names>.
  // F-40-05: the `_` join is unambiguous only while no allowance name holds an underscore (both allowances are letters and digits only,
  // pinned by a test of INJECTED_ENV). A future allowance name with an underscore needs a length-delimited code instead of this one.
  const injected = names.filter(name => !planned.has(name)).map(name => name.toLowerCase()).sort();
  return { id: 'P8', result: 'pass', detail: `injected_${injected.length === 0 ? 'none' : injected.join('_')}` };
}

// All eight, in order; a probe that throws counts as failed.
export async function runProbes(input, { relayPort = 8080 } = {}) {
  const safely = async (id, run) => { try { return await run(); } catch { return fail(id, 'probe_error'); } };
  const results = [await safely('P1', async () => probeP1())];
  results.push(await safely('P2', () => probeP2({ targets: dnsTargets(readText('/etc/resolv.conf')) })));
  results.push(await safely('P3', () => probeP3(input)));
  const p4p5 = await safely('P4', () => probeP4P5(input, { relayPort }));
  results.push(...(Array.isArray(p4p5) ? p4p5 : [p4p5, fail('P5', 'probe_error')]));
  results.push(await safely('P6', () => probeP6(input)));
  results.push(await safely('P7', () => probeP7(input)));
  results.push(await safely('P8', () => probeP8(input)));
  return results;
}
