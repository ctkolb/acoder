// main(argv, env, deps): dispatch, exit codes and the last line of A1.6. The binary and the tests call this one function.
import { parseExportManifest, parseReviewRun } from './args.mjs';
import { writeManifest } from './integrity.mjs';
import { checkApiKey, loadDefaults, loadOwnerConfig, resolveSettings } from './config.mjs';
import { checkHomeRule, checkInputPath, resolveHome } from './paths.mjs';
import { prepare } from './prepare.mjs';
import { Refusal, safe } from './refusal.mjs';

export const formatLastLine = () => { throw new Error('not implemented'); };

const GUARD = 'this build of the launcher is incomplete; container launch is disabled';
const TICKET_NAME = /^ticket-([A-Za-z0-9._-]{1,120})\.md$/;

// The owner configuration file is read before the launch paths are checked, so it gets its path rules first (A2.4.1, A2.6).
function checkSource(file, label, home) {
  checkInputPath(file, label);
  checkHomeRule(file, home, label);
}

const tagOf = ticket => TICKET_NAME.exec(ticket.slice(ticket.lastIndexOf('/') + 1))?.[1] ?? '-';

function dryRunPlan(options, settings, prepared) {
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
    snapshot: { bytes: prepared.snapshot.bytes, entries: prepared.snapshot.entries, skill_sha256: prepared.skillSha256 },
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
    const prepared = prepare(options, env, deps);
    try {
      if (!options.dryRun) throw new Refusal('the launch sequence is not available in this build part');
      io.stdout.write(`${JSON.stringify(dryRunPlan(options, settings, prepared), null, 2)}\n`);
      return 0;
    } finally {
      prepared.cleanup();
    }
  } catch (error) {
    if (error instanceof Refusal) {
      io.stderr.write(`refused: ${error.message}\n`);
      io.stdout.write(`ACODER LAUNCH ${tag} refused -\n`);
      return 2;
    }
    io.stderr.write(`error: ${safe(error?.message ?? error)}\n`);
    io.stdout.write(`ACODER LAUNCH ${tag} error -\n`);
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
  if (command === 'export' && subcommand === 'manifest') return exportManifest(rest, io);
  io.stderr.write('refused: usage: acoder review run <flags> | acoder review cleanup <flags> | acoder export manifest <flags>\n');
  return 2;
}
