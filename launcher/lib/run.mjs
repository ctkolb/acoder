// runReview(options, deps): the run sequence of A6.6 on real containers. This part holds the launch plan and the payloads (A2.1, A2.2);
// the sequence itself follows below.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLACEHOLDER_KEY, agentEnvNames, buildPlan, containerBaseUrl, endpointParts, hostsFile, resolvConf } from './plan.mjs';
import { canonicalHash } from './record.mjs';

export const LAUNCHER_VERSION = '0.1.0';
const LAUNCHER_ROOT = fileURLToPath(new URL('..', import.meta.url));
const AGENT_PROGRAMS = ['container/entry.mjs', 'container/probe.mjs', 'container/relay.mjs'];
const EGRESS_PROGRAMS = ['container/proxy.mjs', 'container/accounting.mjs'];
// A8.3: the names a runtime adds to every container by itself (recorded; U1 and P8 accept them besides the plan).
export const INJECTED_ENV = { docker: ['HOME', 'HOSTNAME', 'TERM'], podman: ['HOME', 'HOSTNAME', 'TERM', 'container'] };
const sha256 = text => createHash('sha256').update(text).digest('hex');

// The plan of one attempt (A15 of plan.mjs) with the probe input of the supervisor (A8.3 ACODER_PROBE_INPUT). p6: the addresses P6 must
// not reach, [{address, port}], known only once the sidecar runs; the plan is built again with them before the agent container is created.
export function planFor({ options, settings, prepared, adapters, providers, image, runtimeName, runId, eventPrefix, nonce, uid, gid, p6 = [] }) {
  const { host, path: endpointPath } = endpointParts(settings.endpoint);
  const command = adapters[settings.agent].command({
    model: settings.model, effort: settings.effort, provider: { id: settings.provider, baseUrl: containerBaseUrl(settings.endpoint), placeholderKey: PLACEHOLDER_KEY },
    firstMessage: `This is an acoder container launch. TICKET ${prepared.tag} at ${options.ticket}`, workdir: prepared.writable.scratch,
  });
  const skillSha256 = canonicalHash(prepared.staging.skill);
  const profile = providers?.[settings.provider];
  const allowedPath = `${endpointPath}${profile?.requests?.[0]?.suffix ?? '/responses'}`;
  const { writable } = prepared;
  const probeInput = {
    nonce, run_id: runId, tag: prepared.tag, ticket_sha256: prepared.ticket.sha256, skill_sha256: skillSha256,
    hosts_sha256: sha256(hostsFile([host])), resolv_sha256: sha256(resolvConf()), allowed_names: [host],
    probe_paths: { allowed: allowedPath, denied: `${endpointPath}/acoder-probe-denied` }, p6,
    env_names: agentEnvNames(command.env, image.env_names), env_allowance: INJECTED_ENV[runtimeName], uid, gid,
    paths: {
      ticket: options.ticket, ledger: path.join(options.mailbox, 'orchestrator', 'tickets.json'), beside: path.join(writable.stage, `acoder-probe-${nonce}`),
      scratch: writable.scratch, report_md: writable.reportMd, report_json: writable.reportJson,
    },
  };
  return buildPlan({
    runtime: runtimeName, runId, tag: prepared.tag, ticketSha256: prepared.ticket.sha256, skillSha256, launcherVersion: LAUNCHER_VERSION,
    uid, gid, image: image.id, imageEnvNames: image.env_names, mailbox: options.mailbox,
    exports: options.exports.map(({ role }) => ({ role, dir: prepared.exports[role].dir, insideMailbox: prepared.exports[role].inside_mailbox })),
    staging: {
      dir: prepared.staging.dir, mailbox: prepared.staging.mailbox, agentPayload: path.join(prepared.staging.dir, 'agent-payload'), egressPayload: path.join(prepared.staging.dir, 'egress-payload'),
      exports: Object.fromEntries(options.exports.map(({ role }) => [role, prepared.exports[role].copy])),
    },
    writable: { scratch: writable.scratch, reportMd: writable.reportMd, reportJson: writable.reportJson }, scratchSize: options.scratchSize, limits: settings.limits,
    endpoint: settings.endpoint, provider: { id: settings.provider }, agent: command, extraCa: options.extraCaCert !== null, eventPrefix, probeInput,
  });
}

function writeNew(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
}

// A source file of the payload is read with no-follow (a link is never copied).
function readSource(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}

function makeReadOnly(directory) {
  for (const name of fs.readdirSync(directory)) {
    const full = path.join(directory, name);
    const info = fs.lstatSync(full);
    if (info.isDirectory()) makeReadOnly(full);
    else if (info.isFile()) fs.chmodSync(full, 0o444);
  }
  fs.chmodSync(directory, 0o555);
}

// A2.1 M1 and A2.2 E1: the agent payload (supervisor, probe, relay, the skill copy made by the snapshot, run.json, the agent command file,
// /etc/hosts and /etc/resolv.conf) and the egress payload (sidecar, accounting, provider profile, egress.json, optional ca.pem), both in
// the staging directory and read-only. sidecarProgram (test seam deps.sidecarProgram) replaces proxy.mjs.
export function stagePayloads({ plan, prepared, options, sidecarProgram = null }) {
  const agentDir = path.join(prepared.staging.dir, 'agent-payload');
  const egressDir = path.join(prepared.staging.dir, 'egress-payload');
  fs.chmodSync(agentDir, 0o700);
  for (const relative of AGENT_PROGRAMS) writeNew(path.join(agentDir, relative), readSource(path.join(LAUNCHER_ROOT, relative)));
  for (const [relative, text] of Object.entries(plan.payload_files.agent)) writeNew(path.join(agentDir, relative), text);
  fs.mkdirSync(egressDir, { mode: 0o700 });
  for (const relative of EGRESS_PROGRAMS) {
    const from = relative === 'container/proxy.mjs' && sidecarProgram !== null ? sidecarProgram : path.join(LAUNCHER_ROOT, relative);
    writeNew(path.join(egressDir, relative), readSource(from));
  }
  const providerId = JSON.parse(plan.payload_files.egress['egress.json']).provider.id;
  writeNew(path.join(egressDir, 'providers', `${providerId}.mjs`), readSource(path.join(LAUNCHER_ROOT, 'providers', `${providerId}.mjs`)));
  for (const [relative, text] of Object.entries(plan.payload_files.egress)) writeNew(path.join(egressDir, relative), text);
  if (options.extraCaCert !== null) writeNew(path.join(egressDir, 'ca.pem'), readSource(options.extraCaCert));
  for (const dir of [path.join(agentDir, 'container'), path.join(agentDir, 'etc'), egressDir]) makeReadOnly(dir);
  for (const name of ['run.json', 'agent-command.json']) fs.chmodSync(path.join(agentDir, name), 0o444);
  fs.chmodSync(agentDir, 0o555);
  return { agent: agentDir, egress: egressDir };
}

// The gate and the run sequence (red-commit placeholders; the implementation follows).
export const CHECK_IDS = ['H1', 'H2', 'H3', 'H4', 'U1', 'U2', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];
const placeholder = () => ({ result: 'pass', detail: null });
export const checkH1 = placeholder;
export const checkH2 = placeholder;
export const checkH3 = placeholder;
export const checkH4 = placeholder;
export const checkU1 = placeholder;
export const checkU2 = placeholder;
export const corroborate = results => results;
export async function runReview() { return { outcome: 'refused', exit_code: 2, record: '-', tag: '-', run_id: 'none', leftovers: [] }; }
