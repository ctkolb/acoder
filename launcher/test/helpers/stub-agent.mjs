// The stub agent (A11): driven through the stub adapter, it runs as the agent process (`node stub-agent.mjs --dir <scratch> --model
// <scenario> --effort <e> <first message>`). It first writes the marker file `stub-agent-marker.json` into --dir with what it can see of
// its own start (environment names, process ids, bytes on standard input), then follows the scenario named by --model:
//   marker     exit 0 at once
//   exit-<n>   exit with code n
//   sleep      start a child that sleeps, and sleep (only a kill ends both)
// Part 2 of S4 adds the scenarios of A11 (good, never, silent, flood, dump, probe, report-then-fail).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const dir = option('--dir');
const scenario = option('--model') ?? 'marker';

let stdinBytes = 0;
const stdinDone = new Promise(resolve => {
  process.stdin.on('data', chunk => { stdinBytes += chunk.length; });
  process.stdin.on('end', resolve);
  process.stdin.on('error', resolve);
});
await stdinDone;
const marker = { pid: process.pid, ppid: process.ppid, env_names: Object.keys(process.env).sort(), stdin_bytes: stdinBytes, scenario, cwd: process.cwd(), argv_tail: args.at(-1) };
if (scenario === 'sleep') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  marker.child_pid = child.pid;
}
fs.writeFileSync(path.join(dir, 'stub-agent-marker.json'), `${JSON.stringify(marker)}\n`);
process.stdout.write(`${JSON.stringify({ stub: 'step' })}\n`);
const exitCode = /^exit-(\d+)$/.exec(scenario);
if (scenario === 'sleep') setInterval(() => {}, 1000);
else process.exit(exitCode === null ? 0 : Number(exitCode[1]));
