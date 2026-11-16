import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { SKIP } from './helpers/container-env.mjs';
import { assertStagingGone, probeResults, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 240000) => nodeTest(name, { timeout, skip: SKIP }, fn);

// The root of the reference image (node on alpine) and the mount roots the plan adds; nothing else may appear at `/`.
const IMAGE_ROOT = ['.dockerenv', 'bin', 'dev', 'etc', 'home', 'lib', 'media', 'mnt', 'opt', 'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var', 'acoder', 'agent', 'work'];

// S4-AC7 (DoD 2) dod2-sentinel: a host sentinel beside the synthetic mailbox, outside every mount, cannot be read in the container; the
// listings of `/`, of every parent of the mailbox and of the mailbox show only what the mounts supply; a file created in the LIVE mailbox
// after the snapshot is not visible. Control: the host reads the sentinel. Twin: the container reads mounted files.
t('dod2-sentinel: a host sentinel beside the mailbox is unreadable in the container, the listings show only the mounts, and a live file added after the snapshot is not visible', async () => {
  const nonce = randomBytes(16).toString('hex');
  const secret = randomBytes(12).toString('hex');
  let sentinel = null;
  await withContainerRun({
    scenario: 'script',
    steps: ({ fx }) => {
      sentinel = path.join(fx.base, 'sentinel.txt');
      fs.writeFileSync(sentinel, `${secret}\n`);
      const parents = [];
      for (let dir = fx.base; dir !== '/'; dir = path.dirname(dir)) parents.push(dir);
      return [{ do: 'probe', nonce, actions: [
        { label: 'sentinel', op: 'read', path: sentinel },
        { label: 'root', op: 'list', path: '/' },
        ...parents.map(dir => ({ label: `parent:${dir}`, op: 'list', path: dir })),
        { label: 'mailbox', op: 'list', path: fx.mailbox },
        { label: 'S1', op: 'list', path: path.join(fx.mailbox, 'S1') },
        { label: 'late', op: 'read', path: path.join(fx.mailbox, 'S1', 'late.md') },
        { label: 'ticket', op: 'read', path: fx.ticket },
        { label: 'note', op: 'read', path: path.join(fx.mailbox, 'S1', 'note.md') },
      ] }, { do: 'exit', code: 0 }];
    },
    afterSnapshot: (info, { fx }) => { fs.writeFileSync(path.join(fx.mailbox, 'S1', 'late.md'), 'added to the live mailbox after the snapshot\n'); },
  }, async ({ record, fx }) => {
    assert.ok(record !== null && record.agent_started === true, 'the agent ran');
    const results = probeResults(record, nonce);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), `${secret}\n`, 'control: the host reads the sentinel');
    assert.deepEqual([results.sentinel.ok, results.sentinel.code], [false, 'ENOENT'], 'the sentinel is not in the container');
    assert.equal(results.ticket.ok, true, 'twin: the container reads the mounted ticket');
    assert.equal(results.ticket.text, fx.ticketText);
    assert.deepEqual([results.note.ok, results.note.text], [true, 'a note\n'], 'twin: the container reads a mounted mailbox file');
    // Only the mount targets exist in the parents of the mailbox: the mailbox itself and the export outside it.
    const firstSegment = fx.base.split('/')[1];
    assert.ok(results.root.ok && results.root.names.every(name => IMAGE_ROOT.includes(name) || name === firstSegment), `/ holds only the image and the mount roots: ${results.root.names}`);
    assert.deepEqual(results[`parent:${fx.base}`].names, ['exp', 'run'], 'the fixture base shows only the mounted mailbox and export, not the sentinel');
    assert.ok(fs.readdirSync(fx.base).includes('sentinel.txt'), 'the host fixture base holds the sentinel');
    for (let dir = path.dirname(fx.base); dir !== '/'; dir = path.dirname(dir)) {
      const child = path.relative(dir, fx.base).split('/')[0];
      assert.deepEqual(results[`parent:${dir}`].names, [child], `${dir} shows only the path to the mounts`);
    }
    assert.deepEqual(results.mailbox.names, ['S1', 'S2', 'orchestrator']);
    assert.ok(fs.existsSync(path.join(fx.mailbox, 'S1', 'late.md')), 'the live file exists on the host');
    assert.deepEqual(results.S1.names, ['note.md'], 'the live file added after the snapshot is not in the container');
    assert.deepEqual([results.late.ok, results.late.code], [false, 'ENOENT']);
    assertStagingGone({ fx, record });
  });
});
