import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodeTest from 'node:test';
import { SKIP } from './helpers/container-env.mjs';
import { withContainerEnv } from './helpers/container-run.mjs';
import { startLauncher } from './helpers/launcher-process.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// F-38-10: the bounded waits of the stop sequence (30 s for the agent container, 15 s for the sidecar) are timers that must not outlive
// the run: a launcher process whose run ended prints its last line and then ends at once.
t('a launcher process ends promptly after the last line of a started run (no timer of the stop sequence keeps it alive)', async () => {
  await withContainerEnv({ scenario: 'marker' }, async context => {
    const launcher = startLauncher(context);
    let printed = null;
    let text = '';
    launcher.child.stdout.on('data', chunk => { text += chunk; if (printed === null && /ACODER LAUNCH \S+ \S+ \S+\n/.test(text)) printed = Date.now(); });
    const killer = setTimeout(() => launcher.child.kill('SIGKILL'), 200000);
    const end = await launcher.done;
    const ended = Date.now();
    clearTimeout(killer);
    assert.ok(printed !== null, `the launcher printed its last line: ${end.stdout} ${end.stderr}`);
    assert.match(end.stdout, new RegExp(`ACODER LAUNCH ${context.fx.tag} (done|error) ${context.fx.writable.runRecord}\\n$`), end.stderr);
    assert.ok(end.code === 0 || end.code === 1, `the launcher's exit code: ${end.code}`);
    assert.ok(fs.existsSync(context.fx.writable.runRecord), 'the run record exists');
    assert.ok(ended - printed < 5000, `the process ended ${ended - printed} ms after its last line`);
  });
});
