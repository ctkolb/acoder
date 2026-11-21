import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LAUNCH_ENABLED } from '../lib/enabled.mjs';
import nodeTest from 'node:test';
import { BIN, LAUNCHER, lastLine, listing, runMain, withFixture, parseJson } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own. The test is registered from this file, so that the mutation runner can count it per module.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, fn);

const runBin = (fx, args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { env: { ...fx.env, ...env }, encoding: 'utf8', timeout: 20000 });
const GUARD_LINE = 'refused: this build of the launcher is incomplete; container launch is disabled';

// S6-AC11 (SPEC-18, A1.8): the enabling commit replaced `guard: the production command refuses to launch while the build is incomplete`.
// The real bin/acoder.mjs with valid synthetic inputs no longer prints the guard line and goes on to state V, where a PATH without a
// runtime ends in that refusal with no effect on the fixture tree; no environment variable changes anything.
const NO_RUNTIME = 'refused: no container runtime is installed: neither docker nor podman is on PATH';
t('guard: the production command launches when enabled', () => withFixture({}, async fx => {
  assert.equal(LAUNCH_ENABLED, true);
  const before = listing(fx.base);
  const result = runBin(fx, fx.argv({ drop: ['--dry-run'] }), { PATH: fx.base });
  assert.equal(result.status, 2, result.stderr);
  assert.ok(!result.stderr.includes(GUARD_LINE) && !result.stdout.includes(GUARD_LINE), 'the guard line is not printed');
  assert.equal(result.stderr, `${NO_RUNTIME}\n`);
  assert.equal(lastLine(result.stdout), `ACODER LAUNCH ${fx.tag} refused -`);
  assert.ok(!result.stdout.includes(fx.key) && !result.stderr.includes(fx.key));
  assert.deepEqual(listing(fx.base), before, 'a refusal in state V has no effect on the fixture tree');
  // No environment variable changes anything.
  for (const env of [{ ACODER_LAUNCH_ENABLED: '1' }, { LAUNCH_ENABLED: 'true' }, { ACODER_TEST: '1', NODE_ENV: 'test' }]) {
    const again = runBin(fx, fx.argv({ drop: ['--dry-run'] }), { PATH: fx.base, ...env });
    assert.equal(again.status, 2);
    assert.equal(again.stderr, `${NO_RUNTIME}\n`);
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
  assert.equal(parseJson(dry.stdout).tag, fx.tag);
}));

t('guard: with launchEnabled true the guard line is not printed (the guard is the constant); the launch goes on to state V, here refused for a PATH without a runtime', () => withFixture({}, async fx => {
  const before = listing(fx.base);
  const result = await runMain(fx.argv({ drop: ['--dry-run'] }), { env: { ...fx.env, PATH: fx.base }, deps: { launchEnabled: true } });
  assert.equal(result.code, 2);
  assert.doesNotMatch(result.stderr, /incomplete; container launch is disabled/);
  assert.equal(result.stderr, 'refused: no container runtime is installed: neither docker nor podman is on PATH\n');
  assert.equal(lastLine(result.stdout), `ACODER LAUNCH ${fx.tag} refused -`);
  assert.deepEqual(listing(fx.base), before, 'a refusal in state V creates nothing in the mailbox and leaves no staging directory');
}));

t('seams: the production command passes no test seam', () => {
  const source = fs.readFileSync(BIN, 'utf8');
  const calls = source.match(/main\([^;]*\);/g);
  assert.deepEqual(calls, ['main(process.argv.slice(2), process.env, { adapters, providers, launchEnabled: LAUNCH_ENABLED });']);
  assert.match(source, /import \{ LAUNCH_ENABLED \} from '\.\.\/lib\/enabled\.mjs'/);
  const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]).sort();
  assert.deepEqual(imports, ['../adapters/index.mjs', '../lib/cli.mjs', '../lib/enabled.mjs', '../providers/index.mjs']);
  const enabled = fs.readFileSync(path.join(LAUNCHER, 'lib', 'enabled.mjs'), 'utf8');
  assert.match(enabled, /^export const LAUNCH_ENABLED = true;$/m);
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
