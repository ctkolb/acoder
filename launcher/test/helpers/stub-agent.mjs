// The stub agent (A11): driven through the stub adapter, it runs as the agent process (`node stub-agent.mjs --dir <scratch> --model
// <scenario> --effort <e> <first message>`). It first writes the marker file `stub-agent-marker.json` into --dir with what it can see of
// its own start (environment names, process ids, bytes on standard input), then follows the scenario named by --model:
//   marker            exit 0 at once
//   exit-<n>          exit with code n
//   sleep             start a child that sleeps, and sleep (only a kill ends both)
//   silent            sleep, print nothing, make no request
//   good-<n>          make n model requests one after the other, print one step line each, write both reports, exit 0
//   never             make model requests one after the other forever (also after refusals and aborts); never exit by itself
//   flood             many parallel requests straight to the request socket, printing nothing; never exit by itself
//   report-then-fail  write both reports, make two requests (the stub endpoint fails the second), exit 0
//   dump              write into scratch everything it can read (A8.7), then exit 0
//   script            run the steps of /acoder/skill/stub-steps.json (open, abort, request, write, probe, ...)
// Nothing here ends by itself after a socket abort: a scenario that stays alive stays alive until the supervisor or the runtime kills it.
import { spawn, spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const dir = option('--dir');
const scenario = option('--model') ?? 'marker';
const env = process.env;
const tag = env.ACODER_TAG ?? 'unknown';
const stage = dir === null ? null : path.dirname(dir);
const reports = { md: stage === null ? null : path.join(stage, `report-${tag}.md`), json: stage === null ? null : path.join(stage, `report-${tag}.json`) };
const SOCKET = '/run/acoder-egress/egress.sock';
const STEPS = '/acoder/skill/stub-steps.json';
const forever = () => new Promise(() => { setInterval(() => {}, 1000); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const print = value => process.stdout.write(`${JSON.stringify(value)}\n`);

let stdinBytes = 0;
const stdinDone = new Promise(resolve => {
  process.stdin.on('data', chunk => { stdinBytes += chunk.length; });
  process.stdin.on('end', resolve);
  process.stdin.on('error', resolve);
});
await stdinDone;
const marker = { pid: process.pid, ppid: process.ppid, env_names: Object.keys(env).sort(), stdin_bytes: stdinBytes, scenario, cwd: process.cwd(), argv_tail: args.at(-1) };
if (scenario === 'sleep') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  marker.child_pid = child.pid;
}
fs.writeFileSync(path.join(dir, 'stub-agent-marker.json'), `${JSON.stringify(marker)}\n`);
process.stdout.write(`${JSON.stringify({ stub: 'step' })}\n`);

// One model request through the relay (or straight to the request socket). Resolves {status, headers, body} when the answer ends, or
// {error} when the request fails or is aborted. `handle` (optional) receives the request object (to abort it) and `onHead` the answer head.
function modelRequest({ socket = false, host = null, suffix = '/responses', body = '{"input":"stub"}', handle = null, onHead = null } = {}) {
  const base = new URL(env.STUB_BASE_URL ?? 'http://localhost:8080/v1');
  return new Promise(resolve => {
    const headers = { host: host ?? base.hostname, 'content-type': 'application/json', authorization: `Bearer ${env.STUB_API_KEY ?? ''}`, 'content-length': Buffer.byteLength(body) };
    const target = socket ? { socketPath: SOCKET } : { host: base.hostname, port: Number(base.port || 80) };
    const req = http.request({ ...target, method: 'POST', path: `${base.pathname}${suffix}`, headers, agent: false }, res => {
      onHead?.(res);
      const parts = [];
      res.on('data', chunk => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.rawHeaders, body: Buffer.concat(parts).toString('utf8') }));
      res.on('error', error => resolve({ error: String(error.code ?? error.message) }));
      res.on('aborted', () => resolve({ error: 'aborted' }));
    });
    req.on('error', error => resolve({ error: String(error.code ?? error.message) }));
    handle?.(req);
    req.end(body);
  });
}

function writeReports({ md = `# stub report ${tag}\n`, json = `${JSON.stringify({ session: tag, status: 'ready' })}\n` } = {}) {
  if (md !== null) fs.writeFileSync(reports.md, md);
  if (json !== null) fs.writeFileSync(reports.json, json);
}

// The `probe` step (A11 proof of inside): read, list, write, resolve, connect and DNS attempts, each with its result.
async function attempt(action) {
  const out = { ...action };
  try {
    if (action.op === 'read') out.text = fs.readFileSync(action.path, 'utf8').slice(0, 4096);
    else if (action.op === 'list') out.names = fs.readdirSync(action.path).sort();
    else if (action.op === 'append') fs.appendFileSync(action.path, 'x');
    else if (action.op === 'truncate') fs.truncateSync(action.path, 0);
    else if (action.op === 'rename') fs.renameSync(action.path, `${action.path}.moved`);
    else if (action.op === 'unlink') fs.unlinkSync(action.path);
    else if (action.op === 'create') fs.writeFileSync(action.path, 'x', { flag: 'wx' });
    else if (action.op === 'write') fs.writeFileSync(action.path, action.text ?? 'x');
    else if (action.op === 'resolve') out.addresses = (await dns.promises.lookup(action.name, { all: true })).map(entry => entry.address);
    else if (action.op === 'connect') {
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host: action.host, port: action.port });
        const timer = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })); }, action.ms ?? 2000);
        socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve(); });
        socket.on('error', error => { clearTimeout(timer); reject(error); });
      });
    } else if (action.op === 'dns') {
      out.answered = await new Promise(resolve => {
        const family = action.server.includes(':') ? 'udp6' : 'udp4';
        let socket;
        try { socket = dgram.createSocket(family); } catch { resolve(false); return; }
        const name = Buffer.concat([...action.name.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0, 0, 1, 0, 1])]);
        const query = Buffer.concat([Buffer.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]), name]);
        const timer = setTimeout(() => { socket.close(); resolve(false); }, action.ms ?? 1000);
        socket.on('message', () => { clearTimeout(timer); socket.close(); resolve(true); });
        socket.on('error', () => { clearTimeout(timer); try { socket.close(); } catch { /* closed */ } resolve(false); });
        socket.send(query, 53, action.server, error => { if (error) { clearTimeout(timer); try { socket.close(); } catch { /* closed */ } resolve(false); } });
      });
      if (out.answered) return { ...out, ok: true };
      return { ...out, ok: false, code: 'NO_ANSWER' };
    } else if (action.op === 'http') {
      const answer = await modelRequest({ host: action.host ?? null, suffix: action.suffix ?? '/responses', socket: action.socket === true });
      Object.assign(out, { status: answer.status ?? null, body: answer.body?.slice(0, 512) ?? null, error: answer.error ?? null });
      return { ...out, ok: answer.error === undefined };
    } else throw Object.assign(new Error('unknown op'), { code: 'UNKNOWN_OP' });
    return { ...out, ok: true };
  } catch (error) {
    return { ...out, ok: false, code: String(error?.code ?? error?.message) };
  }
}

// A8.7 dump: the environment, every readable /proc/<pid>/environ and cmdline, every file under the listed trees, and the full headers and
// bodies of the answers it got (one request is made first).
async function dump() {
  const parts = [`env ${JSON.stringify(env)}`];
  const answer = await modelRequest();
  parts.push(`answer ${JSON.stringify(answer)}`);
  for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    for (const file of ['environ', 'cmdline']) { try { parts.push(`/proc/${pid}/${file} ${fs.readFileSync(`/proc/${pid}/${file}`).toString('latin1')}`); } catch { /* not readable */ } }
  }
  const walk = (target, depth) => {
    let info;
    try { info = fs.lstatSync(target); } catch { return; }
    if (info.isDirectory() && depth < 12) { let names = []; try { names = fs.readdirSync(target); } catch { return; } for (const name of names) walk(path.join(target, name), depth + 1); return; }
    if (info.isFile() && info.size < 8 * 1024 * 1024 && !target.startsWith(dir)) { try { parts.push(`file ${target} ${fs.readFileSync(target).toString('latin1')}`); } catch { /* not readable */ } }
    if (info.isSocket()) parts.push(`socket ${target}`);
  };
  for (const root of ['/acoder', '/agent', '/work', '/run/acoder-egress', '/etc/hosts', '/etc/resolv.conf']) walk(root, 0);
  fs.writeFileSync(path.join(dir, 'dump.txt'), parts.join('\n'));
}

// Requests forever, one after the other; a refusal or an abort only pauses.
async function never() {
  for (;;) {
    const answer = await modelRequest();
    print({ stub: 'step' });
    if (answer.error !== undefined || answer.status !== 200) await sleep(200);
  }
}

async function flood(parallel) {
  const loop = async () => { for (;;) { const answer = await modelRequest({ socket: true }); if (answer.error !== undefined || answer.status !== 200) await sleep(50); } };
  await Promise.all(Array.from({ length: parallel }, loop));
}

// script steps: request, open {id}, abort {id, afterMs}, wait-head {id}, reports {md, json, jsonPad} (text, or null for none; jsonPad: a padded JSON report), write {name, bytes},
// grow {name, bytes, everyMs}, link {name, target}, churn {ms} (files created and removed at once), mkfifo {name}, mkdir {name, mode},
// tree {name, entries}, print {value}, probe {nonce, actions}, sleep {ms}, never, flood {parallel}, exit {code}, forever.
async function script() {
  const open = {};
  const steps = JSON.parse(fs.readFileSync(STEPS, 'utf8'));
  for (const step of steps) {
    if (step.do === 'request') { const answer = await modelRequest({ host: step.host ?? null, suffix: step.suffix ?? '/responses' }); print({ stub: 'step' }); print({ stub: 'answer', status: answer.status ?? null, error: answer.error ?? null }); }
    else if (step.do === 'open') {
      const entry = { head: null };
      entry.done = modelRequest({ handle: req => { entry.req = req; }, onHead: res => { entry.head = res.statusCode; } });
      open[step.id] = entry;
      print({ stub: 'step' });
    } else if (step.do === 'wait-head') { const end = Date.now() + (step.ms ?? 20000); while (open[step.id].head === null && Date.now() < end) await sleep(20); }
    else if (step.do === 'abort') { await sleep(step.afterMs ?? 0); open[step.id].req.destroy(); }
    else if (step.do === 'reports') writeReports(step.jsonPad ? { ...step, json: JSON.stringify({ session: tag, pad: 'x'.repeat(step.jsonPad) }) } : step);
    else if (step.do === 'link') fs.symlinkSync(step.target, path.join(dir, step.name));
    else if (step.do === 'churn') {
      const end = Date.now() + step.ms;
      for (let index = 0; Date.now() < end; index += 1) { const file = path.join(dir, `churn-${index % 50}`); fs.writeFileSync(file, 'x'); fs.rmSync(file); if (index % 20 === 0) await sleep(1); }
    } else if (step.do === 'tree') {
      fs.mkdirSync(path.join(dir, step.name));
      for (let index = 0; index < step.entries; index += 1) fs.writeFileSync(path.join(dir, step.name, String(index)), '');
    } else if (step.do === 'print') print(step.value);
    else if (step.do === 'write') fs.writeFileSync(path.join(dir, step.name), Buffer.alloc(step.bytes, 120));
    else if (step.do === 'grow') {
      const file = path.join(dir, step.name);
      fs.writeFileSync(path.join(dir, `${step.name}.started`), String(Date.now()));
      for (;;) { fs.appendFileSync(file, Buffer.alloc(step.bytes, 120)); await sleep(step.everyMs ?? 100); }
    } else if (step.do === 'mkfifo') spawnSync('mkfifo', [path.join(dir, step.name)]);
    else if (step.do === 'mkdir') { fs.mkdirSync(path.join(dir, step.name)); fs.writeFileSync(path.join(dir, step.name, 'inside'), 'x'); fs.chmodSync(path.join(dir, step.name), Number.parseInt(step.mode, 8)); }
    else if (step.do === 'probe') {
      const results = [];
      for (const action of step.actions) results.push(await attempt(action));
      let runJson = null;
      try { runJson = JSON.parse(fs.readFileSync('/acoder/run.json', 'utf8')); } catch { runJson = null; }
      print({ stub: 'probe-results', nonce: step.nonce, run_json: runJson, results });
    } else if (step.do === 'sleep') await sleep(step.ms);
    else if (step.do === 'never') await never();
    else if (step.do === 'flood') await flood(step.parallel ?? 16);
    else if (step.do === 'exit') process.exit(step.code ?? 0);
    else if (step.do === 'forever') await forever();
  }
}

const exitCode = /^exit-(\d+)$/.exec(scenario);
const good = /^good-(\d+)$/.exec(scenario);
if (scenario === 'sleep' || scenario === 'silent') setInterval(() => {}, 1000);
else if (good !== null) {
  for (let index = 0; index < Number(good[1]); index += 1) { await modelRequest(); print({ stub: 'step' }); }
  writeReports();
  process.exit(0);
} else if (scenario === 'never') await never();
else if (scenario === 'flood') await flood(16);
else if (scenario === 'report-then-fail') {
  writeReports();
  for (let index = 0; index < 2; index += 1) { await modelRequest(); print({ stub: 'step' }); }
  process.exit(0);
} else if (scenario === 'dump') { await dump(); process.exit(0); }
else if (scenario === 'script') { await script(); process.exit(0); }
else process.exit(exitCode === null ? 0 : Number(exitCode[1]));
