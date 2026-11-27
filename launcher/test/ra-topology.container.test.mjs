import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { docker, IMAGE_ID, removeLabelled, RUNTIME, SKIP, testIds } from './helpers/container-env.mjs';
import { fixtureBase, forceRemove } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; without a runtime or ACODER_TEST_IMAGE it is
// skipped with the reason (S4-AC17).
const t = (name, fn, timeout = 120000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// S4-AC2 (R-h): the runtime facts the design relies on, shown on this host with the test image. Every container gets the run's design
// settings where they matter (`--network none`, all capabilities dropped, no-new-privileges, the host user) and the test labels; each
// result carries a nonce, so the assertion is on output only that container produced. The AF_VSOCK measurement of S4-AC2 is NOT
// repeated here: the owner authorized exactly one default and one control run of the probe image (D-R36); their raw output is in the
// S4 report.
const uidgid = `${process.getuid()}:${process.getgid()}`;
const HARDENING = ['--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', uidgid, '--pull', 'never'];

async function withTopology(fn) {
  const ids = testIds();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fixtureBase(), 'art-')));
  try {
    return await fn({ ...ids, base, nonce: randomBytes(8).toString('hex') });
  } finally {
    const left = await removeLabelled(ids.filter);
    forceRemove(base);
    assert.deepEqual(left, { containers: [], volumes: [], networks: [] }, 'S4-AC18: no labelled resource of the test remains');
  }
}

const node = (name, labels, mountArgs, code, extra = []) => ['run', '--rm', '--name', name, ...labels, ...HARDENING, '--log-driver', 'none', ...extra, ...mountArgs, '--entrypoint', 'node', IMAGE_ID(), '-e', code];
const lastJson = text => {
  const line = text.trim().split('\n').at(-1) ?? '';
  try { return JSON.parse(line); } catch { assert.fail(`the container printed no JSON result: ${text.slice(0, 400)}`); }
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await predicate()) return; await wait(200); }
  assert.fail(`${what} within ${ms} ms`);
}

t('ra-topology: two containers share a memory-backed volume; a socket made by one is connectable from the other through a READ-ONLY mount, which cannot create a file', async () => {
  await withTopology(async ({ id, labels, nonce }) => {
    const volume = `acoder-egress-${id}`;
    const created = await docker(['volume', 'create', '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', `o=size=1m,uid=${process.getuid()},gid=${process.getgid()},mode=0750`, ...labels, volume]);
    assert.equal(created.code, 0, created.stderr);
    const server = `const net=require('node:net');const fs=require('node:fs');const s=net.createServer(c=>c.end('pong ${nonce}'));process.umask(0o177);s.listen('/run/acoder-egress/egress.sock',()=>{fs.chmodSync('/run/acoder-egress/egress.sock',0o600);console.log('listening')});`;
    const started = await docker(['run', '--detach', '--name', `srv-${id}`, ...labels, ...HARDENING, '--read-only', '--log-driver', 'none', '--mount', `type=volume,source=${volume},target=/run/acoder-egress`, '--entrypoint', 'node', IMAGE_ID(), '-e', server]);
    assert.equal(started.code, 0, started.stderr);
    const client = `const net=require('node:net');const fs=require('node:fs');const out={};
const tryCreate=()=>{try{fs.writeFileSync('/run/acoder-egress/x','x');return 'created'}catch(e){return e.code}};
const go=n=>{const c=net.connect('/run/acoder-egress/egress.sock');let d='';c.on('data',x=>d+=x);c.on('end',()=>{out.answer=d;out.create=tryCreate();out.mode=(fs.statSync('/run/acoder-egress/egress.sock').mode&0o777).toString(8);console.log(JSON.stringify(out))});c.on('error',e=>{if(n>0)setTimeout(()=>go(n-1),200);else{out.error=e.code;out.create=tryCreate();console.log(JSON.stringify(out))}})};go(50);`;
    const result = await docker(node(`cli-${id}`, labels, ['--read-only', '--mount', `type=volume,source=${volume},target=/run/acoder-egress,readonly`], client));
    assert.equal(result.code, 0, result.stderr);
    const facts = lastJson(result.stdout);
    assert.equal(facts.answer, `pong ${nonce}`, 'the read-only side connected to the socket the other container created (RA1)');
    assert.equal(facts.mode, '600');
    assert.equal(facts.create, 'EROFS', 'the read-only side cannot create a file beside the socket');
  });
});

t('ra-topology: read-only binds over /etc/hosts and /etc/resolv.conf are in effect with --network none', async () => {
  await withTopology(async ({ id, labels, base, nonce }) => {
    fs.writeFileSync(path.join(base, 'hosts'), `127.0.0.1 localhost\n127.0.0.1 allowed-${nonce}.test\n`);
    fs.writeFileSync(path.join(base, 'resolv.conf'), '# acoder: no name server is configured\n');
    const code = `const fs=require('node:fs');const dns=require('node:dns');const out={hosts:fs.readFileSync('/etc/hosts','utf8'),resolv:fs.readFileSync('/etc/resolv.conf','utf8')};
try{fs.appendFileSync('/etc/hosts','x');out.write='written'}catch(e){out.write=e.code}
dns.lookup('allowed-${nonce}.test',{all:true},(e,a)=>{out.allowed=e?e.code:a;dns.lookup('example.com',(e2)=>{out.example=e2?'failed':'resolved';console.log(JSON.stringify(out))})});`;
    const result = await docker(node(`etc-${id}`, labels, [
      '--read-only', '--mount', `type=bind,source=${path.join(base, 'hosts')},target=/etc/hosts,readonly`, '--mount', `type=bind,source=${path.join(base, 'resolv.conf')},target=/etc/resolv.conf,readonly`,
    ], code));
    assert.equal(result.code, 0, result.stderr);
    const facts = lastJson(result.stdout);
    assert.equal(facts.hosts, `127.0.0.1 localhost\n127.0.0.1 allowed-${nonce}.test\n`, 'the bind replaced /etc/hosts (RA2)');
    assert.equal(facts.resolv, '# acoder: no name server is configured\n', 'the bind replaced /etc/resolv.conf (RA2)');
    assert.equal(facts.write, 'EROFS');
    assert.deepEqual(facts.allowed, [{ address: '127.0.0.1', family: 4 }]);
    assert.equal(facts.example, 'failed');
  });
});

t('ra-topology: a --log-driver none container can be attached, receives a line on standard input and sees end of input when the attaching process dies', async () => {
  await withTopology(async ({ id, labels, base, nonce }) => {
    const dir = path.join(base, 'out');
    fs.mkdirSync(dir);
    const name = `att-${id}`;
    const code = `const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',l=>{console.log('got '+l)});rl.on('close',()=>{fs.writeFileSync('/out/eof','end of input ${nonce}');process.exit(0)});`;
    const created = await docker(['create', '--name', name, ...labels, ...HARDENING, '--read-only', '--log-driver', 'none', '--interactive', '--mount', `type=bind,source=${dir},target=/out`, '--entrypoint', 'node', IMAGE_ID(), '-e', code]);
    assert.equal(created.code, 0, created.stderr);
    const attach = spawn(RUNTIME(), ['start', '--attach', '--interactive', name], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let output = '';
    attach.stdout.on('data', chunk => { output += chunk; });
    attach.stdin.on('error', () => {});
    attach.stdin.write(`hello ${nonce}\n`);
    await until(() => output.includes(`got hello ${nonce}`), 30000, 'the attached container answered the line');
    assert.equal(fs.existsSync(path.join(dir, 'eof')), false, 'no end of input before the attaching process dies');
    attach.kill('SIGKILL');
    await until(() => fs.existsSync(path.join(dir, 'eof')), 30000, 'the container saw end of input after the attaching process was killed');
    assert.equal(fs.readFileSync(path.join(dir, 'eof'), 'utf8'), `end of input ${nonce}`);
    const info = JSON.parse((await docker(['container', 'inspect', name])).stdout)[0];
    assert.equal(info.HostConfig.LogConfig.Type, 'none');
    assert.equal(info.LogPath, '', 'the runtime keeps no log file of a --log-driver none container');
  });
});

t('ra-topology: a single-file read-write bind nested in a read-only bind accepts in-place writes; the rest of the read-only bind does not', async () => {
  await withTopology(async ({ id, labels, base, nonce }) => {
    const parent = path.join(base, 'mailbox');
    fs.mkdirSync(parent);
    fs.writeFileSync(path.join(parent, 'ledger.json'), '{}\n');
    fs.writeFileSync(path.join(parent, 'report.md'), '');
    const code = `const fs=require('node:fs');const out={};const t=(k,f)=>{try{f();out[k]='ok'}catch(e){out[k]=e.code}};
t('write',()=>fs.writeFileSync('/m/report.md','report ${nonce}\\n'));t('append',()=>fs.appendFileSync('/m/report.md','more\\n'));
t('ledger',()=>fs.appendFileSync('/m/ledger.json','x'));t('beside',()=>fs.writeFileSync('/m/new.md','x'));console.log(JSON.stringify(out));`;
    const result = await docker(node(`nest-${id}`, labels, [
      '--read-only', '--mount', `type=bind,source=${parent},target=/m,readonly`, '--mount', `type=bind,source=${path.join(parent, 'report.md')},target=/m/report.md`,
    ], code));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(lastJson(result.stdout), { write: 'ok', append: 'ok', ledger: 'EROFS', beside: 'EROFS' });
    assert.equal(fs.readFileSync(path.join(parent, 'report.md'), 'utf8'), `report ${nonce}\nmore\n`, 'the host sees the in-place writes');
    assert.equal(fs.readFileSync(path.join(parent, 'ledger.json'), 'utf8'), '{}\n');
    assert.equal(fs.existsSync(path.join(parent, 'new.md')), false);
  });
});

// The read-only script of S4-AC2 that reads the P1 sources (not the probe.mjs implementation): the raw facts are printed as test
// diagnostics, and every source must exist and be readable (a missing one stops S4 for an owner decision).
const P1_FACTS = `for d in /sys/class/net/*; do n=\${d##*/}; if [ -d "$d" ]; then printf 'flags %s %s\\n' "$n" "$(cat "$d/flags" 2>&1)"; else printf 'not-a-device %s\\n' "$n"; fi; done
for f in /proc/net/if_inet6 /proc/net/fib_trie /proc/net/route /proc/net/ipv6_route; do if [ -r "$f" ]; then echo "=== $f"; cat "$f"; else echo "=== $f UNREADABLE"; fi; done
echo "=== nonce $1"
`;

t('ra-topology: the P1 sources (device flags, IPv6 addresses, IPv4 fib, IPv4 and IPv6 routes) exist and are readable with the design settings', async context => {
  await withTopology(async ({ id, labels, nonce }) => {
    const result = await docker(['run', '--rm', '--interactive', '--name', `p1-${id}`, ...labels, ...HARDENING, '--read-only', '--log-driver', 'none', '--entrypoint', 'sh', IMAGE_ID(), '-s', nonce], { input: P1_FACTS });
    assert.equal(result.code, 0, result.stderr);
    context.diagnostic(result.stdout);
    assert.ok(result.stdout.includes(`=== nonce ${nonce}`), 'the facts came from this container');
    for (const source of ['/proc/net/if_inet6', '/proc/net/fib_trie', '/proc/net/route', '/proc/net/ipv6_route']) {
      assert.ok(result.stdout.includes(`=== ${source}\n`), `${source} is readable`);
    }
    assert.match(result.stdout, /^flags lo 0x[0-9a-f]+$/m, 'the loopback device has a readable flags file');
    assert.doesNotMatch(result.stdout, /^flags \S+ .*(?:No such|can't|denied)/m, 'every device has a readable flags file');
  });
});
