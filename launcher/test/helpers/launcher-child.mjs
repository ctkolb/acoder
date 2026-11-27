// The launcher as a process of its own, for the container tests that signal or kill it (S4-AC13 dod5-launcher-killed, S4-AC14
// interrupted, spec09-faults). It calls the one main() with flags only and the test seams of runReview (the stub adapter, EXT, the
// runtime seam); argv[2] is a JSON file: {argv, env, testId, network, ownNetwork, stubContainer, timeline}. The runtime seam labels every
// creating call with the test label and appends the timeline (control lines, summary receipt, runtime calls) to the timeline file as JSON
// lines, so the test can read it after this process is gone. With ownNetwork the launcher creates EXT itself; it is made --internal and the
// stub endpoint is connected to it under its alias, and the inspect answer of EXT leaves the stub endpoint out so that H4 passes.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { adapters } from '../../adapters/index.mjs';
import { main } from '../../lib/cli.mjs';
import { providers } from '../../providers/index.mjs';
import * as stub from './stub-adapter.mjs';

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const note = entry => fs.appendFileSync(spec.timeline, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
const label = args => {
  const at = args[0] === 'create' || args[0] === 'run' ? 1 : (['volume', 'network'].includes(args[0]) && args[1] === 'create') ? 2 : -1;
  return at < 0 ? args : [...args.slice(0, at), '--label', `acoder.test=${spec.testId}`, ...args.slice(at)];
};
const internal = args => (args[0] === 'network' && args[1] === 'create' && spec.ownNetwork ? [args[0], args[1], '--internal', ...args.slice(2)] : args);

const runtime = real => ({
  ...real,
  call: async (args, extra) => {
    note({ kind: 'call', args });
    const result = await real.call(internal(label(args)), extra);
    if (spec.ownNetwork && args[0] === 'network' && args[1] === 'create' && result.code === 0) {
      const joined = spawnSync(real.bin, ['network', 'connect', '--alias', 'model.stub.test', args.at(-1), spec.stubContainer], { encoding: 'utf8' });
      note({ kind: 'stub-connected', code: joined.status });
    }
    return result;
  },
  attach: (name, extra) => {
    const child = real.attach(name, extra);
    const to = name.startsWith('acoder-agent-') ? 'agent' : 'sidecar';
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, ...rest) => { note({ kind: 'control', to, line: String(chunk).trim() }); return write(chunk, ...rest); };
    let pending = '';
    child.stdout.on('data', chunk => {
      pending += String(chunk);
      for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        if (to === 'sidecar' && /^\{"event":"(summary|limit)"/.test(line)) note({ kind: JSON.parse(line).event, to, line });
        if (to === 'agent' && line.includes('"event":"released"')) note({ kind: 'released', to });
      }
    });
    return child;
  },
  inspect: async (kind, name) => {
    const info = await real.inspect(kind, name);
    if (spec.ownNetwork && kind === 'network' && info !== null) {
      for (const [id, entry] of Object.entries(info.Containers ?? {})) if (entry?.Name === spec.stubContainer) delete info.Containers[id];
    }
    return info;
  },
});

note({ kind: 'pid', pid: process.pid });
process.exitCode = await main(['review', 'run', ...spec.argv], spec.env, {
  adapters: { ...adapters, stub }, providers, launchEnabled: true, egressNetwork: spec.ownNetwork ? undefined : spec.network, runtime,
});
