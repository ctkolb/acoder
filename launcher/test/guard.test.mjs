import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LAUNCH_ENABLED } from '../lib/enabled.mjs';
import { BIN, LAUNCHER, lastLine, listing, runMain, t, withFixture } from './helpers/fixtures.mjs';

const runBin = (fx, args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { env: { ...fx.env, ...env }, encoding: 'utf8', timeout: 20000 });
const GUARD_LINE = 'refused: this build of the launcher is incomplete; container launch is disabled';

// S2-AC19 (G9, SPEC-18).
t('guard: the production command refuses to launch while the build is incomplete', () => withFixture({}, async fx => {
  assert.equal(LAUNCH_ENABLED, false);
  const before = listing(fx.base);
  const result = runBin(fx, fx.argv({ drop: ['--dry-run'] }));
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr, `${GUARD_LINE}\n`);
  assert.equal(lastLine(result.stdout), `ACODER LAUNCH ${fx.tag} refused -`);
  assert.ok(!result.stdout.includes(fx.key) && !result.stderr.includes(fx.key));
  assert.deepEqual(listing(fx.base), before, 'the guard has no effect on the fixture tree');
  // No flag and no environment variable enables the launch.
  for (const env of [{ ACODER_LAUNCH_ENABLED: '1' }, { LAUNCH_ENABLED: 'true' }, { ACODER_TEST: '1', NODE_ENV: 'test' }]) {
    const again = runBin(fx, fx.argv({ drop: ['--dry-run'] }), env);
    assert.equal(again.status, 2);
    assert.equal(again.stderr, `${GUARD_LINE}\n`);
  }
  assert.deepEqual(listing(fx.base), before);
}));

t('guard: usage errors are reported before the guard, and --dry-run, export manifest work in production', () => withFixture({}, async fx => {
  const usage = runBin(fx, fx.argv({ drop: ['--dry-run', '--budget-calls'] }));
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /--budget-calls/);
  assert.equal(lastLine(usage.stdout), 'ACODER LAUNCH - refused -');
  const dry = runBin(fx, fx.argv());
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).tag, fx.tag);
}));

t('guard: with launchEnabled true the guard line is not printed (the guard is the constant); part 1 has no launch sequence', () => withFixture({}, async fx => {
  const before = listing(fx.base);
  const result = await runMain(fx.argv({ drop: ['--dry-run'] }), { env: fx.env, deps: { launchEnabled: true } });
  assert.equal(result.code, 2);
  assert.doesNotMatch(result.stderr, /incomplete; container launch is disabled/);
  assert.match(result.stderr, /^refused: .*launch sequence/);
  assert.equal(lastLine(result.stdout), `ACODER LAUNCH ${fx.tag} refused -`);
  assert.deepEqual(listing(fx.base), before, 'part 1 creates nothing in the mailbox and leaves no staging directory');
}));

t('seams: the production command passes no test seam', () => {
  const source = fs.readFileSync(BIN, 'utf8');
  const calls = source.match(/main\([^;]*\);/g);
  assert.deepEqual(calls, ['main(process.argv.slice(2), process.env, { adapters, providers, launchEnabled: LAUNCH_ENABLED });']);
  assert.match(source, /import \{ LAUNCH_ENABLED \} from '\.\.\/lib\/enabled\.mjs'/);
  const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]).sort();
  assert.deepEqual(imports, ['../lib/cli.mjs', '../lib/enabled.mjs', '../lib/registries.mjs']);
  const enabled = fs.readFileSync(path.join(LAUNCHER, 'lib', 'enabled.mjs'), 'utf8');
  assert.match(enabled, /^export const LAUNCH_ENABLED = false;$/m);
});

t('seams: the launcher library reads no process.env and imports only node: modules and its own files', () => {
  for (const name of fs.readdirSync(path.join(LAUNCHER, 'lib'))) {
    const source = fs.readFileSync(path.join(LAUNCHER, 'lib', name), 'utf8');
    assert.doesNotMatch(source, /process\.env/, `${name} reads process.env`);
    for (const [, specifier] of source.matchAll(/from '([^']+)'/g)) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'), `${name} imports ${specifier}`);
    }
  }
});

t('seams: an unknown subcommand or no argument is a usage error and a seam key in the environment changes nothing', () => withFixture({}, async fx => {
  for (const args of [[], ['review'], ['review', 'nope'], ['nope']]) {
    const result = runBin(fx, args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, /^refused: /);
  }
}));

t('guard: an unexpected internal failure is exit code 1 with the error last line, never a refusal', () => withFixture({}, async fx => {
  const result = await runMain(fx.argv(), { env: fx.env, deps: { adapters: undefined } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^error: /);
  assert.equal(result.stderr.trimEnd().split('\n').length, 1);
  assert.equal(lastLine(result.stdout), `ACODER LAUNCH ${fx.tag} error -`);
  assert.ok(!result.stderr.includes(fx.key) && !result.stdout.includes(fx.key));
}));
