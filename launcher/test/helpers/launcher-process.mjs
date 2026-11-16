// Starts the launcher as a process of its own (launcher-child.mjs) inside the topology of withContainerEnv, so that a test can signal or
// kill it. The launcher process's standard input is closed; its output is collected; its timeline is read from a file.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LAUNCHER } from './fixtures.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// context: from withContainerEnv; options: extraArgs (flags added to the launch), ownNetwork. Returns {child, pid, done, timeline(),
// until(predicate, ms)}; done resolves {code, signal, stdout, stderr}.
export function startLauncher(context, { extraArgs = [], ownNetwork = false } = {}) {
  const dir = fs.mkdtempSync(path.join(context.base, 'lp-'));
  const timeline = path.join(dir, 'timeline.jsonl');
  const specFile = path.join(dir, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify({
    argv: context.argv(extraArgs), env: { PATH: process.env.PATH, HOME: process.env.HOME, ACODER_MODEL_API_KEY: context.fx.key },
    testId: context.ids.id, network: context.network, ownNetwork, stubContainer: `stub-${context.ids.id}`, timeline,
  }));
  const child = spawn(process.execPath, [path.join(LAUNCHER, 'test/helpers/launcher-child.mjs'), specFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  const err = [];
  child.stdout.on('data', chunk => out.push(chunk));
  child.stderr.on('data', chunk => err.push(chunk));
  const done = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })));
  const read = () => (fs.existsSync(timeline) ? fs.readFileSync(timeline, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
  return {
    child, done, timeline: read,
    // Resolves true once predicate() holds (checked every 100 ms), false after ms.
    until: async (predicate, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (predicate()) return true; await wait(100); } return predicate(); },
  };
}
