import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodeTest from 'node:test';
import { SKIP } from './helpers/container-env.mjs';
import { withContainerEnv } from './helpers/container-run.mjs';
import { lastLine } from './helpers/fixtures.mjs';
import { startLauncher } from './helpers/launcher-process.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// S4-AC16 (DoD 1, 14) dod1-stub-run: one call of main with flags only (the stub adapter in the injected registry, launchEnabled true), in a
// launcher process whose standard input is closed: exit code 0, both report files non-empty at the ticket's paths, the JSON report parses
// and its session is the tag, and the last line is `ACODER LAUNCH <tag> done <record path>`.
t('dod1-stub-run: one command with flags only runs a reviewer ticket to done with the stub adapter; both reports at the ticket\'s paths', async () => {
  await withContainerEnv({ scenario: 'good-1' }, async context => {
    const { fx } = context;
    const done = await startLauncher(context).done;
    assert.equal(done.code, 0, `${done.stdout}${done.stderr}`);
    assert.equal(lastLine(done.stdout), `ACODER LAUNCH ${fx.tag} done ${fx.writable.runRecord}`);
    for (const file of [fx.writable.reportMd, fx.writable.reportJson]) assert.ok(fs.statSync(file).size > 0, `${file} is not empty`);
    assert.ok(fx.ticketText.includes(fx.writable.reportMd) && fx.ticketText.includes(fx.writable.reportJson), 'the reports are at the ticket\'s paths');
    assert.equal(JSON.parse(fs.readFileSync(fx.writable.reportJson, 'utf8')).session, fx.tag);
    const record = JSON.parse(fs.readFileSync(fx.writable.runRecord, 'utf8'));
    assert.deepEqual([record.exit_reason, record.agent.name, record.limits.wall_seconds], ['done', 'stub', 300], 'the limits come from the flags (--budget-minutes 5)');
  });
});
