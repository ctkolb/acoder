import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { LAUNCHER, must } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own. The test is registered from this file, so that the mutation runner can count it per module.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, async (...args) => {
  // A failure that is not an assertion (a TypeError from a broken module) is reported as an assertion failure.
  try { return await fn(...args); } catch (error) { if (error?.code === 'ERR_ASSERTION') throw error; assert.fail(`threw: ${String(error?.message ?? error)}`); }
});

const ROOT = path.dirname(LAUNCHER.replace(/\/$/, ''));
const CONTAINERFILE = path.join(LAUNCHER, 'image', 'Containerfile');
// A10.2, character for character.
const EXPECTED = [
  'ARG BASE_IMAGE',
  'FROM ${BASE_IMAGE}',
  'ARG AGENT_NPM_PACKAGE',
  'ARG AGENT_CLI_VERSION',
  'RUN test -n "${AGENT_NPM_PACKAGE}" && test -n "${AGENT_CLI_VERSION}"',
  'RUN node -e "process.exit(Number(process.versions.node.split(\'.\')[0]) >= 22 ? 0 : 1)"',
  'RUN command -v sh sha256sum cp chmod patch diff',
  'RUN npm install --global "${AGENT_NPM_PACKAGE}@${AGENT_CLI_VERSION}" && npm cache clean --force',
  '',
].join('\n');

function walk(directory, out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

t('S2-AC20: the reference image definition has exactly the content of A10.2, no default for any argument, and names no agent and no provider', () => {
  const text = must(() => fs.readFileSync(CONTAINERFILE, 'utf8'));
  assert.equal(text, EXPECTED);
  assert.ok(!/^ARG [A-Z_]+=/m.test(text), 'no argument has a default');
  assert.ok(!/opencode|openai/i.test(text));
  assert.deepEqual(must(() => fs.readdirSync(path.join(LAUNCHER, 'image'))), ['Containerfile'], 'the image folder holds only the definition');
});

t('S2-AC20: nothing in the repository builds, pulls or runs the image definition or calls the container runtime', () => {
  const buildWords = ['docker' + ' build', 'podman' + ' build', 'buildx', 'buildah', 'docker' + ' pull', 'podman' + ' pull', 'image' + ' build'];
  const callers = [`spawn${'Sync'}('docker`, `spawn${'Sync'}('podman`, `spawn('docker`, `spawn('podman`, `exec${'File'}('docker`, `exec${'File'}('podman`, `exec${'Sync'}('docker`];
  const files = [path.join(ROOT, 'package.json'), ...['.github', '.githooks', 'scripts', 'launcher'].flatMap(directory => (fs.existsSync(path.join(ROOT, directory)) ? walk(path.join(ROOT, directory)) : []))];
  assert.ok(files.length > 20);
  for (const file of files) {
    if (file === CONTAINERFILE || file === new URL(import.meta.url).pathname) continue;
    const text = fs.readFileSync(file, 'utf8');
    const shown = path.relative(ROOT, file);
    for (const word of buildWords) assert.ok(!text.includes(word), `${shown} mentions ${word}`);
    for (const call of callers) assert.ok(!text.includes(call), `${shown} calls the container runtime`);
    if (!shown.startsWith(`launcher${path.sep}test${path.sep}`)) assert.ok(!/Containerfile/i.test(text), `${shown} references the image definition`);
  }
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  for (const [name, command] of Object.entries(scripts)) assert.ok(!/Containerfile|docker|podman/i.test(command), `script ${name}`);
});

t('S2-AC21: package.json holds exactly the changes K1.1 and K1.2 and nothing else of the launcher', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test scripts/*.test.mjs launcher/test/*.test.mjs');
  assert.deepEqual(pkg.bin, { acoder: 'launcher/bin/acoder.mjs' });
  assert.deepEqual(Object.keys(pkg.scripts), ['check', 'lint:markdown', 'validate', 'test', 'mutants', 'hooks:install', 'lint:workflows']);
  assert.equal(pkg.scripts.check, 'npm run lint:markdown && npm run validate && npm test && npm run lint:workflows');
  assert.equal(pkg.dependencies, undefined, 'no runtime dependency');
  assert.deepEqual(Object.keys(pkg.devDependencies), ['github-slugger', 'markdown-it', 'markdownlint-cli2', 'yaml']);
  assert.equal(pkg.engines.node, '>=22');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, true);
  assert.ok(fs.existsSync(path.join(ROOT, 'launcher', 'bin', 'acoder.mjs')));
});

t('S2-AC21: the launcher imports only node: modules and its own files, and no file is added outside the allowed places', () => {
  for (const file of walk(LAUNCHER).filter(name => name.endsWith('.mjs') && !name.startsWith(path.join(LAUNCHER, 'test')))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [, specifier] of [...text.matchAll(/from\s+'([^']+)'/g), ...text.matchAll(/import\(\s*'([^']+)'\s*\)/g)]) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'), `${path.relative(ROOT, file)} imports ${specifier}`);
    }
  }
  const tracked = walk(LAUNCHER).map(file => path.relative(LAUNCHER, file));
  for (const name of tracked) assert.ok(!/(^|\/)(mailbox|scratch|checkouts|\.aws|\.ssh)(\/|$)|(^|\/)(ticket-|report-|rework-|handoff)|tickets\.json|ticket-events\.jsonl/.test(name), `${name} breaks G3`);
});
