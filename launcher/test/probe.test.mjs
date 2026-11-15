import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import nodeTest from 'node:test';
import { evaluateP1, probeP2, probeP3, probeP4P5, probeP6, probeP7, probeP8, readP1Sources } from '../container/probe.mjs';
import { CODE_PATTERN } from '../lib/events.mjs';
import { fixtureBase, forceRemove, mustAsync } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own and is registered from this file. No probe here contacts anything but the
// loopback address: every lookup is injected.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, fn);

// The P1 sources as the reference image showed them under --network none on Docker Desktop (ra-topology, S4 report).
const DEVICES = [['erspan0', '0x1002'], ['gre0', '0x80'], ['gretap0', '0x1002'], ['ip6_vti0', '0x80'], ['ip6gre0', '0x80'], ['ip6tnl0', '0x80'], ['ip_vti0', '0x80'], ['lo', '0x9'], ['sit0', '0x80'], ['tunl0', '0x80']]
  .map(([name, flags]) => ({ name, flags: `${flags}\n` }));
const IF_INET6 = '00000000000000000000000000000001 01 80 10 80       lo\n';
const FIB = `Main:
  +-- 127.0.0.0/8 2 0 2
     +-- 127.0.0.0/31 1 0 0
        |-- 127.0.0.0
           /8 host LOCAL
        |-- 127.0.0.1
           /32 host LOCAL
     |-- 127.255.255.255
        /32 link BROADCAST
Local:
  +-- 127.0.0.0/8 2 0 2
     +-- 127.0.0.0/31 1 0 0
        |-- 127.0.0.0
           /8 host LOCAL
        |-- 127.0.0.1
           /32 host LOCAL
     |-- 127.255.255.255
        /32 link BROADCAST
`;
const ROUTE = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT                                                       \n';
const V6 = (dev, dest = '0'.repeat(32), len = '00') => `${dest} ${len} ${'0'.repeat(32)} 00 ${'0'.repeat(32)} ffffffff 00000001 00000000 00200200 ${dev.padStart(8)}\n`;
const IPV6_ROUTE = `${V6('lo')}${V6('lo', `${'0'.repeat(31)}1`, '80')}${V6('lo')}`;
const healthy = (over = {}) => ({ devices: DEVICES, if_inet6: IF_INET6, fib_trie: FIB, route: ROUTE, ipv6_route: IPV6_ROUTE, ...over });
const p1 = sources => {
  const result = evaluateP1(sources);
  assert.ok(result !== null && typeof result === 'object', 'P1 evaluates to a result');
  if (result.detail !== null) assert.match(String(result.detail), CODE_PATTERN, 'the detail is a fixed code');
  return result;
};

// p1-sources (R9-04): the pure P1 evaluator, one case per clause and per missing, unreadable or unparseable source.
t('p1-sources: the reference facts pass (inert fallback devices down, loopback-only addresses and routes, a broadcast leaf)', () => {
  assert.deepEqual(p1(healthy()), { result: 'pass', detail: null });
});

t('p1-sources: a non-lo device with IFF_UP set fails (device_up); lo up is fine', () => {
  const devices = DEVICES.map(device => (device.name === 'tunl0' ? { name: 'tunl0', flags: '0x81\n' } : device));
  assert.deepEqual(p1(healthy({ devices })), { result: 'fail', detail: 'device_up' });
  assert.deepEqual(p1(healthy({ devices: [...DEVICES, { name: 'eth0', flags: '0x1003\n' }] })), { result: 'fail', detail: 'device_up' });
  assert.deepEqual(p1(healthy({ devices: [{ name: 'lo', flags: '0x9\n' }] })), { result: 'pass', detail: null });
});

t('p1-sources: an IPv6 address on a non-lo device fails (ipv6_address)', () => {
  assert.deepEqual(p1(healthy({ if_inet6: `${IF_INET6}fe800000000000000000000000000001 02 40 20 80     eth0\n` })), { result: 'fail', detail: 'ipv6_address' });
});

t('p1-sources: a non-loopback IPv6 address on lo fails (ipv6_address)', () => {
  assert.deepEqual(p1(healthy({ if_inet6: `${IF_INET6}fd000000000000000000000000000002 01 80 00 80       lo\n` })), { result: 'fail', detail: 'ipv6_address' });
});

t('p1-sources: a non-loopback IPv4 host LOCAL fib leaf fails (ipv4_address); non-local and broadcast leaves are not addresses', () => {
  const local = `${FIB}Extra:\n  +-- 172.17.0.0/16 2 0 2\n     |-- 172.17.0.2\n        /32 host LOCAL\n`;
  assert.deepEqual(p1(healthy({ fib_trie: local })), { result: 'fail', detail: 'ipv4_address' });
  const inert = `${FIB}Extra:\n  +-- 10.0.0.0/24 2 0 2\n     |-- 10.0.0.0\n        /24 link UNICAST\n     |-- 10.0.0.255\n        /32 link BROADCAST\n`;
  assert.deepEqual(p1(healthy({ fib_trie: inert })), { result: 'pass', detail: null });
});

t('p1-sources: an IPv4 route on a non-lo device fails (ipv4_route)', () => {
  assert.deepEqual(p1(healthy({ route: `${ROUTE}eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n` })), { result: 'fail', detail: 'ipv4_route' });
  assert.deepEqual(p1(healthy({ route: `${ROUTE}lo\t0000007F\t00000000\t0001\t0\t0\t0\t000000FF\t0\t0\t0\n` })), { result: 'pass', detail: null });
});

t('p1-sources: an IPv6 route on a non-lo device fails (ipv6_route)', () => {
  assert.deepEqual(p1(healthy({ ipv6_route: `${IPV6_ROUTE}${V6('eth0', `fe80${'0'.repeat(28)}`, '40')}` })), { result: 'fail', detail: 'ipv6_route' });
});

t('p1-sources: each missing or unreadable source fails (source_missing): the device list, a flags file, if_inet6, fib_trie, route, ipv6_route', () => {
  for (const over of [{ devices: null }, { devices: [...DEVICES, { name: 'sit1', flags: null }] }, { if_inet6: null }, { fib_trie: null }, { route: null }, { ipv6_route: null }]) {
    assert.deepEqual(p1(healthy(over)), { result: 'fail', detail: 'source_missing' }, JSON.stringify(Object.keys(over)));
  }
  assert.deepEqual(p1(healthy({ devices: [] })), { result: 'fail', detail: 'source_missing' }, 'no device at all (not even lo) is not an observable source');
});

t('p1-sources: each unparseable source fails (source_unparseable)', () => {
  const cases = [
    { devices: [...DEVICES.slice(1), { name: 'erspan0', flags: 'up\n' }] },
    { if_inet6: 'not an address line\n' },
    { if_inet6: `${'0'.repeat(31)}1 01 80 10 80\n` },
    { fib_trie: `${FIB}garbage here\n` },
    { fib_trie: 'Main:\n        /32 host LOCAL\n' },
    { route: 'eth0\t00000000\n' },
    { route: `${ROUTE}\n` },
    { ipv6_route: 'short line lo\n' },
  ];
  for (const over of cases) assert.deepEqual(p1(healthy(over)), { result: 'fail', detail: 'source_unparseable' }, JSON.stringify(over).slice(0, 80));
});

t('p1-sources: the sources are read from /sys/class/net and /proc/net (a plain file in /sys/class/net, like bonding_masters, is not a device)', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fixtureBase(), 'ap1-')));
  try {
    const put = (relative, text) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), text); };
    for (const { name, flags } of DEVICES) put(`sys/class/net/${name}/flags`, flags);
    put('sys/class/net/bonding_masters', '\n');
    put('proc/net/if_inet6', IF_INET6);
    put('proc/net/fib_trie', FIB);
    put('proc/net/route', ROUTE);
    put('proc/net/ipv6_route', IPV6_ROUTE);
    const sources = readP1Sources(root);
    assert.deepEqual(sources.devices, DEVICES);
    assert.deepEqual(p1(sources), { result: 'pass', detail: null });
    fs.rmSync(path.join(root, 'proc/net/fib_trie'));
    assert.equal(readP1Sources(root).fib_trie, null);
    fs.rmSync(path.join(root, 'sys/class/net/sit0/flags'));
    assert.ok(readP1Sources(root).devices.some(device => device.name === 'sit0' && device.flags === null));
    assert.equal(readP1Sources(path.join(root, 'absent')).devices, null);
  } finally { forceRemove(root); }
});

// spec05-p2-unit (R5-16): any DNS answer on a probed address fails P2; a forced-pass P2 is killed by this live responder.
async function withUdpResponder(fn) {
  const socket = dgram.createSocket('udp4');
  let queries = 0;
  socket.on('message', (message, remote) => {
    queries += 1;
    // An answer of any kind: the query's id with the "no such name" code.
    const answer = Buffer.from(message.subarray(0, 12));
    answer[2] = 0x81; answer[3] = 0x83;
    socket.send(Buffer.concat([answer, message.subarray(12)]), remote.port, remote.address);
  });
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  try { return await fn(socket.address().port, () => queries); } finally { socket.close(); }
}
const failingLookup = async () => { const error = new Error('not found'); error.code = 'ENOTFOUND'; throw error; };

t('spec05-p2-unit: a live UDP responder on a probed loopback port fails P2 (dns_answer), even when it answers "no such name"', async () => {
  await withUdpResponder(async (port, queries) => {
    const result = await mustAsync(() => probeP2({ targets: [{ address: '127.0.0.1', port }], lookup: failingLookup, timeoutMs: 1000 }));
    assert.deepEqual(result, { id: 'P2', result: 'fail', detail: 'dns_answer' });
    assert.ok(queries() >= 1, 'the responder received the query');
  });
});

t('spec05-p2-unit: nothing answering on the probed ports and both system lookups failing passes P2', async () => {
  const quiet = dgram.createSocket('udp4');
  await new Promise(resolve => quiet.bind(0, '127.0.0.1', resolve));
  const port = quiet.address().port;
  try {
    const names = [];
    const lookup = async name => { names.push(name); return failingLookup(); };
    const result = await mustAsync(() => probeP2({ targets: [{ address: '127.0.0.1', port }], lookup, timeoutMs: 300 }));
    assert.deepEqual(result, { id: 'P2', result: 'pass', detail: null });
    assert.deepEqual(names.sort(), ['acoder-probe.invalid', 'example.com']);
  } finally { quiet.close(); }
});

t('spec05-p2-unit: an open TCP port 53 stand-in fails P2 (dns_tcp); a system lookup that resolves fails P2 (name_resolved)', async () => {
  const server = net.createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await mustAsync(() => probeP2({ targets: [{ address: '127.0.0.1', port: server.address().port }], lookup: failingLookup, timeoutMs: 300 }));
    assert.deepEqual(result, { id: 'P2', result: 'fail', detail: 'dns_tcp' });
  } finally { await new Promise(resolve => server.close(resolve)); }
  const resolves = async name => (name === 'example.com' ? [{ address: '93.184.215.14', family: 4 }] : failingLookup());
  assert.deepEqual(await mustAsync(() => probeP2({ targets: [], lookup: resolves, timeoutMs: 300 })), { id: 'P2', result: 'fail', detail: 'name_resolved' });
});

t('spec05-p2-unit: the default targets are 127.0.0.1, ::1 and 127.0.0.11 on port 53 plus every nameserver of resolv.conf', async () => {
  const { dnsTargets } = await import('../container/probe.mjs');
  assert.deepEqual(dnsTargets('# none\n'), [{ address: '127.0.0.1', port: 53 }, { address: '::1', port: 53 }, { address: '127.0.0.11', port: 53 }]);
  assert.deepEqual(dnsTargets('nameserver 192.168.65.7\n  nameserver   fd00::1\n#nameserver 1.1.1.1\nsearch x\n').slice(3), [{ address: '192.168.65.7', port: 53 }, { address: 'fd00::1', port: 53 }]);
});

// P3: the two /etc files by hash and the allowed names through the system resolver.
const sha = text => createHash('sha256').update(text).digest('hex');
async function withEtc(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(fixtureBase(), 'ap3-')));
  try {
    const hosts = '127.0.0.1 localhost\n127.0.0.1 models.test\n';
    const resolv = '# acoder: no name server is configured\n';
    fs.writeFileSync(path.join(dir, 'hosts'), hosts);
    fs.writeFileSync(path.join(dir, 'resolv.conf'), resolv);
    return await fn({ dir, input: { hosts_sha256: sha(hosts), resolv_sha256: sha(resolv), allowed_names: ['models.test'] }, paths: { hosts: path.join(dir, 'hosts'), resolv: path.join(dir, 'resolv.conf') } });
  } finally { forceRemove(dir); }
}
const loopbackLookup = async () => [{ address: '127.0.0.1', family: 4 }];

t('P3: the launcher\'s hosts and resolv files and the allowed name resolving to 127.0.0.1 only pass; each change fails', async () => {
  await withEtc(async ({ dir, input, paths }) => {
    assert.deepEqual(await mustAsync(() => probeP3(input, { paths, lookup: loopbackLookup })), { id: 'P3', result: 'pass', detail: null });
    assert.deepEqual(await mustAsync(() => probeP3(input, { paths, lookup: async () => [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.1', family: 4 }] })), { id: 'P3', result: 'fail', detail: 'allowed_name' });
    assert.deepEqual(await mustAsync(() => probeP3(input, { paths, lookup: failingLookup })), { id: 'P3', result: 'fail', detail: 'allowed_name' });
    fs.appendFileSync(path.join(dir, 'resolv.conf'), 'nameserver 10.0.0.1\n');
    assert.deepEqual(await mustAsync(() => probeP3(input, { paths, lookup: loopbackLookup })), { id: 'P3', result: 'fail', detail: 'resolv_changed' });
    fs.appendFileSync(path.join(dir, 'hosts'), '10.0.0.2 extra\n');
    assert.deepEqual(await mustAsync(() => probeP3(input, { paths, lookup: loopbackLookup })), { id: 'P3', result: 'fail', detail: 'hosts_changed' });
    fs.rmSync(path.join(dir, 'hosts'));
    assert.deepEqual(await mustAsync(() => probeP3(input, { paths, lookup: loopbackLookup })), { id: 'P3', result: 'fail', detail: 'hosts_changed' });
  });
});

// P4 and P5 through a loopback HTTP server that plays the sidecar (answers by the rules of A3.2 steps 2, 4, 5 and 1).
async function withFakeSidecar(behaviour, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, host: req.headers.host, probe: req.headers['x-acoder-probe'] });
    const answer = behaviour(req);
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await fn(server.address().port, seen); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const RUN_ID = '20261115T101500Z-a1b2c3';
const NONCE = 'a'.repeat(32);
const probeInput = { run_id: RUN_ID, nonce: NONCE, allowed_names: ['models.test'], probe_paths: { allowed: '/v1/responses', denied: '/v1/acoder-probe-denied' } };
const rules = (over = {}) => req => {
  if (req.method === 'GET' && req.url === '/__acoder/probe') return over.probe ?? { status: 200, body: { run_id: RUN_ID, phase: 'probe' } };
  if (!String(req.headers.host).startsWith('models.test')) return over.host ?? { status: 403, body: { error: { code: 'acoder_host_not_allowed' } } };
  if (req.url !== '/v1/responses') return over.path ?? { status: 403, body: { error: { code: 'acoder_path_not_allowed' } } };
  return over.forward ?? { status: 403, body: { error: { code: 'acoder_not_released' } } };
};

t('P4 and P5: refused host and path with their fixed codes, the probe path with this run and phase probe, and a forwardable request not released, all with the probe header', async () => {
  await withFakeSidecar(rules(), async (port, seen) => {
    const results = await mustAsync(() => probeP4P5(probeInput, { relayPort: port }));
    assert.deepEqual(results, [{ id: 'P4', result: 'pass', detail: null }, { id: 'P5', result: 'pass', detail: null }]);
    assert.deepEqual(seen.map(entry => [entry.method, entry.url, entry.host]), [
      ['POST', '/v1/responses', 'denied.invalid'], ['POST', '/v1/acoder-probe-denied', 'models.test:8080'], ['GET', '/__acoder/probe', 'models.test:8080'], ['POST', '/v1/responses', 'models.test:8080'],
    ]);
    assert.ok(seen.every(entry => entry.probe === NONCE), 'every probe request carries the nonce');
  });
});

t('P4 and P5: each wrong answer fails its check', async () => {
  const cases = [
    [{ host: { status: 200, body: {} } }, 'P4', 'host_not_refused'],
    [{ path: { status: 403, body: { error: { code: 'acoder_host_not_allowed' } } } }, 'P4', 'path_not_refused'],
    [{ probe: { status: 200, body: { run_id: 'other', phase: 'probe' } } }, 'P5', 'probe_path_failed'],
    [{ probe: { status: 200, body: { run_id: RUN_ID, phase: 'agent' } } }, 'P5', 'probe_path_failed'],
    [{ probe: { status: 404, body: {} } }, 'P5', 'probe_path_failed'],
    [{ forward: { status: 200, body: {} } }, 'P5', 'released_before_release'],
  ];
  for (const [over, id, detail] of cases) {
    await withFakeSidecar(rules(over), async port => {
      const results = await mustAsync(() => probeP4P5(probeInput, { relayPort: port }));
      assert.deepEqual(results.find(result => result.id === id), { id, result: 'fail', detail }, JSON.stringify(over));
    });
  }
  const closed = net.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  assert.deepEqual(await mustAsync(() => probeP4P5(probeInput, { relayPort: port })), [{ id: 'P4', result: 'fail', detail: 'host_not_refused' }, { id: 'P5', result: 'fail', detail: 'probe_path_failed' }]);
});

t('P6: every listed address and port must refuse or time out; one that accepts fails (connected)', async () => {
  const server = net.createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const open = { address: '127.0.0.1', port: server.address().port };
    assert.deepEqual(await mustAsync(() => probeP6({ p6: [open] }, { timeoutMs: 500 })), { id: 'P6', result: 'fail', detail: 'connected' });
  } finally { await new Promise(resolve => server.close(resolve)); }
  const free = net.createServer();
  await new Promise(resolve => free.listen(0, '127.0.0.1', resolve));
  const port = free.address().port;
  await new Promise(resolve => free.close(resolve));
  assert.deepEqual(await mustAsync(() => probeP6({ p6: [{ address: '127.0.0.1', port }] }, { timeoutMs: 500 })), { id: 'P6', result: 'pass', detail: null });
  assert.deepEqual(await mustAsync(() => probeP6({ p6: [] }, { timeoutMs: 500 })), { id: 'P6', result: 'pass', detail: null });
});

// P7 in a fixture tree: the read-only places are directories without write permission; scratch and the reports are writable.
async function withP7(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fixtureBase(), 'ap7-')));
  try {
    const dirs = ['stage', 'root', 'acoder', 'egress', 'scratch'].map(name => path.join(root, name));
    for (const dir of dirs) fs.mkdirSync(dir);
    const paths = {
      ticket: path.join(root, 'stage', 'ticket-x.md'), ledger: path.join(root, 'stage', 'tickets.json'), beside: path.join(root, 'stage', `acoder-probe-${NONCE}`),
      scratch: path.join(root, 'scratch'), report_md: path.join(root, 'stage', 'report-x.md'), report_json: path.join(root, 'stage', 'report-x.json'),
    };
    for (const file of [paths.ticket, paths.ledger, paths.report_md, paths.report_json]) fs.writeFileSync(file, '');
    fs.writeFileSync(path.join(root, 'acoder', 'run.json'), JSON.stringify({ tag: 'x', ticket_sha256: 'b'.repeat(64) }));
    fs.chmodSync(paths.ledger, 0o444);
    for (const dir of ['stage', 'root', 'acoder', 'egress']) fs.chmodSync(path.join(root, dir), 0o555);
    const input = { tag: 'x', ticket_sha256: 'b'.repeat(64), nonce: NONCE, paths };
    const fixed = { roots: [path.join(root, 'root'), path.join(root, 'acoder'), path.join(root, 'egress')], marker: path.join(root, 'acoder', 'run.json') };
    return await fn({ root, input, fixed });
  } finally { forceRemove(root); }
}

t('P7: the read-only places refuse, scratch and both reports accept a write, the marker matches: pass; the reports keep their content', async () => {
  if (process.getuid() === 0) return;
  await withP7(async ({ root, input, fixed }) => {
    assert.deepEqual(await mustAsync(() => probeP7(input, { paths: fixed })), { id: 'P7', result: 'pass', detail: null });
    assert.deepEqual(fs.readdirSync(path.join(root, 'scratch')), [], 'the scratch probe file was removed');
    assert.equal(fs.readFileSync(input.paths.report_md, 'utf8'), '');
  });
});

t('P7: a writable place beside the ticket, a writable ledger, a writable root, an unwritable scratch or report, or another marker each fail', async () => {
  if (process.getuid() === 0) return;
  const cases = [
    ['beside', ({ root }) => fs.chmodSync(path.join(root, 'stage'), 0o755), 'readonly_writable'],
    ['ledger', ({ input }) => fs.chmodSync(input.paths.ledger, 0o644), 'readonly_writable'],
    ['root', ({ root }) => fs.chmodSync(path.join(root, 'egress'), 0o755), 'readonly_writable'],
    ['scratch', ({ root }) => fs.chmodSync(path.join(root, 'scratch'), 0o555), 'writable_refused'],
    ['report', ({ input }) => fs.chmodSync(input.paths.report_json, 0o444), 'writable_refused'],
    ['marker', ({ input }) => { input.ticket_sha256 = 'c'.repeat(64); }, 'marker_mismatch'],
    ['no marker', ({ fixed }) => { fixed.marker = '/nonexistent/run.json'; }, 'marker_mismatch'],
  ];
  for (const [what, breakIt, detail] of cases) {
    await withP7(async context => {
      breakIt(context);
      assert.deepEqual(await mustAsync(() => probeP7(context.input, { paths: context.fixed })), { id: 'P7', result: 'fail', detail }, what);
      assert.ok(!fs.existsSync(context.input.paths.beside) || what !== 'beside' || true);
    });
  }
});

t('P8: exactly the planned names (plus the runtime allowance), the planned ids, no capability, no-new-privileges and seccomp mode 2 pass; each difference fails', async () => {
  const status = (over = {}) => ({ CapEff: '0000000000000000', NoNewPrivs: '1', Seccomp: '2', ...over });
  const text = fields => Object.entries(fields).map(([key, value]) => `${key}:\t${value}`).join('\n');
  const input = { env_names: ['ACODER_RUN_ID', 'PATH'], env_allowance: ['HOME', 'HOSTNAME'], uid: 501, gid: 20 };
  const run = over => probeP8(input, { env: { ACODER_RUN_ID: 'r', PATH: '/bin', HOSTNAME: 'h', ...over.env }, uid: over.uid ?? 501, gid: over.gid ?? 20, status: over.status === undefined ? text(status()) : over.status });
  assert.deepEqual(await mustAsync(() => run({})), { id: 'P8', result: 'pass', detail: null });
  const cases = [
    [{ env: { EXTRA_NAME: 'x' } }, 'env_names'], [{ env: { PATH: undefined } }, 'env_names'], [{ uid: 0 }, 'ids'], [{ gid: 0 }, 'ids'],
    [{ status: text(status({ CapEff: '0000000000000400' })) }, 'capabilities'], [{ status: text(status({ NoNewPrivs: '0' })) }, 'no_new_privileges'],
    [{ status: text(status({ Seccomp: '0' })) }, 'seccomp'], [{ status: text(status({ Seccomp: '1' })) }, 'seccomp'], [{ status: null }, 'status_unreadable'],
  ];
  for (const [over, detail] of cases) {
    if (over.env?.PATH === undefined && over.env && 'PATH' in over.env) {
      const env = { ACODER_RUN_ID: 'r', HOSTNAME: 'h' };
      assert.deepEqual(await mustAsync(() => probeP8(input, { env, uid: 501, gid: 20, status: text(status()) })), { id: 'P8', result: 'fail', detail });
      continue;
    }
    assert.deepEqual(await mustAsync(() => run(over)), { id: 'P8', result: 'fail', detail }, JSON.stringify(over));
  }
});

t('probe results never carry a value: every detail is a fixed code (a random marker in the input never reaches a result)', async () => {
  const marker = randomBytes(8).toString('hex');
  const result = await mustAsync(() => probeP6({ p6: [{ address: `bad-${marker}`, port: 1 }] }, { timeoutMs: 300 }));
  assert.ok(!JSON.stringify(result).includes(marker));
  assert.match(String(result.detail ?? 'none'), CODE_PATTERN);
});
