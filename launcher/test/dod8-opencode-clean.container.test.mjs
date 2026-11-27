import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { PLACEHOLDER_KEY } from '../lib/plan.mjs';
import { AGENT_SKIP } from './helpers/container-env.mjs';
import { expectedForms } from './helpers/key-forms.mjs';
import { assertHealthyStreams, assertNoHostOrPathRefusal, reportTurns, withOpencodeRun } from './helpers/opencode-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime,
// ACODER_TEST_IMAGE or ACODER_TEST_AGENT_IMAGE (A10 item 4, S6-AC12).
const t = (name, fn, timeout = 300000) => nodeTest(name, { timeout, skip: AGENT_SKIP() }, fn);

// Every occurrence of the key, in every form of A8.6, in a text.
const hits = (text, key) => Object.entries(expectedForms(key)).filter(([, form]) => text.includes(form)).map(([name]) => name);
const read = file => (fs.existsSync(file) && fs.lstatSync(file).isFile() ? fs.readFileSync(file, 'latin1') : '');
const filesUnder = dir => fs.readdirSync(dir, { recursive: true }).map(name => path.join(dir, name)).filter(file => fs.lstatSync(file).isFile());

// The dump of A8.7, made by opencode's own bash tool: the environment of the tool's process (as JSON), every readable /proc/<pid>/environ and
// cmdline, and every file under /acoder, /agent (opencode's configuration, data and state, with the answers it got), /work and
// /run/acoder-egress, /etc/hosts and /etc/resolv.conf.
const DUMP_COMMAND = dump => [
  '{ echo "env $(node -e \'process.stdout.write(JSON.stringify(process.env))\')";',
  'for f in /proc/[0-9]*/environ /proc/[0-9]*/cmdline; do echo "proc $f"; tr \'\\0\' \'\\n\' < "$f"; echo; done;',
  'for f in $(find /acoder /agent /work /run/acoder-egress -type f 2>/dev/null) /etc/hosts /etc/resolv.conf; do echo "file $f"; cat "$f"; echo; done;',
  `} > ${dump} 2>&1`,
].join(' ');

// S6-AC9 (DoD 8) dod8-agent-clean in an opencode run: the search of A8.7 (the dump, every file in scratch, both reports, the log, the record
// and the captured launcher output) finds the key in no form. Control 1: the tag, which the launcher puts into the agent's environment as
// ACODER_TAG, IS in the dump (the dump and the search work). Control 2: the endpoint's recorded request headers hold the key (it was in use)
// and not the placeholder.
t('dod8-agent-clean: in an opencode run nothing the agent can read holds the key; the dump works and the key was in use upstream', async t => {
  await withOpencodeRun({
    turns: fx => {
      const [first, ...rest] = reportTurns(fx);
      return [first, { tool: 'bash', args: { command: DUMP_COMMAND(path.join(fx.writable.scratch, 'dump.txt')) } }, ...rest];
    },
  }, async ({ context: { fx }, done, record, bodies, requests }) => {
    assert.equal(done.code, 0, `${done.stdout}${done.stderr}`);
    assert.deepEqual([record.exit_reason, record.error_detail, record.conditions], ['done', null, []]);
    const dump = read(path.join(fx.writable.scratch, 'dump.txt'));
    assert.ok(dump.length > 1000, 'the dump was written');
    const env = JSON.parse(/^env (.*)$/m.exec(dump)[1]);
    assert.equal(env.ACODER_TAG, fx.tag, 'control 1: the marker the launcher put into an allowed agent variable is in the dump');
    assert.ok(env.OPENCODE_CONFIG_CONTENT.includes(PLACEHOLDER_KEY), 'the agent holds the placeholder');
    assert.ok(/^proc \/proc\/1\/environ$/m.test(dump) && /^file \/acoder\/run\.json$/m.test(dump) && /^file \/etc\/hosts$/m.test(dump), 'the dump covers /proc, /acoder and /etc');
    assert.ok(/^file \/agent\//m.test(dump), 'the dump covers opencode\'s own files under /agent');
    const scratch = filesUnder(fx.writable.scratch);
    assert.ok(scratch.length >= 1);
    for (const [name, text] of [...scratch.map(file => [file, read(file)]), ['md report', read(fx.writable.reportMd)], ['json report', read(fx.writable.reportJson)],
      ['log', read(record.log_path)], ['record', fs.readFileSync(fx.writable.runRecord, 'latin1')], ['launcher output', `${done.stdout}${done.stderr}`]]) {
      assert.deepEqual(hits(text, fx.key), [], `${name}: no form of the key`);
    }
    assert.ok(requests.length >= 5);
    for (const request of requests) {
      const headers = request.rawHeaders.join('\n');
      assert.ok(headers.includes(`Bearer ${fx.key}`), `control 2: the key was in use on upstream request ${request.n}`);
      assert.ok(!headers.includes(PLACEHOLDER_KEY), `control 2: the placeholder did not reach the endpoint (request ${request.n})`);
    }
    assertNoHostOrPathRefusal(record);
    assertHealthyStreams(t, 'clean', record, bodies);
  });
});
