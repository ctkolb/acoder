import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { PLACEHOLDER_KEY } from '../lib/plan.mjs';
import { SKIP } from './helpers/container-env.mjs';
import { containerDeps, withContainerEnv } from './helpers/container-run.mjs';
import { runMain } from './helpers/fixtures.mjs';
import { expectedForms } from './helpers/key-forms.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// Every occurrence of the key, in every form of A8.6, in a text.
const hits = (text, key) => Object.entries(expectedForms(key)).filter(([, form]) => text.includes(form)).map(([name]) => name);
const read = file => (fs.existsSync(file) && fs.lstatSync(file).isFile() ? fs.readFileSync(file, 'latin1') : '');

// S4-AC10 (DoD 8) dod8-agent-clean, exactly as A8.7: the stub agent (scenario dump) writes into scratch everything it can read (its
// environment, every readable /proc/<pid>/environ and cmdline, every file under /acoder, /agent, /work, /run/acoder-egress, /etc/hosts,
// /etc/resolv.conf, and the full headers and bodies of its answers). The dump, both reports, the log, the record and the captured launcher
// output hold the key in no form. Control 1: a marker value the test put into an allowed agent variable (the tag, ACODER_TAG) IS in the
// dump. Control 2: the stub endpoint's recorded request headers hold the key (it was in use) and not the placeholder.
t('dod8-agent-clean: nothing the agent can read holds the key in any form; the dump works (marker found) and the key was in use upstream', async () => {
  const marker = `m${randomBytes(6).toString('hex')}`;
  await withContainerEnv({ tag: `ct-S4-${marker}`, scenario: 'dump' }, async context => {
    const { fx } = context;
    const out = await runMain(['review', 'run', ...context.argv()], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ACODER_MODEL_API_KEY: fx.key }, deps: { ...containerDeps({}, context), launchEnabled: true } });
    const record = JSON.parse(fs.readFileSync(fx.writable.runRecord, 'utf8'));
    assert.equal(record.agent_started, true, out.stderr);
    const dump = read(path.join(fx.writable.scratch, 'dump.txt'));
    assert.ok(dump.length > 1000, 'the dump was written');
    const env = JSON.parse(/^env (.*)$/m.exec(dump)[1]);
    assert.equal(env.ACODER_TAG, fx.tag, 'control 1: the marker the test put into an allowed agent variable is in the dump');
    assert.ok(/^\/proc\/1\/environ /m.test(dump) && /^file \/acoder\/run\.json /m.test(dump) && /^file \/etc\/hosts /m.test(dump), 'the dump covers /proc, /acoder and /etc');
    assert.match(dump, /^answer \{"status":200/m, 'the dump holds the answer the agent got');
    for (const [name, text] of [['dump', dump], ['md report', read(fx.writable.reportMd)], ['json report', read(fx.writable.reportJson)], ['log', read(record.log_path)],
      ['record', fs.readFileSync(fx.writable.runRecord, 'latin1')], ['launcher output', `${out.stdout}${out.stderr}`]]) {
      assert.deepEqual(hits(text, fx.key), [], `${name}: no form of the key`);
    }
    const requests = context.endpointRequests();
    assert.equal(requests.length, 1);
    const headers = requests[0].rawHeaders.join('\n');
    assert.ok(headers.includes(`Bearer ${fx.key}`), 'control 2: the key was in use on the upstream request');
    assert.ok(!headers.includes(PLACEHOLDER_KEY), 'control 2: the placeholder did not reach the endpoint');
  });
});
