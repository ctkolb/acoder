import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { SKIP } from './helpers/container-env.mjs';
import { assertStagingGone, probeResults, withContainerRun } from './helpers/container-run.mjs';
import { sha } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// Every regular file under the live mailbox with its hash, except the three writable paths and the launcher's own run files.
function liveHashes(fx) {
  const out = {};
  const skip = new Set([fx.writable.scratch, fx.writable.reportMd, fx.writable.reportJson]);
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (skip.has(full) || (dir === fx.stage && name.startsWith(`run-${fx.tag}.`))) continue;
      const info = fs.lstatSync(full);
      if (info.isDirectory()) walk(full);
      else out[path.relative(fx.mailbox, full)] = info.isFile() ? sha(fs.readFileSync(full)) : 'not a regular file';
    }
  };
  walk(fx.mailbox);
  return out;
}

// S4-AC8 (DoD 4) dod4-writes: in the container every write to the ledger, a second ticket, a rework note and a triage file fails (append,
// truncate, rename, delete, create beside), a new file in the stage folder fails; scratch and both report files accept writes in place;
// afterwards every LIVE file outside the three writable paths has its hash from before the run.
t('dod4-writes: the ledger, another ticket, a rework note and a triage file refuse every write; scratch and both reports accept writes; the live files are unchanged by hash', async () => {
  const nonce = randomBytes(16).toString('hex');
  let before = null;
  const ops = ['append', 'truncate', 'rename', 'unlink'];
  await withContainerRun({
    scenario: 'script',
    steps: ({ fx }) => {
      const targets = {
        ledger: fx.ledger, ticket: path.join(fx.mailbox, 'S1', 'ticket-other-tag.md'), rework: path.join(fx.mailbox, 'S1', 'rework-other-tag.md'), triage: path.join(fx.mailbox, 'orchestrator', 'triage.md'),
      };
      fs.writeFileSync(targets.ticket, 'TICKET other-tag\nTo: BUILDER\n');
      fs.writeFileSync(targets.rework, 'REWORK other-tag\n');
      fs.writeFileSync(targets.triage, '# triage\n');
      before = liveHashes(fx);
      return [{ do: 'probe', nonce, actions: [
        ...Object.entries(targets).flatMap(([label, file]) => [
          ...ops.map(op => ({ label: `${label}:${op}`, op, path: file })),
          { label: `${label}:create`, op: 'create', path: `${file}.beside` },
        ]),
        { label: 'stage:create', op: 'create', path: path.join(fx.stage, 'new-file.md') },
        { label: 'scratch:write', op: 'write', path: path.join(fx.writable.scratch, 'notes.txt'), text: 'scratch works\n' },
        { label: 'md:write', op: 'write', path: fx.writable.reportMd, text: '# report\n' },
        { label: 'json:write', op: 'write', path: fx.writable.reportJson, text: `${JSON.stringify({ session: fx.tag })}\n` },
      ] }, { do: 'exit', code: 0 }];
    },
  }, async ({ record, fx }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    const results = probeResults(record, nonce);
    for (const label of ['ledger', 'ticket', 'rework', 'triage']) {
      for (const op of [...ops, 'create']) assert.deepEqual([results[`${label}:${op}`].ok, results[`${label}:${op}`].code], [false, 'EROFS'], `${label} ${op} fails`);
    }
    assert.deepEqual([results['stage:create'].ok, results['stage:create'].code], [false, 'EROFS'], 'no new file in the stage folder');
    for (const label of ['scratch:write', 'md:write', 'json:write']) assert.equal(results[label].ok, true, `${label} succeeds`);
    assert.equal(fs.readFileSync(path.join(fx.writable.scratch, 'notes.txt'), 'utf8'), 'scratch works\n', 'the scratch write reached the host');
    assert.equal(fs.readFileSync(fx.writable.reportMd, 'utf8'), '# report\n', 'the Markdown report was written in place');
    assert.deepEqual(JSON.parse(fs.readFileSync(fx.writable.reportJson, 'utf8')), { session: fx.tag }, 'the JSON report was written in place');
    assert.deepEqual(liveHashes(fx), before, 'every live file outside the writable paths is unchanged, and none was added');
    assertStagingGone({ fx, record });
  });
});
