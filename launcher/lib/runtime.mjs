// The docker and podman command wrapper (A1.5, A3, S4-AC1). Every call is an argument array given to the runtime program without a
// shell; every created resource carries the label `acoder.run=<run_id>`; the base environment never holds the key, which only the call
// that creates the sidecar gets, in that one process's environment (A8.2). A missing runtime or a daemon that does not answer is a refusal.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Refusal } from './refusal.mjs';

export const RUNTIME_NAMES = ['docker', 'podman'];
export const RUN_LABEL_KEY = 'acoder.run';
const KEY_ENV = 'ACODER_UPSTREAM_KEY';
const CALL_TIMEOUT_MS = 120000;
const ANSWER_TIMEOUT_MS = 20000;

// The fields of `container inspect` the gate reads (H1 to H3), as one JSON object; Config.Env is reduced to the variable names. A Config field
// the runtime leaves out is read with `index`, which gives null instead of a template error.
export const CONTAINER_FORMAT = '{"Id":{{json .Id}},"State":{{json .State.Status}},"HostConfig":{{json .HostConfig}},"Mounts":{{json .Mounts}},'
  + '"Networks":{{json .NetworkSettings.Networks}},"Path":{{json .Path}},"Args":{{json .Args}},"Config":{"User":{{json (index .Config "User")}},'
  + '"Entrypoint":{{json (index .Config "Entrypoint")}},"Cmd":{{json (index .Config "Cmd")}},"WorkingDir":{{json (index .Config "WorkingDir")}},"Labels":{{json (index .Config "Labels")}},'
  + '"Healthcheck":{{json (index .Config "Healthcheck")}},"EnvNames":[{{range $i, $e := .Config.Env}}{{if $i}},{{end}}{{json (index (split $e "=") 0)}}{{end}}]}}';

const executable = file => {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
};
const onPath = (name, env) => String(env.PATH ?? '').split(':').filter(dir => dir.startsWith('/')).map(dir => path.join(dir, name)).find(executable) ?? null;

// A1.5 `--runtime`: the requested runtime must be on PATH; without it, docker when it is on PATH, else podman.
export function findRuntime(requested, env) {
  if (requested !== null && requested !== undefined) {
    if (!RUNTIME_NAMES.includes(requested)) throw new Refusal('the container runtime must be docker or podman');
    const bin = onPath(requested, env);
    if (bin === null) throw new Refusal(`the container runtime ${requested} is not installed (not on PATH)`);
    return { name: requested, bin };
  }
  for (const name of RUNTIME_NAMES) {
    const bin = onPath(name, env);
    if (bin !== null) return { name, bin };
  }
  throw new Refusal('no container runtime is installed: neither docker nor podman is on PATH');
}

const CREATES = args => args[0] === 'create' || args[0] === 'run' || (['network', 'volume', 'container'].includes(args[0]) && ['create', 'run'].includes(args[1]));

// S4-AC1: an argument array of strings without NUL bytes; a creating call carries `--label acoder.run=<run_id>` as two arguments.
export function checkCall(args, runId) {
  if (!Array.isArray(args) || args.length === 0 || !args.every(item => typeof item === 'string' && !item.includes('\0'))) {
    throw new TypeError('a runtime call is a non-empty argument array of strings without NUL bytes');
  }
  if (CREATES(args) && !args.some((item, index) => item === '--label' && args[index + 1] === `${RUN_LABEL_KEY}=${runId}`)) {
    throw new Error(`a created runtime resource must carry the label ${RUN_LABEL_KEY}=${runId}`);
  }
}

// A6.7 (R37-03, F-40-02): the removal of labelled resources and its verification, shared by the run's cleanup and `review cleanup`.
// labelledRemover(call, runId) gives remove(kind, name), which resolves true when the resource may remain (a leftover) and false when it is
// gone. A removal that exits 0 is gone. After a failed removal, ONE listing scoped to the kind and to `label=acoder.run=<runId>` decides:
// only a SUCCESSFUL listing that prints name-shaped lines only and lacks the name shows it gone; a listing that fails (non-zero exit,
// timeout) or prints something that is not a list of names leaves the resource unconfirmed. The removal is never retried.
const LISTINGS = { container: ['ps', '--all', '{{.Names}}'], volume: ['volume', 'ls', '{{.Name}}'], network: ['network', 'ls', '{{.Name}}'] };
const REMOVALS = { container: name => ['rm', '--force', name], volume: name => ['volume', 'rm', '--force', name], network: name => ['network', 'rm', name] };
export function labelledRemover(call, runId) {
  const label = `${RUN_LABEL_KEY}=${runId}`;
  async function mayRemain(kind, resource) {
    const [command, sub, format] = LISTINGS[kind];
    const result = await call([command, sub, '--filter', `label=${label}`, '--format', format], { timeoutMs: ANSWER_TIMEOUT_MS });
    const lines = result.stdout.split('\n').map(line => line.trim()).filter(line => line !== '');
    if (result.code !== 0 || !lines.every(line => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(line))) return true;
    return lines.includes(resource);
  }
  async function removeOne(kind, args, resource) {
    const result = await call(args);
    return result.code !== 0 && await mayRemain(kind, resource);
  }
  return (kind, resource) => {
    if (!Object.hasOwn(REMOVALS, kind)) throw new TypeError(`unknown resource kind ${kind}`);
    return removeOne(kind, REMOVALS[kind](resource), resource);
  };
}

// name, bin: from findRuntime; env: the base environment of every call (the host environment without the key variable); runId: the
// label value. deps.spawn is the process seam of the unit tests.
export function createRuntime({ name, bin, env, runId, deps = {} }) {
  if (Object.hasOwn(env, KEY_ENV)) throw new Error(`the base environment of the runtime must not hold ${KEY_ENV}`);
  const start = deps.spawn ?? spawn;
  const label = `${RUN_LABEL_KEY}=${runId}`;

  // One call; resolves {code, stdout, stderr}. A call that does not end within timeoutMs is killed and resolves with code null.
  function call(args, { input = null, extraEnv = {}, timeoutMs = CALL_TIMEOUT_MS } = {}) {
    try { checkCall(args, runId); } catch (error) { return Promise.reject(error); }
    return new Promise(resolve => {
      const child = start(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: { ...env, ...extraEnv } });
      const out = [];
      const err = [];
      let settled = false;
      const done = code => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); done(null); }, timeoutMs);
      child.stdout.on('data', chunk => out.push(chunk));
      child.stderr.on('data', chunk => err.push(chunk));
      child.stdin.on('error', () => {});
      child.on('error', () => done(null));
      child.on('close', code => done(code));
      child.stdin.end(input ?? undefined);
    });
  }

  // A long-running attached call (`start --attach --interactive <name>`, A3.5): the child process, whose standard input is the control
  // channel and whose standard output carries the event lines.
  function attach(container, { extraEnv = {} } = {}) {
    const args = ['start', '--attach', '--interactive', container];
    checkCall(args, runId);
    return start(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: { ...env, ...extraEnv } });
  }

  const json = text => { try { return JSON.parse(text); } catch { return undefined; } };

  // The daemon must answer `version`; the versions go to the record's runtime block.
  async function answers() {
    const result = await call(['version', '--format', '{{json .}}'], { timeoutMs: ANSWER_TIMEOUT_MS });
    const parsed = json(result.stdout);
    const server = parsed?.Server;
    if (result.code !== 0 || server === null || typeof server !== 'object' || typeof server.Version !== 'string') throw new Refusal(`the ${name} daemon does not answer`);
    return { name, client_version: String(parsed.Client?.Version ?? ''), server_version: server.Version };
  }

  // `image inspect` of the local image only (nothing is pulled); the parsed answer, or a refusal when the image is not on the host.
  async function imageInspect(ref) {
    const result = await call(['image', 'inspect', ref], { timeoutMs: ANSWER_TIMEOUT_MS });
    if (result.code !== 0) throw new Refusal('the image is not on this host (image inspect found nothing; nothing is pulled)');
    const parsed = json(result.stdout);
    return parsed === undefined ? null : parsed;
  }

  // `<kind> inspect <name>` for container, volume and network; the single parsed object, or null when it does not exist or is not one.
  // A container is inspected through CONTAINER_FORMAT, which prints the environment NAMES only (A8.4, RA9b): the sidecar's configuration
  // holds the key, and the launcher never reads a value back.
  async function inspect(kind, resource) {
    const args = kind === 'container' ? [kind, 'inspect', '--format', CONTAINER_FORMAT, resource] : [kind, 'inspect', resource];
    const result = await call(args, { timeoutMs: ANSWER_TIMEOUT_MS });
    const parsed = result.code === 0 ? json(result.stdout) : undefined;
    if (kind === 'container') return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    return Array.isArray(parsed) && parsed.length === 1 && parsed[0] !== null && typeof parsed[0] === 'object' ? parsed[0] : null;
  }

  // A6.7: removes the run's containers, then the volume, then the network (each only when named); resolves the names that remain or whose
  // absence could not be confirmed.
  async function remove({ containers = [], volume = null, network = null }) {
    const removeLabelled = labelledRemover(call, runId);
    const leftovers = [];
    for (const container of containers) if (await removeLabelled('container', container)) leftovers.push(container);
    if (volume !== null && await removeLabelled('volume', volume)) leftovers.push(volume);
    if (network !== null && await removeLabelled('network', network)) leftovers.push(network);
    return leftovers;
  }

  return { name, bin, label, runId, call, attach, answers, imageInspect, inspect, remove };
}
