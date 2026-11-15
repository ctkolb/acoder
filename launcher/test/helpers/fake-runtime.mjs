// A fake `docker` executable for the unit tests of the runtime wrapper: a real program on a test PATH (no shell, no daemon). It appends
// one JSON line per call to $FAKE_LOG ({argv, env_names, key_present}) and answers by $FAKE_MODE: `down` makes `version` fail like a
// daemon that does not answer; `image inspect` prints the file $FAKE_IMAGE or fails like a missing image; everything else prints `ok`.
import fs from 'node:fs';
import path from 'node:path';
import { fixtureBase, forceRemove } from './fixtures.mjs';

const PROGRAM = `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, env_names: Object.keys(process.env).sort(), key_present: 'ACODER_UPSTREAM_KEY' in process.env }) + '\\n');
if (argv[0] === 'version') {
  if (process.env.FAKE_MODE === 'down') { process.stdout.write('{"Client":{"Version":"29.0.0"},"Server":null}\\n'); process.stderr.write('Cannot connect to the daemon\\n'); process.exit(1); }
  process.stdout.write('{"Client":{"Version":"29.0.0"},"Server":{"Version":"29.0.1","Os":"linux","Arch":"arm64"}}\\n');
  process.exit(0);
}
if (argv[0] === 'image' && argv[1] === 'inspect') {
  if (process.env.FAKE_IMAGE && fs.existsSync(process.env.FAKE_IMAGE)) { process.stdout.write(fs.readFileSync(process.env.FAKE_IMAGE)); process.exit(0); }
  process.stdout.write('[]\\n'); process.stderr.write('Error: No such image\\n'); process.exit(1);
}
if (process.env.FAKE_MODE === 'hang') setInterval(() => {}, 1000);
else process.stdout.write('ok\\n');
`;

// names: the executables to create (docker, podman). Returns {dir, bin(name), env(extra), calls(), setImage(answer), cleanup()}.
export function makeFakeRuntime(names = ['docker']) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(fixtureBase(), 'afr-')));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const name of names) {
    fs.writeFileSync(path.join(bin, name), PROGRAM);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  const log = path.join(dir, 'calls.jsonl');
  const image = path.join(dir, 'image.json');
  return {
    dir, binDir: bin, bin: name => path.join(bin, name),
    env: (extra = {}) => ({ PATH: bin, FAKE_LOG: log, FAKE_IMAGE: image, ...extra }),
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []),
    setImage: answer => fs.writeFileSync(image, typeof answer === 'string' ? answer : JSON.stringify(answer)),
    cleanup: () => forceRemove(dir),
  };
}

export const IMAGE_ID = `sha256:${'d'.repeat(64)}`;
// An `image inspect` answer like the reference image's: id, no repository digest, the environment names of node:22-alpine.
export const imageAnswer = (over = {}) => [{
  Id: IMAGE_ID, RepoDigests: [], Architecture: 'arm64', Os: 'linux',
  Config: { Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_VERSION=22.23.5', 'YARN_VERSION=1.22.22'], Entrypoint: ['docker-entrypoint.sh'], Cmd: ['node'], ...over.Config },
  ...Object.fromEntries(Object.entries(over).filter(([key]) => key !== 'Config')),
}];
