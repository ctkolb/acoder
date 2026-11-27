// A fake runtime and a driver for the lifecycle of A6.6 with a failure injected at one effect boundary. The driver creates the real
// mailbox effects (staging directory, scratch directory, report files, log, started file) in a fixture, applies the table of lib/state.mjs
// (what to remove, which record to write) and returns what is left, so the tests compare the real file system with the table.
import fs from 'node:fs';
import path from 'node:path';
import { writablePaths } from '../../lib/paths.mjs';
import { buildRecord, makeRunId, recordNames, writeRecord } from '../../lib/record.mjs';
import { createRedactor } from '../../lib/redact.mjs';
import { failureOutcome } from '../../lib/state.mjs';
import { recordValues } from './record-values.mjs';

export const BOUNDARIES = ['V', 'S', 'E2', 'E3', 'G', 'R-before-started', 'R-after-started'];

export function runLifecycle({ fx, failAt, interrupted = false, date = new Date('2026-11-12T10:15:00Z'), random = 'a1b2c3' }) {
  const writable = writablePaths(fx.ticket);
  const resources = new Set();
  const runId = makeRunId(date, random);
  const created = {};
  let staging = null;
  let state = null;
  let startedFile = false;
  const at = name => { state = name; return failAt === name; };
  try {
    if (at('V')) throw new Error('V');
    staging = path.join(fx.staging, `staging-${runId}`);
    if (at('S')) { fs.mkdirSync(staging); throw new Error('S'); }
    fs.mkdirSync(staging);
    fs.mkdirSync(writable.scratch, { mode: 0o700 });
    for (const [name, file] of [['md', writable.reportMd], ['json', writable.reportJson]]) {
      fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
      created[name] = fs.lstatSync(file).ino;
    }
    const log = path.join(writable.stage, `run-${writable.tag}.notstarted-${runId}.log`);
    // E2 fails before its log exists (the run computes the log path first and still writes the log after the failure, F-38-02).
    if (at('E2')) throw new Error('E2');
    fs.writeFileSync(log, 'log\n', { flag: 'wx' });
    for (const name of ['volume', 'network', 'egress', 'agent']) resources.add(name);
    if (at('E3')) throw new Error('E3');
    if (at('G')) throw new Error('G');
    state = 'R';
    if (failAt === 'R-before-started') throw new Error('R');
    fs.writeFileSync(writable.startedRecord, '{}\n', { flag: 'wx' });
    startedFile = true;
    if (failAt === 'R-after-started') throw new Error('R');
    throw new Error('the fake lifecycle was not told to fail');
  } catch (error) {
    if (!BOUNDARIES.includes(failAt) || error.message === 'the fake lifecycle was not told to fail') throw error;
    const outcome = failureOutcome(state, { startedFileWritten: startedFile, interrupted });
    for (const name of outcome.remove) {
      if (name === 'staging') fs.rmSync(staging, { recursive: true, force: true });
      else if (name === 'report_md' || name === 'report_json') {
        const file = name === 'report_md' ? writable.reportMd : writable.reportJson;
        const info = fs.lstatSync(file, { throwIfNoEntry: false });
        if (info?.isFile() && info.size === 0 && info.ino === created[name === 'report_md' ? 'md' : 'json']) fs.rmSync(file);
      } else if (name === 'scratch') { try { fs.rmdirSync(writable.scratch); } catch { /* not empty: left for the owner */ } }
      else resources.delete(name);
    }
    const notStartedLog = path.join(writable.stage, `run-${writable.tag}.notstarted-${runId}.log`);
    if (outcome.log === 'notstarted' && !fs.existsSync(notStartedLog)) fs.writeFileSync(notStartedLog, 'log\n', { flag: 'wx' });
    let recordFile = null;
    if (outcome.record !== 'none') {
      const started = outcome.record === 'run';
      const names = recordNames({ stageDir: writable.stage, tag: writable.tag, runId, started });
      if (started && fs.existsSync(notStartedLog)) fs.renameSync(notStartedLog, names.log);
      const values = recordValues({
        tag: writable.tag, run_id: runId, agent_started: false, exit_reason: started ? 'error' : null, error_detail: outcome.error_detail, conditions: started ? [outcome.error_detail] : [],
        agent_exit: { code: null, signal: null, outcome: null }, log_path: names.log,
      });
      writeRecord(names.record, buildRecord(values), createRedactor(fx.key));
      recordFile = names.record;
    }
    return { outcome, recordFile, resources: [...resources].sort(), staging, stageNames: fs.readdirSync(writable.stage).sort(), writable, runId };
  }
}
