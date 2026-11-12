// main(argv, env, deps): dispatch, exit codes and the last line of A1.6. The binary and the tests call this one function.
import { parseReviewRun } from './args.mjs';
import { checkApiKey, loadDefaults, loadOwnerConfig, resolveSettings } from './config.mjs';
import { prepare } from './prepare.mjs';
import { Refusal, safe } from './refusal.mjs';

const GUARD = 'this build of the launcher is incomplete; container launch is disabled';
const TICKET_NAME = /^ticket-([A-Za-z0-9._-]{1,120})\.md$/;

const tagOf = ticket => TICKET_NAME.exec(ticket.slice(ticket.lastIndexOf('/') + 1))?.[1] ?? '-';

function dryRunPlan(options, settings) {
  return {
    schema: 'acoder-launch-plan/0', dry_run: true, tag: tagOf(options.ticket),
    agent: settings.agent, provider: settings.provider, model: settings.model, effort: settings.effort, endpoint: settings.endpoint, limits: settings.limits,
    image: { ref: options.image, check: 'not_run' }, runtime: { name: options.runtime ?? 'auto', check: 'not_run' },
    key: { env: options.apiKeyEnv, checked: true },
  };
}

async function reviewRun(argv, env, deps, io) {
  let tag = '-';
  try {
    const options = parseReviewRun(argv);
    tag = tagOf(options.ticket);
    const owner = loadOwnerConfig(options.config);
    const settings = resolveSettings({ options, owner, defaults: loadDefaults(), adapters: deps.adapters, providers: deps.providers });
    checkApiKey(env, options.apiKeyEnv);
    if (!options.dryRun && deps.launchEnabled !== true) throw new Refusal(GUARD);
    const prepared = prepare(options, env, deps);
    try {
      if (!options.dryRun) throw new Refusal('the launch sequence is not available in this build part');
      io.stdout.write(`${JSON.stringify(dryRunPlan(options, settings), null, 2)}\n`);
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

export async function main(argv, env, deps) {
  const io = { stdout: deps.stdout ?? process.stdout, stderr: deps.stderr ?? process.stderr };
  const [command, subcommand, ...rest] = argv;
  if (command === 'review' && subcommand === 'run') return reviewRun(rest, env, deps, io);
  if (command === 'export' && subcommand === 'manifest') {
    io.stderr.write('refused: export manifest is not available in this build part\n');
    return 2;
  }
  io.stderr.write('refused: usage: acoder review run <flags> | acoder review cleanup <flags> | acoder export manifest <flags>\n');
  return 2;
}
