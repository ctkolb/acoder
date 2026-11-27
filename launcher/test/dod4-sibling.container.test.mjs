import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { IMAGE_ID, SKIP } from './helpers/container-env.mjs';
import { assertStagingGone, ENDPOINT, probeResults, withContainerRun } from './helpers/container-run.mjs';
import { lastLine, listing, runMain, withFixture } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// A second run mailbox beside the fixture's own, under the same parent, with a ledger and a sentinel.
function sibling(fx, secret) {
  const other = path.join(fx.base, 'run-sibling');
  fs.mkdirSync(path.join(other, 'orchestrator'), { recursive: true });
  fs.writeFileSync(path.join(other, 'orchestrator', 'tickets.json'), '{"tickets":[]}\n');
  fs.writeFileSync(path.join(other, 'sentinel.txt'), `${secret}\n`);
  return other;
}

// S4-AC8 (DoD 4) dod4-sibling: a sentinel in a sibling run mailbox (same parent) is unreadable from the container (control: the host reads
// it; twin: the container reads its own ledger).
t('dod4-sibling: a sentinel in a sibling mailbox is unreadable in the container; the container reads its own ledger; the host reads the sentinel', async () => {
  const nonce = randomBytes(16).toString('hex');
  const secret = randomBytes(12).toString('hex');
  let other = null;
  await withContainerRun({
    scenario: 'script',
    steps: ({ fx }) => {
      other = sibling(fx, secret);
      return [{ do: 'probe', nonce, actions: [
        { label: 'sentinel', op: 'read', path: path.join(other, 'sentinel.txt') },
        { label: 'sibling-ledger', op: 'read', path: path.join(other, 'orchestrator', 'tickets.json') },
        { label: 'parent', op: 'list', path: fx.base },
        { label: 'own-ledger', op: 'read', path: fx.ledger },
      ] }, { do: 'exit', code: 0 }];
    },
  }, async ({ record, fx }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    const results = probeResults(record, nonce);
    assert.equal(fs.readFileSync(path.join(other, 'sentinel.txt'), 'utf8'), `${secret}\n`, 'control: the host reads the sibling sentinel');
    assert.deepEqual([results.sentinel.ok, results.sentinel.code], [false, 'ENOENT'], 'the sibling sentinel is not in the container');
    assert.deepEqual([results['sibling-ledger'].ok, results['sibling-ledger'].code], [false, 'ENOENT']);
    assert.ok(!results.parent.names.includes('run-sibling'), `the sibling mailbox is not in the container: ${results.parent.names}`);
    assert.equal(results['own-ledger'].ok, true, 'twin: the container reads its own ledger');
    assert.equal(results['own-ledger'].text, fs.readFileSync(fx.ledger, 'utf8'));
    assertStagingGone({ fx, record });
  });
});

// S4-AC8: launching with the parent of the two mailboxes as --mailbox is refused with the message of A2.7.1 and creates nothing (the real
// command with launch enabled, so the refusal is the launcher's and not the guard's).
t('dod4-sibling: the parent of two mailboxes as --mailbox is refused (A2.7.1) and nothing is created', () => withFixture({ tag: 'ct-S4-sib' }, async fx => {
  sibling(fx, 'x');
  const argv = fx.argv({ drop: ['--dry-run'], set: { '--mailbox': fx.base, '--image': IMAGE_ID(), '--model-endpoint': ENDPOINT } });
  const before = listing(fx.base);
  const calls = [];
  const runtime = real => ({ ...real, call: (args, extra) => { calls.push(args); return real.call(args, extra); } });
  const result = await runMain(argv, { env: { PATH: process.env.PATH, ACODER_MODEL_API_KEY: fx.key }, deps: { launchEnabled: true, runtime } });
  assert.equal(result.code, 2, result.stderr);
  assert.equal(result.stderr, `refused: ${fx.base} is not a run mailbox (no orchestrator/tickets.json)\n`);
  assert.equal(lastLine(result.stdout), `ACODER LAUNCH ${fx.tag} refused -`);
  assert.deepEqual(listing(fx.base), before, 'nothing was created');
  assert.deepEqual(calls.filter(args => ['create', 'run', 'start'].includes(args[0]) || args[1] === 'create'), [], 'no runtime resource was created or started');
}), 120000);
