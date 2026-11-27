// main(argv, env, deps): dispatch, exit codes and the last line of A1.6. The binary and the tests call this one function.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { parseExportManifest, parseReviewRun } from './args.mjs';
import { writeManifest } from './integrity.mjs';
import { checkApiKey, loadDefaults, loadOwnerConfig, resolveSettings } from './config.mjs';
import { checkHomeRule, checkInputPath, resolveHome } from './paths.mjs';
import { PLACEHOLDER_KEY, agentEnvNames, buildPlan, containerBaseUrl, endpointParts } from './plan.mjs';
import { prepare } from './prepare.mjs';
import { reviewCleanup, runReview } from './run.mjs';
import { canonicalHash, makeRunId } from './record.mjs';
import { Refusal, safe } from './refusal.mjs';
import { OUTCOMES } from './state.mjs';

const TAG = /^[A-Za-z0-9._-]{1,120}$/;

// A1.6: the last line on standard output, always `ACODER LAUNCH <tag> <outcome> <record>`; `-` stands for a tag that could not be established
// and for a record that was not written (a refusal never has one).
export function formatLastLine({ tag, outcome, record }) {
  if (tag !== '-' && !TAG.test(tag)) throw new Error('the tag of the last line is - or a ticket tag');
  if (!OUTCOMES.includes(outcome)) throw new Error('unknown outcome');
  if (record !== '-' && !(path.isAbsolute(record) && !/[\x00-\x1f\x7f ]/.test(record))) throw new Error('the record of the last line is - or an absolute path');
  if (outcome === 'refused' && record !== '-') throw new Error('a refusal has no record');
  return `ACODER LAUNCH ${tag} ${outcome} ${record}`;
}

export const LAUNCHER_VERSION = '0.2.1';
const GUARD = 'this build of the launcher is incomplete; container launch is disabled';
const TICKET_NAME = /^ticket-([A-Za-z0-9._-]{1,120})\.md$/;

// The owner configuration file is read before the launch paths are checked, so it gets its path rules first (A2.4.1, A2.6).
function checkSource(file, label, home) {
  checkInputPath(file, label);
  checkHomeRule(file, home, label);
}

const tagOf = ticket => TICKET_NAME.exec(ticket.slice(ticket.lastIndexOf('/') + 1))?.[1] ?? '-';

// A15: the complete runtime arguments of both containers, the volume and the network. A dry run has not inspected the image, so the image
// argument is the reference as given, and the runtime is `--runtime` or Docker (the plan only differs in a few Podman options).
function launchPlan(options, settings, prepared, deps) {
  const { host } = endpointParts(settings.endpoint);
  const command = deps.adapters[settings.agent].command({
    model: settings.model, effort: settings.effort, provider: { id: settings.provider, baseUrl: containerBaseUrl(settings.endpoint), placeholderKey: PLACEHOLDER_KEY },
    firstMessage: `This is an acoder container launch. TICKET ${prepared.tag} at ${options.ticket}`, workdir: prepared.writable.scratch,
  });
  const skillSha256 = canonicalHash(prepared.staging.skill);
  const names = agentEnvNames(command.env, []);
  return buildPlan({
    runtime: options.runtime ?? 'docker', runId: makeRunId(), tag: prepared.tag, ticketSha256: prepared.ticket.sha256, skillSha256, launcherVersion: LAUNCHER_VERSION,
    uid: process.getuid(), gid: process.getgid(), image: options.image, imageEnvNames: [], mailbox: options.mailbox,
    exports: options.exports.map(({ role }) => ({ role, dir: prepared.exports[role].dir, insideMailbox: prepared.exports[role].inside_mailbox })),
    staging: {
      dir: prepared.staging.dir, mailbox: prepared.staging.mailbox, agentPayload: path.join(prepared.staging.dir, 'agent-payload'), egressPayload: path.join(prepared.staging.dir, 'egress-payload'),
      exports: Object.fromEntries(options.exports.map(({ role }) => [role, prepared.exports[role].copy])),
    },
    writable: { scratch: prepared.writable.scratch, reportMd: prepared.writable.reportMd, reportJson: prepared.writable.reportJson }, scratchSize: options.scratchSize, limits: settings.limits,
    endpoint: settings.endpoint, provider: { id: settings.provider }, agent: command, extraCa: options.extraCaCert !== null, eventPrefix: randomBytes(16).toString('hex'),
    probeInput: { hashes: { ticket_sha256: prepared.ticket.sha256, skill_sha256: skillSha256 }, p6_addresses: [], allowed_names: [host], env_names: names },
  });
}

function dryRunPlan(options, settings, prepared, deps) {
  return {
    schema: 'acoder-launch-plan/0', dry_run: true, tag: tagOf(options.ticket),
    agent: settings.agent, provider: settings.provider, model: settings.model, effort: settings.effort, endpoint: settings.endpoint, limits: settings.limits,
    image: { ref: options.image, check: 'not_run' }, runtime: { name: options.runtime ?? 'auto', check: 'not_run' },
    key: { env: options.apiKeyEnv, checked: true },
    ticket: prepared.ticket, mailbox: options.mailbox, allow_image_env: options.allowImageEnv, excluded: prepared.excluded,
    exports: options.exports.map(({ role }) => ({
      role, path: prepared.exports[role].dir, inside_mailbox: prepared.exports[role].inside_mailbox, manifest: prepared.manifests[role].path,
      manifest_sha256: prepared.manifests[role].sha256, source_commit: prepared.manifests[role].source_commit, tree_sha256: prepared.exports[role].tree_sha256, entries: prepared.exports[role].entries,
    })),
    writable: { scratch: prepared.writable.scratch, report_md: prepared.writable.reportMd, report_json: prepared.writable.reportJson },
    snapshot: { bytes: prepared.snapshot.bytes, entries: prepared.snapshot.entries, skill_sha256: canonicalHash(prepared.staging.skill) },
    launch: launchPlan(options, settings, prepared, deps),
  };
}

async function reviewRun(argv, env, deps, io) {
  let tag = '-';
  try {
    const options = parseReviewRun(argv);
    tag = tagOf(options.ticket);
    if (options.config !== null) checkSource(options.config, '--config', resolveHome(env, deps));
    const owner = loadOwnerConfig(options.config);
    const settings = resolveSettings({ options, owner, defaults: loadDefaults(), adapters: deps.adapters, providers: deps.providers });
    checkApiKey(env, options.apiKeyEnv);
    if (!options.dryRun && deps.launchEnabled !== true) throw new Refusal(GUARD);
    if (!options.dryRun) {
      const result = await runReview({ options, settings, env }, deps);
      for (const leftover of result.leftovers ?? []) io.stderr.write(`leftover: ${safe(leftover)}\n`);
      if (typeof result.error === 'string') io.stderr.write(`error: ${safe(result.error)}\n`);
      io.stdout.write(`${formatLastLine({ tag: result.tag, outcome: result.outcome, record: result.record })}\n`);
      return result.exit_code;
    }
    const prepared = prepare(options, env, deps);
    try {
      io.stdout.write(`${JSON.stringify(dryRunPlan(options, settings, prepared, deps), null, 2)}\n`);
      return 0;
    } finally {
      prepared.cleanup();
    }
  } catch (error) {
    if (error instanceof Refusal) {
      io.stderr.write(`refused: ${error.message}\n`);
      io.stdout.write(`${formatLastLine({ tag, outcome: 'refused', record: '-' })}\n`);
      return 2;
    }
    io.stderr.write(`error: ${safe(error?.message ?? error)}\n`);
    io.stdout.write(`${formatLastLine({ tag, outcome: 'error', record: '-' })}\n`);
    return 1;
  }
}

async function exportManifest(argv, io) {
  try {
    io.stdout.write(`${writeManifest(parseExportManifest(argv))}\n`);
    return 0;
  } catch (error) {
    if (error instanceof Refusal) {
      io.stderr.write(`refused: ${error.message}\n`);
      return 2;
    }
    io.stderr.write(`error: ${safe(error?.message ?? error)}\n`);
    return 1;
  }
}

export async function main(argv, env, deps) {
  const io = { stdout: deps.stdout ?? process.stdout, stderr: deps.stderr ?? process.stderr };
  const [command, subcommand, ...rest] = argv;
  if (command === 'review' && subcommand === 'run') return reviewRun(rest, env, deps, io);
  // A6.9: the owner's recovery after a killed launcher; it works while launch is disabled (A1.8).
  if (command === 'review' && subcommand === 'cleanup') return reviewCleanup(rest, env, deps, io);
  if (command === 'export' && subcommand === 'manifest') return exportManifest(rest, io);
  io.stderr.write('refused: usage: acoder review run <flags> | acoder review cleanup <flags> | acoder export manifest <flags>\n');
  return 2;
}
