import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanStaged } from './pre-push.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    await scanStaged(root);
  } catch (error) {
    console.error(`Pre-commit checks failed: ${error.code === 'ENOENT' ? 'Gitleaks is missing. See docs/ci.md.' : error.message}`);
    process.exitCode = 1;
  }
}
