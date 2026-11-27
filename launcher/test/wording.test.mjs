import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { LAUNCHER } from './helpers/fixtures.mjs';

const t = (name, fn) => nodeTest(name, { timeout: 30000 }, fn);

// S4-AC19 (DoD 11; A3.8): nothing in the launcher's code or messages calls a platform or a run "isolated".
t('dod11-wording: no launcher source file outside the tests calls a platform or a run isolated', () => {
  const found = [];
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.lstatSync(full).isDirectory()) { if (name !== 'test') walk(full); continue; }
      if (/isolated/i.test(fs.readFileSync(full, 'utf8'))) found.push(path.relative(LAUNCHER, full));
    }
  };
  walk(LAUNCHER);
  assert.deepEqual(found, []);
});
