import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkArtifacts, scanSecrets } from './pre-push.mjs';

// CI backstop for the local hooks: full reachable history for secrets, and the
// checked-out tip for private artifacts.
export async function scanRepository(root, { scan = scanSecrets, tip = 'HEAD' } = {}) {
  const commit = execFileSync('git', ['-C', root, 'rev-parse', '--verify', `${tip}^{commit}`], { encoding: 'utf8' }).trim();
  await scan(root, commit);
  checkArtifacts(root, commit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    await scanRepository(root);
    console.log('No secrets or private artifacts found.');
  } catch (error) {
    console.error(`Repository scan failed: ${error.code === 'ENOENT' ? 'Gitleaks is missing.' : error.message}`);
    process.exitCode = 1;
  }
}
