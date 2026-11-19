import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { PassThrough } from 'node:stream';
import { IMAGE_ID, imageAnswer, makeFakeRuntime } from './helpers/fake-runtime.mjs';
import { runMain, withFixture } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own and is registered from this file.
const t = (name, fn) => nodeTest(name, { timeout: 60000 }, fn);

// F-40-03 (R39-04; A3.6, A6.6 R): a synthetic launch without containers. The runtime double answers every call, inspects each container
// exactly as planned, and attaches two stream doubles: the supervisor (probe results, then the release events) and the sidecar (ready,
// upstream, the probe-phase requests, CLOCK answers). How the sidecar double answers `PHASE agent` is the variant:
//   valid    — a phase event with phase agent after the PHASE line (what container/proxy.mjs emits);
//   wrong    — a phase event with phase probe after the PHASE line;
//   withheld — nothing;
//   early    — a phase event with phase agent BEFORE the PHASE line (in answer to CLOCK), nothing after it.
// F-42-02 (R41-02): after the PHASE line exactly one phase event, phase agent, from a sidecar that is still running and has sent no protocol
// or exit event, both when the started file is written and when RELEASE is due:
//   duplicate        — two phase-agent events at once;
//   agent-probe      — a phase-agent event and at once a probe-phase event;
//   exit-after       — a phase-agent event, then the sidecar closes at once;
//   exit-with-ack    — a phase-agent event; the sidecar closes in the same turn, right after the launcher has read the event;
//   exit-during      — a phase-agent event; the sidecar closes 100 ms later, during the five-second lead (after the started file);
//   duplicate-during — a phase-agent event; a second one 100 ms later, during the lead;
//   invalid-during   — a phase-agent event; an invalid line 100 ms later, during the lead;
//   fatal-during     — a phase-agent event; a fatal event 100 ms later, during the lead;
//   summary-during   — a phase-agent event; a summary 100 ms later (an exit event with the sidecar still attached);
//   summary-exit-during — a phase-agent event; a summary and the sidecar's close 100 ms later.
// Only `valid` may write the started file and send RELEASE; all fourteen checks pass in every variant.
function inspectOf(plan, service, network) {
  const agent = service === 'agent';
  const create = plan[service].create;
  const tmpfs = {};
  for (const [index, arg] of create.entries()) {
    if (arg !== '--tmpfs') continue;
    const value = create[index + 1];
    const sep = value.indexOf(':');
    tmpfs[value.slice(0, sep)] = value.slice(sep + 1);
  }
  return {
    HostConfig: {
      NetworkMode: network, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
      Privileged: false, LogConfig: { Type: 'none' }, Tmpfs: tmpfs, PidsLimit: agent ? 512 : 128,
    },
    Mounts: plan.mounts.filter(m => m.container === service && m.kind !== 'tmpfs').map(m => ({
      Type: m.kind, Destination: m.target, RW: m.mode === 'rw', ...(m.kind === 'volume' ? { Name: m.source } : { Source: m.source }),
    })),
    Networks: { [network]: {} },
    Config: {
      User: process.getuid() + ':' + process.getgid(), Entrypoint: ['node'],
      Cmd: ['/acoder/container/' + (agent ? 'entry.mjs' : 'proxy.mjs')], EnvNames: plan[service].env_names,
    },
  };
}

async function launchWith(variant) {
  return withFixture({ noExport: true }, async fx => {
  const launcher = makeFakeRuntime();
    try {
      launcher.setImage(imageAnswer());
      const commands = [];
      const sidecarLines = [];
      let plan;
      const attach = name => {
        const agent = name.startsWith('acoder-agent-');
        const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
        const payload = JSON.parse(plan.payload_files.agent['agent-command.json']);
        const envFromCreate = plan.agent.create.find(arg => arg.startsWith('ACODER_EVENT_PREFIX='));
        const prefix = envFromCreate.slice('ACODER_EVENT_PREFIX='.length);
        const input = JSON.parse(plan.agent.create.find(arg => arg.startsWith('ACODER_PROBE_INPUT=')).slice('ACODER_PROBE_INPUT='.length));
        assert.ok(payload !== null);
        const emit = event => child.stdout.write((agent ? prefix + ' ' : '') + JSON.stringify(event) + '\n');
        const close = () => {
          if (child.closedSynthetic) return;
          child.closedSynthetic = true;
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 0, null);
        };
        child.stdin.once('end', close);
        queueMicrotask(() => {
          if (agent) {
            emit({ event: 'probes', results: Array.from({ length: 8 }, (_, index) => ({
              id: 'P' + (index + 1), result: 'pass', detail: index === 7 ? 'injected_none' : null,
            })) });
          } else {
            emit({ event: 'ready', config_sha256: createHash('sha256').update(plan.payload_files.egress['egress.json']).digest('hex'), env_names: plan.egress.env_names, clock_epoch_ms: Date.now() });
            emit({ event: 'upstream', host: plan.allowlist[0], handshake: 'ok', address: '127.0.0.1' });
            const requests = [
              ['refused', 'acoder_host_not_allowed', 403], ['refused', 'acoder_path_not_allowed', 403],
              ['local', null, 200], ['refused', 'acoder_not_released', 425],
            ];
            for (const [index, [decision, reason, status]] of requests.entries()) {
              const time = new Date().toISOString();
              emit({ event: 'request', seq: index + 1, phase: 'probe', opened: time, closed: time,
                host: plan.allowlist[0], decision, reason, status, complete: true, bytes_up: 0, bytes_down: 0,
                usage: null, response_model: null, probe: input.nonce });
            }
          }
        });
        child.stdin.on('data', chunk => {
          const line = chunk.toString().trim();
          commands.push(line.split(' ')[0]);
          if (!agent) sidecarLines.push(line);
          if (line === 'CLOCK') queueMicrotask(() => emit({ event: 'clock', clock_epoch_ms: Date.now() }));
          if (line === 'CLOCK' && !agent && variant === 'early') queueMicrotask(() => emit({ event: 'phase', phase: 'agent' }));
          if (line.startsWith('PHASE ') && ['valid', 'wrong'].includes(variant)) queueMicrotask(() => emit({ event: 'phase', phase: variant === 'valid' ? 'agent' : 'probe' }));
          const later = action => setTimeout(action, 100);
          if (line.startsWith('PHASE ') && variant === 'duplicate') queueMicrotask(() => { emit({ event: 'phase', phase: 'agent' }); emit({ event: 'phase', phase: 'agent' }); });
          if (line.startsWith('PHASE ') && variant === 'agent-probe') queueMicrotask(() => { emit({ event: 'phase', phase: 'agent' }); emit({ event: 'phase', phase: 'probe' }); });
          if (line.startsWith('PHASE ') && variant === 'exit-after') queueMicrotask(() => { emit({ event: 'phase', phase: 'agent' }); close(); });
          // Registered after the launcher's own reader, so it runs once that reader has taken the line: before the launcher's wait resumes.
          if (line.startsWith('PHASE ') && variant === 'exit-with-ack') { child.stdout.once('data', close); queueMicrotask(() => emit({ event: 'phase', phase: 'agent' })); }
          if (line.startsWith('PHASE ') && variant.endsWith('-during')) {
            queueMicrotask(() => emit({ event: 'phase', phase: 'agent' }));
            if (variant === 'exit-during') later(close);
            if (variant === 'duplicate-during') later(() => emit({ event: 'phase', phase: 'agent' }));
            if (variant === 'invalid-during') later(() => child.stdout.write('not an event\n'));
            if (variant === 'fatal-during') later(() => emit({ event: 'fatal', code: 'internal_error' }));
            const summary = () => emit({ event: 'summary', forwarded: 0, refused_probe: 3, refused_agent: 0, refused_by_reason: {},
              bytes_up: 0, bytes_down: 0, key_reflections: 0, usage_missing: 0, admitted_after_token_limit: 0, in_flight_at_limit: null, tokens: null });
            if (variant === 'summary-during') later(summary);
            if (variant === 'summary-exit-during') later(() => { summary(); child.stdout.once('data', close); });
          }
          if (line.startsWith('RELEASE ')) queueMicrotask(() => {
            emit({ event: 'released' });
            emit({ event: 'agent_started', pid: 1 });
            emit({ event: 'agent_exit', code: 0, signal: null });
            close();
          });
          if (line === 'STOP') queueMicrotask(() => {
            emit({ event: 'summary', forwarded: 0, refused_probe: 3, refused_agent: 0, refused_by_reason: {},
              bytes_up: 0, bytes_down: 0, key_reflections: 0, usage_missing: 0, admitted_after_token_limit: 0, in_flight_at_limit: null, tokens: null });
            close();
          });
        });
        return child;
      };
      const result = await runMain(fx.argv({ set: { '--image': IMAGE_ID, '--model-endpoint': 'https://model.stub.test/v1' }, drop: ['--dry-run'] }), {
        env: launcher.env(fx.env), deps: {
          launchEnabled: true,
          planTransform: value => { plan = value; return value; },
          clock: { gateMs: 3000 },
          runtime: runtime => ({ ...runtime, call: async () => ({ code: 0, stdout: 'synthetic-id', stderr: '' }), attach,
            remove: async () => [],
            inspect: async (kind, name) => {
              if (kind === 'volume') return { Driver: 'local', Options: { type: 'tmpfs', device: 'tmpfs', o: `size=1m,uid=${process.getuid()},gid=${process.getgid()},mode=0750` }, Labels: { 'acoder.run': plan.run_id } };
              if (kind === 'network') return { Containers: { 'synthetic-id': {} }, Labels: { 'acoder.run': plan.run_id } };
              return name.startsWith('acoder-agent-') ? inspectOf(plan, 'agent', 'none') : inspectOf(plan, 'egress', plan.network.name);
            },
          }),
        },
      });
      const fields = result.stdout.trim().split(' ');
      assert.notEqual(fields.at(-1), '-', `the attempt record exists: ${result.stdout} ${result.stderr}`);
      const record = JSON.parse(fs.readFileSync(fields.at(-1), 'utf8'));
      const logText = typeof record.log_path === 'string' && fs.existsSync(record.log_path) ? fs.readFileSync(record.log_path, 'utf8') : '';
      const scratchLeft = fs.existsSync(fx.writable.scratch);
      const reportsLeft = fs.existsSync(fx.writable.reportMd) || fs.existsSync(fx.writable.reportJson);
      return { result, fields, record, commands, sidecarLines, logText, scratchLeft, reportsLeft, startedFile: fs.existsSync(path.join(fx.stage, `run-${fx.tag}.started.json`)) };
    } finally {
      launcher.cleanup();
    }
  });
}

function assertAllChecksPassed(record) {
  assert.equal(record.isolation_checks.length, 14);
  assert.ok(record.isolation_checks.every(check => check.result === 'pass'), JSON.stringify(record.isolation_checks));
}

function assertNotReleased(run) {
  const { result, fields, record, commands, sidecarLines, logText, scratchLeft, reportsLeft, startedFile } = run;
  assertAllChecksPassed(record);
  assert.ok(sidecarLines.some(line => /^PHASE agent [0-9]+$/.test(line)), 'the launcher sent PHASE agent after the checks passed');
  assert.equal(commands.includes('RELEASE'), false, 'no RELEASE');
  assert.equal(startedFile, false, 'no started file');
  assert.deepEqual([result.code, fields[3]], [1, 'not-started']);
  assert.equal(record.agent_started, false);
  assert.equal(record.error_detail, 'runtime_failure');
  assert.match(logText, / launcher not started: R runtime_failure\n/, 'the attempt failed at R');
  assert.deepEqual(record.cleanup, { status: 'complete', leftovers: [] }, 'nothing left behind');
  assert.equal(scratchLeft, false, 'the scratch directory this attempt made is removed');
  assert.equal(reportsLeft, false, 'the empty reports are removed');
}

t('A3.6 (F-40-03): a probe-phase answer to PHASE agent is no acknowledgement: no RELEASE, no started file, not-started at R', async () => {
  assertNotReleased(await launchWith('wrong'));
});

t('A3.6 (F-40-03): a phase-agent event that arrived before PHASE agent was written is no acknowledgement', async () => {
  assertNotReleased(await launchWith('early'));
});

t('A3.6 (F-38-07): a withheld acknowledgement of PHASE agent gives no release', async () => {
  assertNotReleased(await launchWith('withheld'));
});

t('A3.6 (F-40-03): a phase-agent event after PHASE agent releases: the started file, then RELEASE', async () => {
  const { result, record, commands, startedFile } = await launchWith('valid');
  assertAllChecksPassed(record);
  assert.ok(commands.indexOf('PHASE') >= 0 && commands.indexOf('RELEASE') > commands.indexOf('PHASE'), commands.join(' '));
  assert.equal(startedFile, true, 'the started file was written');
  assert.equal(record.agent_started, true, `${result.stdout} ${result.stderr}`);
});

t('A3.6 (F-42-02): two phase-agent answers to PHASE agent are no acknowledgement: no started file, no RELEASE, not-started at R', async () => {
  assertNotReleased(await launchWith('duplicate'));
});

t('A3.6 (F-42-02): a probe-phase event right after the phase-agent answer refuses: no started file, no RELEASE, not-started at R', async () => {
  assertNotReleased(await launchWith('agent-probe'));
});

t('A3.6 (F-42-02): a sidecar that closes right after its acknowledgement gets no started file and no RELEASE: not-started at R', async () => {
  assertNotReleased(await launchWith('exit-after'));
});

t('A3.6 (F-42-02): a sidecar that closes as its acknowledgement is read gets no started file and no RELEASE: not-started at R', async () => {
  const run = await launchWith('exit-with-ack');
  assertNotReleased(run);
  assert.match(run.logText, /"event":"phase","phase":"agent"/, 'the acknowledgement itself was read');
});

// After the started file exists the run counts as started (A6.6): the file stays, RELEASE is never sent, the agent never starts, and the
// run ends as an error whose conditions hold runtime_failure (R failed) and the sidecar's own condition, which wins by precedence (A6.5).
function assertStartedNotReleased(run, detail) {
  const { result, fields, record, commands, startedFile } = run;
  assertAllChecksPassed(record);
  assert.equal(startedFile, true, 'the started file stays: the ticket counts as started');
  assert.equal(commands.includes('RELEASE'), false, 'no RELEASE to a sidecar that failed');
  assert.deepEqual([result.code, fields[3]], [1, 'error'], `${result.stdout} ${result.stderr}`);
  assert.equal(record.agent_started, false);
  assert.equal(record.exit_reason, 'error');
  assert.equal(record.error_detail, detail);
  assert.ok(record.conditions.includes('runtime_failure'), JSON.stringify(record.conditions));
  assert.deepEqual(record.cleanup, { status: 'complete', leftovers: [] }, 'nothing left behind');
}

t('A3.6 (F-42-02): a sidecar that closes during the lead keeps the started file but gets no RELEASE: error egress_sidecar_exited', async () => {
  assertStartedNotReleased(await launchWith('exit-during'), 'egress_sidecar_exited');
});

t('A3.6 (F-42-02): a second phase-agent event during the lead keeps the started file but sends no RELEASE: error runtime_failure', async () => {
  assertStartedNotReleased(await launchWith('duplicate-during'), 'runtime_failure');
});

t('A3.6 (F-42-02): an invalid sidecar line during the lead keeps the started file but sends no RELEASE: error egress_protocol_error', async () => {
  assertStartedNotReleased(await launchWith('invalid-during'), 'egress_protocol_error');
});

t('A3.6 (F-42-02): a fatal sidecar event during the lead keeps the started file but sends no RELEASE: error egress_protocol_error', async () => {
  assertStartedNotReleased(await launchWith('fatal-during'), 'egress_protocol_error');
});

t('A3.6 (F-42-02): a sidecar summary during the lead keeps the started file but sends no RELEASE: error runtime_failure', async () => {
  const run = await launchWith('summary-during');
  assertStartedNotReleased(run, 'runtime_failure');
  assert.equal(run.record.conditions.includes('egress_sidecar_exited'), false, 'the sidecar had not exited');
});

t('A3.6 (F-42-02): a sidecar that summarizes and then closes during the lead is an expected end, not egress_sidecar_exited (A6.5)', async () => {
  const run = await launchWith('summary-exit-during');
  assertStartedNotReleased(run, 'runtime_failure');
  assert.equal(run.record.conditions.includes('egress_sidecar_exited'), false, JSON.stringify(run.record.conditions));
});
