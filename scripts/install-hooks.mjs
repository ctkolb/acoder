import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, chmod } from 'node:fs/promises';
import path from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const result = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' });
assert.ok(result.status === 0 || result.status === 1, 'Cannot read hook configuration');
const current = result.stdout.trim();
assert.ok(!current || path.resolve(root, current) === path.join(root, '.githooks'), `Existing core.hooksPath (${current}) requires manual integration`);
if (!current) {
  for (const name of ['pre-commit', 'pre-push']) {
    const defaultHook = execFileSync('git', ['rev-parse', '--git-path', `hooks/${name}`], { cwd: root, encoding: 'utf8' }).trim();
    const exists = await access(path.resolve(root, defaultHook)).then(() => true, () => false);
    assert.ok(!exists, `Existing ${name} hook requires manual integration`);
  }
}
await chmod(path.join(root, '.githooks/pre-commit'), 0o755);
await chmod(path.join(root, '.githooks/pre-push'), 0o755);
execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'inherit' });
console.log('Installed .githooks for this repository.');
