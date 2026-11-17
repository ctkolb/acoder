import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import nodeTest from 'node:test';
import { SKIP } from './helpers/container-env.mjs';
import { assertStagingGone, withContainerRun } from './helpers/container-run.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 300000) => nodeTest(name, { timeout, skip: SKIP }, fn);
const WORK = [{ do: 'request' }, { do: 'reports' }];

// The record of a run whose post-run scan could not finish: error secret_scan_incomplete, status incomplete, the record still written.
function assertIncomplete({ record, result, fx }) {
  assert.ok(record !== null && record.agent_started === true, 'the agent ran and a final record was written');
  assert.deepEqual([record.exit_reason, record.error_detail, result.exit_code], ['error', 'secret_scan_incomplete', 1], JSON.stringify(record.conditions));
  assert.equal(record.secret_scan.status, 'incomplete');
  assert.equal(record.inputs.scratch_git_entries_complete, false, 'the Git entry count is a lower bound');
  assertStagingGone({ fx, record });
}

// S4-AC14 (R5-04) r5-readback on real containers: an unreadable directory, an oversize JSON report and a 200001-entry tree each end
// secret_scan_incomplete with the exact outcome; a FIFO or a socket is counted and never opened (A8.6: special entries do not make the scan
// incomplete). Owner decision D-R41 (2): A8.6 wins; the word FIFO under secret_scan_incomplete in S4-AC14 is superseded.
t('r5-readback: an unreadable directory the agent left in scratch ends error secret_scan_incomplete', async () => {
  await withContainerRun({ scenario: 'script', steps: [{ do: 'mkdir', name: 'closed', mode: '000' }, ...WORK, { do: 'exit', code: 0 }] }, assertIncomplete);
});

t('r5-readback: a JSON report over 16 MiB ends error secret_scan_incomplete', async () => {
  await withContainerRun({ scenario: 'script', steps: [{ do: 'request' }, { do: 'reports', jsonPad: 16777216 }, { do: 'exit', code: 0 }] }, async run => {
    assertIncomplete(run);
    assert.ok(run.record.reports.json.bytes > 16777216);
  });
});

t('r5-readback: a tree of 200001 entries in scratch ends error secret_scan_incomplete (made on the host after the stop, before the scan)', async () => {
  await withContainerRun({
    scenario: 'script', steps: [...WORK, { do: 'exit', code: 0 }],
    hooks: {
      afterStop: (info, { fx }) => {
        const root = path.join(fx.writable.scratch, 'tree');
        fs.mkdirSync(root);
        for (let group = 0; group < 201; group += 1) {
          const dir = path.join(root, String(group));
          fs.mkdirSync(dir);
          for (let index = 0; index < 1000; index += 1) fs.writeFileSync(path.join(dir, String(index)), '');
        }
      },
    },
  }, async run => {
    assertIncomplete(run);
    assert.equal(run.record.secret_scan.entries_seen, 200001, 'the scan stopped at the entry bound');
  });
});

t('r5-readback: a FIFO in scratch is counted as a special entry and never opened; the scan completes and the run ends done', async () => {
  await withContainerRun({ scenario: 'script', steps: [{ do: 'mkfifo', name: 'pipe' }, ...WORK, { do: 'exit', code: 0 }] }, async ({ record, fx }) => {
    assert.ok(fs.lstatSync(path.join(fx.writable.scratch, 'pipe')).isFIFO(), 'the agent made a FIFO in scratch');
    assert.equal(record.exit_reason, 'done', JSON.stringify(record.conditions));
    assert.equal(record.secret_scan.status, 'clean');
    assert.equal(record.secret_scan.special_entries, 1);
    assertStagingGone({ fx, record });
  });
});

// D-R41 (2), F-38-06: a Unix socket in scratch is a special entry like the FIFO (made on the host after the stop, before the scan; bound by
// a path relative to scratch, so the address length does not depend on the fixture path).
t('r5-readback: a Unix socket in scratch is counted as a special entry and never opened; the scan completes and the run ends done', async () => {
  const server = net.createServer(socket => socket.destroy());
  let connections = 0;
  server.on('connection', () => { connections += 1; });
  try {
    await withContainerRun({
      scenario: 'script', steps: [...WORK, { do: 'exit', code: 0 }],
      hooks: {
        afterStop: async (info, { fx }) => {
          const back = process.cwd();
          process.chdir(fx.writable.scratch);
          try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen('sock', resolve); }); } finally { process.chdir(back); }
          assert.ok(fs.lstatSync(path.join(fx.writable.scratch, 'sock')).isSocket(), 'a socket is in scratch');
        },
      },
    }, async ({ record, fx }) => {
      assert.equal(record.exit_reason, 'done', JSON.stringify(record.conditions));
      assert.equal(record.secret_scan.status, 'clean');
      assert.equal(record.secret_scan.special_entries, 1);
      assert.equal(connections, 0, 'the scan never connected to the socket');
      assertStagingGone({ fx, record });
    });
  } finally { await new Promise(resolve => server.close(() => resolve())); }
});
