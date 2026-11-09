import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkCommit, parseUpdates, prePush, privateArtifact, scanSecrets } from './pre-push.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const zero = '0'.repeat(40);
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const update = (tip, base = zero, ref = 'refs/heads/test') => `${ref} ${tip} ${ref} ${base}\n`;

async function repository(t) {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'acoder-hook-test-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, 'init', '--quiet');
  git(repo, 'config', 'user.name', 'Synthetic Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.hooksPath', '.disabled-hooks');
  await writeFile(path.join(repo, 'README.md'), '# Synthetic fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'base');
  return { repo, base: git(repo, 'rev-parse', 'HEAD') };
}

async function commit(repo, file, text) {
  await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
  await writeFile(path.join(repo, file), text);
  git(repo, 'add', '--', file);
  git(repo, 'commit', '--quiet', '-m', 'synthetic change');
  return git(repo, 'rev-parse', 'HEAD');
}

test('hook input supports multiple refs and rejects malformed object IDs', () => {
  assert.equal(parseUpdates(update('1'.repeat(40)) + update('2'.repeat(40))).length, 2);
  assert.deepEqual(parseUpdates(''), []);
  assert.throws(() => parseUpdates('refs/heads/x nope refs/heads/x nope'), /object ID/);
});

test('new refs scan full history; deletions do no work; shared tips are checked once', async t => {
  const { repo, base } = await repository(t);
  const scans = [], checks = [];
  const options = { scan: async (_, range) => scans.push(range), check: async (_, tip) => checks.push(tip) };
  await prePush(repo, update(zero, base), options);
  assert.deepEqual(scans, []);
  assert.deepEqual(checks, []);
  await prePush(repo, update(base) + update(base, zero, 'refs/heads/other'), options);
  assert.deepEqual(scans, [base, base]);
  assert.deepEqual(checks, [base]);
});

test('existing and force-updated refs use advertised remote IDs; annotated tags peel to commits', async t => {
  const { repo, base } = await repository(t);
  const tip = await commit(repo, 'change.txt', 'safe\n');
  const scans = [], checks = [];
  const options = { scan: async (_, range) => scans.push(range), check: async (_, value) => checks.push(value) };
  await prePush(repo, update(tip, base), options);
  assert.deepEqual(scans, [`${base}..${tip}`]);
  await prePush(repo, update(base, tip), options); // Rollback has no newly reachable commits.
  assert.deepEqual(checks, [tip, base]);
  git(repo, 'tag', '-a', 'v1', '-m', 'synthetic tag');
  const tag = git(repo, 'rev-parse', 'refs/tags/v1');
  await prePush(repo, update(tag, zero, 'refs/tags/v1'), options);
  assert.equal(checks.at(-1), tip);
  await assert.rejects(prePush(repo, update(tip, 'f'.repeat(40)), options), /fetch the remote/);
});

test('new branches exclude known remote history, including old whitespace defects', async t => {
  const { repo } = await repository(t);
  const published = await commit(repo, 'old.txt', 'published trailing space \n');
  git(repo, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
  git(repo, 'update-ref', 'refs/remotes/origin/main', published);
  const tip = await commit(repo, 'change.txt', 'safe\n');
  const scans = [];
  await prePush(repo, update(tip), {
    remoteName: 'origin', scan: async (_, range) => scans.push(range), check: async () => {},
  });
  assert.deepEqual(scans, [`${tip} --not ${published}`]);
});

test('whitespace and conflict markers in intermediate commits cannot be hidden by a later fix', async t => {
  const { repo, base } = await repository(t);
  const options = { scan: async () => {}, check: async () => assert.fail('checks must not run') };
  await commit(repo, 'change.txt', 'bad trailing space \n');
  const fixed = await commit(repo, 'change.txt', 'fixed\n');
  await assert.rejects(prePush(repo, update(fixed, base), options), /whitespace errors/);
  git(repo, 'checkout', '--quiet', '--detach', base);
  const conflict = await commit(repo, 'conflict.txt', '<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\n');
  await assert.rejects(prePush(repo, update(conflict, base), options), /conflict markers/);
});

test('private artifact checks preserve placeholders and detect copied data inside examples', () => {
  assert.equal(privateArtifact('examples/report-demo-S1.json', '"path": "<scratch>/log.txt"'), null);
  assert.equal(privateArtifact('.env.example', 'KEY=<placeholder>'), null);
  for (const file of ['.env', 'dir/.env.production', 'mailbox/log.md', 'scratch/file', 'checkouts/file', '.aws/credentials', 'project-config.md', 'report-real.json']) {
    assert.ok(privateArtifact(file, ''), file);
  }
  assert.ok(privateArtifact('examples/report-demo-S1.json', '/Users/' + 'synthetic/private/file'));
  assert.ok(privateArtifact('innocent.md', 'Repository: ' + '/srv/private/project'));
});

test('private artifacts removed before the tip still block the push', async t => {
  const { repo, base } = await repository(t);
  await commit(repo, 'project-config.md', 'private run configuration\n');
  git(repo, 'rm', '--quiet', 'project-config.md');
  git(repo, 'commit', '--quiet', '-m', 'remove private configuration');
  const tip = git(repo, 'rev-parse', 'HEAD');
  await assert.rejects(prePush(repo, update(tip, base), { scan: async () => {}, check: async () => {} }), /private artifact path/);
});

test('checks execute committed scripts, not an uncommitted replacement', async t => {
  const { repo } = await repository(t);
  const lock = { name: 'snapshot-test', lockfileVersion: 3, packages: { '': { name: 'snapshot-test' } } };
  await commit(repo, 'package-lock.json', JSON.stringify(lock));
  const tip = await commit(repo, 'package.json', JSON.stringify({ name: 'snapshot-test', scripts: { check: 'node -e "process.exit(23)"' } }));
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'snapshot-test', scripts: { check: 'node -e "process.exit(0)"' } }));
  await assert.rejects(checkCommit(repo, tip), error => error.status === 23);
  const workingCopy = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
  assert.match(workingCopy.scripts.check, /exit\(0\)/);
});

const hasGitleaks = spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).status === 0;
test('Gitleaks rejects a secret committed then removed, without printing its value', { skip: !hasGitleaks }, async t => {
  const { repo, base } = await repository(t);
  const token = 'ghp' + '_' + 'aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY3zA5';
  await commit(repo, 'credential.txt', `token=${token}\n`);
  const tip = await commit(repo, 'credential.txt', 'removed\n');
  await assert.rejects(scanSecrets(repo, `${base}..${tip}`), error => {
    assert.match(error.message, /Secret scan failed/);
    assert.ok(!error.message.includes(token));
    return true;
  });
  await scanSecrets(repo, base);
});

test('installer preserves custom hook configuration', async t => {
  const { repo } = await repository(t);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/install-hooks.mjs')], { cwd: repo, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(git(repo, 'config', '--get', 'core.hooksPath'), '.disabled-hooks');
  git(repo, 'config', '--unset', 'core.hooksPath');
  await mkdir(path.join(repo, '.git/hooks'), { recursive: true });
  await writeFile(path.join(repo, '.git/hooks/pre-push'), '#!/bin/sh\nexit 0\n');
  const legacy = spawnSync(process.execPath, [path.join(root, 'scripts/install-hooks.mjs')], { cwd: repo, encoding: 'utf8' });
  assert.notEqual(legacy.status, 0);
  await rm(path.join(repo, '.git/hooks/pre-push'));
  await cp(path.join(root, '.githooks'), path.join(repo, '.githooks'), { recursive: true });
  execFileSync(process.execPath, [path.join(root, 'scripts/install-hooks.mjs')], { cwd: repo, stdio: 'pipe' });
  assert.equal(git(repo, 'config', '--get', 'core.hooksPath'), '.githooks');
});
