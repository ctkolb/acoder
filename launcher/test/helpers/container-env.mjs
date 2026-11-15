// The gate of the container tests (A11, S4-AC17) and the tests' own runtime calls. A container test runs only when a runtime answers
// and ACODER_TEST_IMAGE holds an image in one of the two accepted forms; otherwise it is skipped with the reason. Every resource a test
// creates carries `acoder.test=<id>` (removed by `npm run test:container:cleanup`) and `acoder.run=<id>`. Every call is an argument
// array (no shell), and nothing here pulls, builds or pushes.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const IMAGE = /^(?:[^\s@]+@)?sha256:[0-9a-f]{64}$/;
export const TEST_LABEL_KEY = 'acoder.test';

// The runtime the container tests use: docker when it is on PATH, else podman; null when neither is installed.
export function testRuntime(env = process.env, exists = file => fs.existsSync(file)) {
  for (const name of ['docker', 'podman']) {
    for (const dir of String(env.PATH ?? '').split(':').filter(Boolean)) if (exists(path.join(dir, name))) return name;
  }
  return null;
}

// The skip reason of every container test, or false when it can run. `answers(runtime)` asks the daemon (seam for dod12-skip).
export function containerSkipReason(env = process.env, { runtime = testRuntime(env), answers = defaultAnswers } = {}) {
  if (typeof env.ACODER_TEST_IMAGE !== 'string' || env.ACODER_TEST_IMAGE === '') return 'ACODER_TEST_IMAGE is not set';
  if (!IMAGE.test(env.ACODER_TEST_IMAGE)) return 'ACODER_TEST_IMAGE is not <name>@sha256:<64 hex> or sha256:<64 hex>';
  if (runtime === null) return 'no container runtime (docker or podman) is installed';
  if (!answers(runtime)) return `the ${runtime} daemon does not answer`;
  return false;
}

function defaultAnswers(runtime) {
  const result = spawnSync(runtime, ['version', '--format', '{{json .Server}}'], { encoding: 'utf8', timeout: 15000 });
  return result.status === 0 && result.stdout.trim() !== '' && result.stdout.trim() !== 'null';
}

let cached;
// Computed once per test file: the skip option of every container test.
export const SKIP = (cached ??= containerSkipReason());
export const IMAGE_ID = () => process.env.ACODER_TEST_IMAGE;
export const RUNTIME = () => testRuntime();

// One runtime call; resolves {code, stdout, stderr}. A call that does not end within `timeoutMs` is killed and resolves code null.
export function docker(args, { input = null, timeoutMs = 60000, env = process.env } = {}) {
  if (!Array.isArray(args) || !args.every(item => typeof item === 'string')) throw new TypeError('a runtime call is an argument array');
  return new Promise(resolve => {
    const child = spawn(RUNTIME(), args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, env });
    const out = [];
    const err = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, stdout: '', stderr: String(error.message) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }); });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

// A fresh test id and the label arguments of every resource the test creates.
export function testIds() {
  const id = `t${randomBytes(6).toString('hex')}`;
  return { id, labels: ['--label', `${TEST_LABEL_KEY}=${id}`, '--label', `acoder.run=${id}`], filter: `label=${TEST_LABEL_KEY}=${id}` };
}

// Every container, volume and network that carries the test label `filter` (`label=acoder.test=<id>` or `label=acoder.test`).
export async function listLabelled(filter) {
  const names = async args => (await docker(args)).stdout.split('\n').map(line => line.trim()).filter(Boolean);
  return {
    containers: await names(['ps', '--all', '--quiet', '--filter', filter]),
    volumes: await names(['volume', 'ls', '--quiet', '--filter', filter]),
    networks: await names(['network', 'ls', '--quiet', '--filter', filter]),
  };
}

// Removes them, containers first; resolves what was still there afterwards (empty lists when all are gone).
export async function removeLabelled(filter) {
  const found = await listLabelled(filter);
  if (found.containers.length > 0) await docker(['rm', '--force', '--volumes', ...found.containers]);
  if (found.volumes.length > 0) await docker(['volume', 'rm', '--force', ...found.volumes]);
  if (found.networks.length > 0) await docker(['network', 'rm', ...found.networks]);
  return listLabelled(filter);
}
