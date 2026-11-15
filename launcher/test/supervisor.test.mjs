import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { RELEASE_WAIT_MS, SUPERVISOR_REFUSAL_EXIT } from '../container/entry.mjs';
import { parseSupervisorLine } from '../lib/events.mjs';
import { fixtureBase, forceRemove, LAUNCHER } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; every wait inside a test has its own limit and
// fails on an assertion, and the supervisor process is killed in the cleanup whatever happened.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, fn);

const HELPER = path.join(LAUNCHER, 'test/helpers/entry-main.mjs');
const STUB = path.join(LAUNCHER, 'test/helpers/stub-agent.mjs');
const RUN_ID = '20261115T101500Z-a1b2c3';
const ENV_NAMES = ['ACODER_CONTAINER', 'ACODER_EVENT_PREFIX', 'ACODER_PROBE_INPUT', 'ACODER_RUN_ID', 'ACODER_TAG', 'ACODER_TICKET_SHA256', 'STUB_MARKER_VAR'];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// S4-AC6, the unit part: entry.mjs as a plain process. scenario: the stub agent's scenario; releaseWaitMs: the release wait seam.
async function withSupervisor({ scenario = 'marker', releaseWaitMs = 20000 } = {}, fn) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fixtureBase(), 'asv-')));
  const prefix = randomBytes(16).toString('hex');
  const scratch = path.join(base, 'scratch');
  fs.mkdirSync(scratch);
  const agentCommand = path.join(base, 'agent-command.json');
  fs.writeFileSync(agentCommand, JSON.stringify({ argv: [process.execPath, STUB, '--dir', scratch, '--model', scenario, '--effort', 'high', 'first message'] }));
  const env = {
    ACODER_CONTAINER: '1', ACODER_RUN_ID: RUN_ID, ACODER_TAG: 'x', ACODER_TICKET_SHA256: 'b'.repeat(64), ACODER_EVENT_PREFIX: prefix,
    ACODER_PROBE_INPUT: JSON.stringify({ env_names: ENV_NAMES, run_id: RUN_ID }), STUB_MARKER_VAR: 'marker-value', UNPLANNED_HOST_VAR: 'not passed on',
  };
  const child = spawn(process.execPath, [HELPER, JSON.stringify({ agentCommand, socketPath: path.join(base, 's'), releaseWaitMs })], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [];
  const other = [];
  let exit = null;
  let pending = '';
  let started = false;
  child.stdout.on('data', chunk => {
    pending += chunk.toString('utf8');
    for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const parsed = parseSupervisorLine(line, { prefix, agentStarted: started });
      if (parsed.kind === 'event') { events.push({ ...parsed.event, at: Date.now() }); if (parsed.event.event === 'agent_started') started = true; }
      else other.push(line);
    }
  });
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  const exited = new Promise(resolve => child.on('exit', (code, signal) => { exit = { code, signal }; resolve(exit); }));
  const markerFile = path.join(scratch, 'stub-agent-marker.json');
  const until = async (predicate, ms, what) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (predicate()) return; await wait(25); }
    assert.fail(`${what} within ${ms} ms`);
  };
  const ofKind = kind => events.filter(event => event.event === kind);
  const exitWithin = async ms => { await until(() => exit !== null, ms, 'the supervisor exited'); return exit; };
  const send = line => child.stdin.write(`${line}\n`);
  const marker = () => (fs.existsSync(markerFile) ? JSON.parse(fs.readFileSync(markerFile, 'utf8')) : null);
  try {
    await until(() => ofKind('probes').length === 1, 10000, 'the probes event');
    return await fn({ child, send, events, other, ofKind, until, exitWithin, marker, markerFile, exited, base });
  } finally {
    if (exit === null) child.kill('SIGKILL');
    const agent = marker();
    for (const pid of [agent?.pid, agent?.child_pid]) if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    forceRemove(base);
  }
}

t('supervisor: the relay starts before the probes; one probes event, and nothing is started before the release', async () => {
  await withSupervisor({}, async ({ ofKind, marker, events }) => {
    assert.deepEqual(ofKind('probes')[0].results, [{ id: 'P1', result: 'pass', detail: 'relay_listening' }]);
    await wait(300);
    assert.equal(marker(), null, 'no agent before the release');
    assert.deepEqual(events.map(event => event.event), ['probes']);
  });
});

t('supervisor: on CLOCK it replies with one clock sample; on the exact RELEASE line it starts the agent and reports released, agent_started and agent_exit', async () => {
  await withSupervisor({ scenario: 'exit-3' }, async ({ send, ofKind, until, exitWithin, marker, events }) => {
    const before = Date.now();
    send('CLOCK');
    await until(() => ofKind('clock').length === 1, 5000, 'the clock event');
    const sample = ofKind('clock')[0].clock_epoch_ms;
    assert.ok(sample >= before - 1000 && sample <= Date.now() + 1000, 'the sample is the supervisor clock in epoch milliseconds');
    assert.equal(marker(), null, 'no agent after CLOCK alone');
    send(`RELEASE ${RUN_ID} ${Date.now() + 60000}`);
    const exit = await exitWithin(10000);
    assert.deepEqual(exit, { code: 3, signal: null }, 'the supervisor exits with the agent\'s status');
    assert.deepEqual(events.map(event => event.event), ['probes', 'clock', 'released', 'agent_started', 'agent_exit']);
    assert.deepEqual(ofKind('agent_exit')[0], { event: 'agent_exit', code: 3, signal: null, at: ofKind('agent_exit')[0].at });
    const agent = marker();
    assert.equal(ofKind('agent_started')[0].pid, agent.pid);
  });
});

t('supervisor: the agent gets the constructed environment (the planned names only), standard input from the null device, and its own process group', async () => {
  await withSupervisor({ scenario: 'sleep' }, async ({ send, ofKind, until, marker, child }) => {
    send('CLOCK');
    await until(() => ofKind('clock').length === 1, 5000, 'the clock event');
    send(`RELEASE ${RUN_ID} ${Date.now() + 60000}`);
    await until(() => marker() !== null, 10000, 'the agent marker');
    const agent = marker();
    // macOS adds __CF_USER_TEXT_ENCODING to the environment of every program it starts; a Linux container has no such name.
    assert.deepEqual(agent.env_names.filter(name => name !== '__CF_USER_TEXT_ENCODING'), ENV_NAMES, 'exactly the planned names; nothing else is inherited');
    assert.equal(agent.stdin_bytes, 0, 'standard input is the null device (it ended at once with no byte)');
    const pgid = spawnSync('ps', ['-o', 'pgid=', '-p', String(agent.pid)], { encoding: 'utf8' }).stdout.trim();
    assert.equal(pgid, String(agent.pid), 'the agent leads its own process group');
    assert.notEqual(pgid, String(child.pid));
  });
});

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

t('supervisor: at the RELEASE deadline it prints deadline and kills the agent\'s whole process group', async () => {
  await withSupervisor({ scenario: 'sleep' }, async ({ send, ofKind, until, marker, exitWithin }) => {
    send('CLOCK');
    await until(() => ofKind('clock').length === 1, 5000, 'the clock event');
    send(`RELEASE ${RUN_ID} ${Date.now() + 1500}`);
    await until(() => marker() !== null, 10000, 'the agent marker');
    const agent = marker();
    const exit = await exitWithin(10000);
    assert.equal(ofKind('deadline').length, 1);
    assert.deepEqual(ofKind('agent_exit').map(event => [event.code, event.signal]), [[null, 'SIGKILL']]);
    assert.equal(exit.code, 137, 'a killed agent ends the supervisor with a failure status');
    await until(() => !alive(agent.pid) && !alive(agent.child_pid), 5000, 'the agent and its child are gone');
  });
});

t('supervisor: when its standard input ends after the release it kills the agent\'s process group and exits', async () => {
  await withSupervisor({ scenario: 'sleep' }, async ({ send, ofKind, until, marker, exitWithin, child }) => {
    send('CLOCK');
    await until(() => ofKind('clock').length === 1, 5000, 'the clock event');
    send(`RELEASE ${RUN_ID} ${Date.now() + 60000}`);
    await until(() => marker() !== null, 10000, 'the agent marker');
    const agent = marker();
    child.stdin.end();
    const exit = await exitWithin(10000);
    assert.notEqual(exit.code, 0);
    assert.equal(ofKind('deadline').length, 0);
    await until(() => !alive(agent.pid) && !alive(agent.child_pid), 5000, 'the agent and its child are gone');
  });
});

// Exit 78 without starting the agent: end of input, any other or out-of-order line, a bad RELEASE, and the release wait.
const refusal = (name, lines, { close = false, releaseWaitMs } = {}) => t(`supervisor: ${name}: exit 78 and the agent is never started`, async () => {
  await withSupervisor({ releaseWaitMs }, async ({ send, child, exitWithin, marker, ofKind }) => {
    for (const line of lines) { send(line); await wait(50); }
    if (close) child.stdin.end();
    const exit = await exitWithin(10000);
    assert.equal(exit.code, SUPERVISOR_REFUSAL_EXIT);
    assert.equal(exit.code, 78);
    await wait(300);
    assert.equal(marker(), null, 'the agent marker is absent');
    assert.equal(ofKind('agent_started').length, 0);
    assert.equal(ofKind('released').length, 0);
  });
});
refusal('end of input before CLOCK', [], { close: true });
refusal('end of input after CLOCK', ['CLOCK'], { close: true });
refusal('RELEASE before CLOCK', [`RELEASE ${RUN_ID} 99999999999999`]);
refusal('a second CLOCK', ['CLOCK', 'CLOCK']);
refusal('an unknown line', ['HELLO']);
refusal('an empty line', ['']);
refusal('RELEASE for another run', ['CLOCK', 'RELEASE 20261115T101500Z-ffffff 99999999999999']);
refusal('RELEASE with extra text', ['CLOCK', `RELEASE ${RUN_ID} 99999999999999 now`]);
refusal('a lower-case release', ['CLOCK', `release ${RUN_ID} 99999999999999`]);

t('supervisor: without a release it exits 78 when the release wait ends (the seam), and the production wait is 120 s', async () => {
  assert.equal(RELEASE_WAIT_MS, 120000);
  await withSupervisor({ releaseWaitMs: 600 }, async ({ send, exitWithin, marker }) => {
    send('CLOCK');
    const started = Date.now();
    const exit = await exitWithin(10000);
    assert.equal(exit.code, 78);
    assert.ok(Date.now() - started < 8000);
    assert.equal(marker(), null);
  });
});

// clock-events (R9-07, S4): the RELEASE deadline is an unsigned decimal safe integer; anything else is refused with exit 78.
for (const [what, deadline] of [['signed +', '+99999999999999'], ['signed -', '-1'], ['hexadecimal', '0x5af3107a3fff'], ['fractional', '99999999999999.5'], ['exponent', '1e14'], ['empty', ''], ['unsafe integer', '9007199254740993'], ['spaces inside', '9999 9999']]) {
  t(`clock-events: a ${what} RELEASE deadline is refused: exit 78, the agent marker stays absent`, async () => {
    await withSupervisor({}, async ({ send, ofKind, until, exitWithin, marker }) => {
      send('CLOCK');
      await until(() => ofKind('clock').length === 1, 5000, 'the clock event');
      send(`RELEASE ${RUN_ID} ${deadline}`);
      const exit = await exitWithin(10000);
      assert.equal(exit.code, 78);
      await wait(300);
      assert.equal(marker(), null, 'invalid input leaves the agent marker absent');
    });
  });
}

t('clock-events: the largest safe integer is a valid deadline (the boundary of the unsafe-integer refusal)', async () => {
  await withSupervisor({ scenario: 'marker' }, async ({ send, ofKind, until, exitWithin, marker }) => {
    send('CLOCK');
    await until(() => ofKind('clock').length === 1, 5000, 'the clock event');
    send(`RELEASE ${RUN_ID} ${Number.MAX_SAFE_INTEGER}`);
    const exit = await exitWithin(10000);
    assert.equal(exit.code, 0);
    assert.notEqual(marker(), null);
  });
});
