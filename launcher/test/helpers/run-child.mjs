// The launcher's main() as a process of its own on the fake runtime (no container): argv[2] is a JSON file {argv, env, failVolume}. With
// failVolume the runtime seam refuses `volume create`, so the attempt ends not-started. When main() has resolved, the line `main returned`
// is printed; the test then measures how long the process stays alive (a timer left running keeps it alive, F-38-10).
import fs from 'node:fs';
import { adapters } from '../../adapters/index.mjs';
import { main } from '../../lib/cli.mjs';
import { providers } from '../../providers/index.mjs';
import * as stub from './stub-adapter.mjs';

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const runtime = real => ({
  ...real,
  call: async (args, extra) => (spec.failVolume && args[0] === 'volume' && args[1] === 'create' ? { code: 1, stdout: '', stderr: 'refused by the test' } : real.call(args, extra)),
});
process.exitCode = await main(spec.argv, spec.env, { adapters: { ...adapters, stub }, providers, launchEnabled: true, runtime });
process.stdout.write('main returned\n');
