import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const oid = /^(?:[a-f\d]{40}|[a-f\d]{64})$/;
const zero = /^0+$/;
const maxBuffer = 128 * 1024 * 1024;

let cleanEnvironment;
function environment() {
  if (cleanEnvironment) return cleanEnvironment;
  // Git exports repository-local variables to hooks. They must not leak into
  // the temporary checkouts or the test suite's disposable repositories.
  const env = { ...process.env };
  for (const name of execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).trim().split('\n')) delete env[name];
  cleanEnvironment = env;
  return env;
}

function git(root, args, options = {}) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', env: environment(), maxBuffer, stdio: ['ignore', 'pipe', 'pipe'], ...options,
  });
}

export function parseUpdates(input) {
  return input.trim().split('\n').filter(Boolean).map(line => {
    const fields = line.trim().split(/\s+/);
    assert.equal(fields.length, 4, 'Malformed pre-push input');
    const [localRef, localOid, remoteRef, remoteOid] = fields;
    assert.ok(oid.test(localOid) && oid.test(remoteOid), 'Invalid pre-push object ID');
    return { localRef, localOid, remoteRef, remoteOid };
  });
}

export function privateArtifact(file, text) {
  if (/(^|\/)(mailbox|scratch|checkouts|\.aws|\.ssh)(\/|$)/i.test(file)
    || /(^|\/)\.env(?:\..+)?$/i.test(file) && !file.endsWith('/.env.example') && file !== '.env.example'
    || /(^|\/)project-config(?:-[^/]*)?\.md$/i.test(file)) return 'private artifact path';
  if (!file.startsWith('examples/') && /(^|\/)(?:(?:report|ticket|rework)-[^/]+\.(?:md|json)|handoff(?:-[^/]*)?\.md|tickets\.json|ticket-events\.jsonl)$/i.test(file)) return 'run artifact outside synthetic examples';
  if (/\/(?:Users|home)\/[^\s/<>"'`]+\/|[A-Za-z]:\\Users\\[^\s\\<>"'`]+\\|\/private\/var\/folders\//.test(text)) return 'machine-specific path';
  if (/^(?:Repository|Mailbox|Handoff file|Scratch path|Report path):\s*(?:\/|~\/|[A-Za-z]:[\\/])/m.test(text)) return 'filled project path';
  return null;
}

export function checkArtifacts(root, commit) {
  const entries = git(root, ['ls-tree', '-rz', '--full-tree', commit]).split('\0').filter(Boolean);
  for (const entry of entries) {
    const [, mode, type, hash, file] = entry.match(/^(\d+) (\w+) ([a-f\d]+)\t([\s\S]*)$/);
    assert.equal(type, 'blob', `Unsupported entry in ${commit}: ${JSON.stringify(file)}`);
    assert.notEqual(mode, '120000', `Symlink requires review in ${commit}: ${JSON.stringify(file)}`);
    const reason = privateArtifact(file, git(root, ['cat-file', 'blob', hash]));
    assert.ok(!reason, `${commit}: ${JSON.stringify(file)}: ${reason}`);
  }
}

async function runGitleaks(root, scope, label) {
  const version = execFileSync('gitleaks', ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match && (Number(match[1]) > 8 || Number(match[1]) === 8 && (Number(match[2]) > 30 || Number(match[2]) === 30 && Number(match[3]) >= 1)), 'Install Gitleaks 8.30.1 or newer');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'acoder-secrets-'));
  try {
    // Use default rules, not ignore/config files from the outgoing commits.
    await writeFile(path.join(temporary, 'config.toml'), '[extend]\nuseDefault = true\n');
    await writeFile(path.join(temporary, 'empty.ignore'), '');
    execFileSync('gitleaks', ['git', root, '--no-banner', '--redact', '--ignore-gitleaks-allow',
      '--config', path.join(temporary, 'config.toml'), '--gitleaks-ignore-path', path.join(temporary, 'empty.ignore'), ...scope],
    { env: environment(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer });
  } catch (error) {
    // Scanner output and matched contents may contain private data. Never echo it.
    throw new Error(`Secret scan failed for ${label}; inspect locally with gitleaks git --redact (exit ${error.status ?? 'unknown'}).`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function scanSecrets(root, range) {
  return runGitleaks(root, ['--log-opts', `--full-history --no-ext-diff --no-textconv --diff-merges=first-parent ${range}`], range);
}

export function scanStaged(root) {
  return runGitleaks(root, ['--staged'], 'staged changes');
}

export async function checkCommit(root, commit) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'acoder-push-'));
  try {
    const archive = git(root, ['archive', '--format=tar', commit], { encoding: null });
    execFileSync('tar', ['-xf', '-', '-C', temporary], { input: archive, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer });
    const packageFile = JSON.parse(await readFile(path.join(temporary, 'package.json'), 'utf8'));
    assert.ok(packageFile.scripts?.check, `${commit}: missing npm run check`);
    // actionlint discovers its project root through .git. This is a new empty
    // repository, never a worktree attached to the owner's live repository.
    execFileSync('git', ['init', '--quiet', temporary], { env: environment(), stdio: 'pipe' });
    const options = { cwd: temporary, env: { ...environment(), GOPROXY: 'off', GOSUMDB: 'off' }, stdio: ['ignore', 'inherit', 'inherit'] };
    execFileSync('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], options);
    execFileSync('npm', ['run', 'check'], options);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function prePush(root, input, { scan = scanSecrets, check = checkCommit, remoteName } = {}) {
  const tips = new Set();
  const checkedCommits = new Set();
  for (const update of parseUpdates(input)) {
    if (zero.test(update.localOid)) continue; // Ref deletion has no outgoing content.
    const tip = git(root, ['rev-parse', '--verify', `${update.localOid}^{commit}`]).trim();
    let base = null;
    if (!zero.test(update.remoteOid)) {
      try {
        base = git(root, ['rev-parse', '--verify', `${update.remoteOid}^{commit}`]).trim();
      } catch {
        throw new Error(`Remote object ${update.remoteOid} is unavailable locally; fetch the remote before retrying.`);
      }
    }
    // For new refs exclude commits already recorded on this remote. With no
    // tracking refs, conservatively scan all reachable history. All log-option
    // values below are validated OIDs, never user-provided ref names.
    let exclusions = [];
    if (!base && remoteName && git(root, ['remote']).split('\n').includes(remoteName)) {
      exclusions = git(root, ['for-each-ref', '--format=%(objectname)', `refs/remotes/${remoteName}/`])
        .trim().split('\n').filter(value => oid.test(value));
    }
    const revisions = base ? [`${base}..${tip}`] : [tip, ...(exclusions.length ? ['--not', ...exclusions] : [])];
    const range = revisions.join(' ');
    const commits = git(root, ['rev-list', ...revisions]).trim().split('\n').filter(Boolean);
    if (commits.length) await scan(root, range);
    for (const commit of commits) {
      if (checkedCommits.has(commit)) continue;
      try {
        git(root, ['diff-tree', '--check', '--root', '-m', commit]);
      } catch {
        throw new Error(`${commit}: whitespace errors or conflict markers; inspect with git show --check ${commit}.`);
      }
      checkArtifacts(root, commit);
      checkedCommits.add(commit);
    }
    // Inspect the final tree even for a rollback to an already reachable commit.
    checkArtifacts(root, tip);
    tips.add(tip);
  }
  for (const tip of tips) {
    console.log(`Checking outgoing commit ${tip}`);
    await check(root, tip);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    await prePush(root, readFileSync(0, 'utf8'), { remoteName: process.argv[2] });
  } catch (error) {
    console.error(`Pre-push checks failed: ${error.code === 'ENOENT' ? 'Required tool or committed CI file is missing. See docs/ci.md.' : error.message}`);
    process.exitCode = 1;
  }
}
