// The supervisor of the agent container (A3.5, A3.6, S4-AC6). It starts the relay, runs the probes P1 to P8, prints one `probes` event,
// starts nothing, and reads standard input: exactly one CLOCK line (answered with a clock sample), then exactly the line
// `RELEASE <run_id> <deadline>`. Anything else, end of input, or no release within 120 s ends it with exit code 78 and no agent. After
// the release it starts the agent in its own process group with the constructed environment and standard input from the null device,
// kills that group at the deadline and when its own standard input ends, reports agent_exit and exits with the agent's status. Its event
// lines carry the per-run prefix of ACODER_EVENT_PREFIX. Imports only `node:` modules and its siblings.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { constants } from 'node:os';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { runProbes } from './probe.mjs';
import { RELAY_PORT, SOCKET_PATH, startRelay } from './relay.mjs';

export const SUPERVISOR_REFUSAL_EXIT = 78;
export const RELEASE_WAIT_MS = 120000;
const AGENT_COMMAND = '/acoder/agent-command.json';
const MAX_TIMER = 2147483647;
// An unsigned decimal integer; Number.isSafeInteger rejects the rest (A3.6).
const RELEASE_LINE = /^RELEASE (\S+) ([0-9]+)$/;

// options (test seams): env, input, output, paths {agentCommand, socket}, relayPort, releaseWaitMs, probes, now, exit.
export async function main({
  env = process.env, input = process.stdin, output = process.stdout, paths = {}, relayPort = RELAY_PORT, releaseWaitMs = RELEASE_WAIT_MS,
  probes = runProbes, now = Date.now, exit = code => process.exit(code),
} = {}) {
  const prefix = env.ACODER_EVENT_PREFIX;
  let ending = false;
  const finish = code => {
    if (ending) return;
    ending = true;
    output.write('', () => exit(code));
  };
  if (typeof prefix !== 'string' || !/^[0-9a-f]{32}$/.test(prefix)) return finish(SUPERVISOR_REFUSAL_EXIT);
  const emit = event => output.write(`${prefix} ${JSON.stringify(event)}\n`);
  let probeInput;
  try { probeInput = JSON.parse(env.ACODER_PROBE_INPUT); } catch { probeInput = null; }

  let state = 'probing';
  let agent = null;
  let deadlineTimer = null;
  const refuse = () => { if (state !== 'released') { state = 'refused'; finish(SUPERVISOR_REFUSAL_EXIT); } };
  const killGroup = () => { if (agent !== null && agent.exitCode === null && agent.signalCode === null) { try { process.kill(-agent.pid, 'SIGKILL'); } catch { /* already gone */ } } };

  // Lines are read from the start: a line that arrives during the probes is out of order.
  const lines = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  const waitTimer = setTimeout(refuse, releaseWaitMs);

  function release(deadline) {
    state = 'released';
    clearTimeout(waitTimer);
    emit({ event: 'released' });
    let command;
    try { command = JSON.parse(fs.readFileSync(paths.agentCommand ?? AGENT_COMMAND, 'utf8')); } catch { command = null; }
    if (!Array.isArray(command?.argv) || command.argv.length === 0 || !command.argv.every(item => typeof item === 'string')) return finish(1);
    // The constructed environment: the planned names only (A8.3), nothing else of this process.
    const agentEnv = {};
    for (const name of probeInput?.env_names ?? []) if (env[name] !== undefined) agentEnv[name] = env[name];
    agent = spawn(command.argv[0], command.argv.slice(1), { env: agentEnv, stdio: ['ignore', 'inherit', 'inherit'], detached: true });
    agent.on('error', () => { emit({ event: 'agent_exit', code: null, signal: null }); finish(1); });
    agent.on('spawn', () => emit({ event: 'agent_started', pid: agent.pid }));
    agent.on('exit', (code, signal) => {
      clearTimeout(deadlineTimer);
      emit({ event: 'agent_exit', code, signal });
      finish(code ?? 128 + (constants.signals[signal] ?? 0));
    });
    const arm = () => {
      const left = deadline - now();
      if (left <= 0) { emit({ event: 'deadline' }); killGroup(); return; }
      deadlineTimer = setTimeout(arm, Math.min(left, MAX_TIMER));
    };
    arm();
  }

  lines.on('line', line => {
    if (state === 'probing' || state === 'refused') return refuse();
    if (state === 'clock') {
      if (line !== 'CLOCK') return refuse();
      state = 'release';
      return emit({ event: 'clock', clock_epoch_ms: now() });
    }
    if (state === 'release') {
      const match = RELEASE_LINE.exec(line);
      const deadline = match === null ? Number.NaN : Number(match[2]);
      if (match === null || match[1] !== env.ACODER_RUN_ID || !Number.isSafeInteger(deadline)) return refuse();
      return release(deadline);
    }
    return undefined;
  });
  lines.on('close', () => { if (state === 'released') killGroup(); else refuse(); });

  let relay;
  try { relay = await startRelay({ port: relayPort, socketPath: paths.socket ?? SOCKET_PATH }); } catch { return refuse(); }
  let results;
  try { results = await probes(probeInput ?? {}, { relayPort: relay.port }); } catch { results = null; }
  if (state === 'refused') return undefined;
  if (!Array.isArray(results)) return refuse();
  emit({ event: 'probes', results });
  state = 'clock';
  return undefined;
}

const invoked = () => { try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; } };
if (invoked()) main();
