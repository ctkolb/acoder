import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { scanStaged } from './pre-push.mjs';
import { scanRepository } from './scan.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function repository(t) {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'acoder-scan-test-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, 'init', '--quiet');
  git(repo, 'config', 'user.name', 'Synthetic Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(repo, 'README.md'), '# Synthetic fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'base');
  return repo;
}

async function commit(repo, file, text) {
  await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
  await writeFile(path.join(repo, file), text);
  git(repo, 'add', '--', file);
  git(repo, 'commit', '--quiet', '-m', 'synthetic change');
}

test('repository scan covers history from the tip and rejects private artifacts in the tip tree', async t => {
  const repo = await repository(t);
  const scanned = [];
  const scan = async (_root, range) => { scanned.push(range); };
  await scanRepository(repo, { scan });
  assert.deepEqual(scanned, [git(repo, 'rev-parse', 'HEAD')]);
  await commit(repo, '.env', 'SYNTHETIC=1\n');
  await assert.rejects(scanRepository(repo, { scan }), /private artifact path/);
  await commit(repo, 'notes.md', `Saved under ${'/Users'}/someone/work/\n`);
  git(repo, 'rm', '--quiet', '.env');
  git(repo, 'commit', '--quiet', '-m', 'remove env');
  await assert.rejects(scanRepository(repo, { scan }), /machine-specific path/);
});

test('repository scan fails when the scanner fails', async t => {
  const repo = await repository(t);
  await assert.rejects(scanRepository(repo, { scan: async () => { throw new Error('Secret scan failed'); } }), /Secret scan failed/);
});

test('.gitignore covers environment files and credential material', () => {
  for (const file of ['.env', '.env.local', 'a/.env.prod', 'id.pem', 'x/server.key', '.aws/credentials', '.ssh/id_ed25519']) {
    const result = spawnSync('git', ['-C', root, 'check-ignore', '--quiet', '--no-index', file]);
    assert.equal(result.status, 0, `${file} should be ignored`);
  }
  assert.equal(spawnSync('git', ['-C', root, 'check-ignore', '--quiet', '--no-index', '.env.example']).status, 1);
});

const hasGitleaks = spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).status === 0;
test('staged scan rejects a staged secret without printing it, and passes clean changes', { skip: !hasGitleaks }, async t => {
  const repo = await repository(t);
  await scanStaged(repo);
  const token = 'ghp' + '_' + 'aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY3zA5';
  await writeFile(path.join(repo, 'credential.txt'), `token=${token}\n`);
  git(repo, 'add', 'credential.txt');
  await assert.rejects(scanStaged(repo), error => {
    assert.match(error.message, /Secret scan failed for staged changes/);
    assert.ok(!error.message.includes(token));
    return true;
  });
});
