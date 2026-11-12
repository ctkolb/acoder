// Flag parsing and validation (A1.5). Every problem is a Refusal; nothing here touches the file system.
import path from 'node:path';
import { Refusal, safe } from './refusal.mjs';

export const DEFAULT_SCRATCH_MAX_BYTES = 4294967296;
export const DEFAULT_SNAPSHOT_MAX_BYTES = 4294967296;
const ROLE = /^[a-z0-9-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const NAME = /^[a-z0-9-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IMAGE = /^(?:[A-Za-z0-9][A-Za-z0-9._/:-]*@)?sha256:[0-9a-f]{64}$/;
const MODEL = /^(?:[a-z0-9-]+\/)?[A-Za-z0-9._:-]+$/;

export function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
    throw new Refusal(`${label} must be a whole number from 1 to ${maximum === Number.MAX_SAFE_INTEGER ? '9007199254740991' : maximum}`);
  }
  return Number(value);
}

const absolute = (value, label) => {
  if (!path.isAbsolute(value)) throw new Refusal(`${label} must be an absolute path`);
  return value;
};
const pattern = (regex, what) => (value, label) => {
  if (!regex.test(value)) throw new Refusal(`${label} must be ${what}`);
  return value;
};

// "https://<DNS host name>[:443]/<path>": no IP literal, no user info, no query, no fragment (A1.5).
export function checkEndpoint(value, label) {
  const fail = why => new Refusal(`${label} ${why}`);
  if (typeof value !== 'string' || !/^https:\/\/[^/]/.test(value) || /[\u0000-\u0020\u007f\\?#]/u.test(value)) throw fail('must be a plain https URL without query or fragment');
  let url;
  try { url = new URL(value); } catch { throw fail('is not a valid URL'); }
  if (url.protocol !== 'https:') throw fail('must use the https scheme');
  if (url.username !== '' || url.password !== '') throw fail('must not hold user info');
  if (url.port !== '') throw fail('must use no port or port 443');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(url.hostname) || /^[0-9.]+$/.test(url.hostname)) throw fail('must name a DNS host, not an IP address');
  return value;
}

function checkExclude(value, label) {
  if (value === '' || path.isAbsolute(value) || value.includes('\0') || value.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Refusal(`${label} must be a relative path inside the mailbox without empty, . or .. parts`);
  }
  return value;
}

// name -> { key, parse(value, label), repeat, boolean }
const REVIEW_FLAGS = {
  '--ticket': { key: 'ticket', parse: absolute }, '--ticket-sha256': { key: 'ticketSha256', parse: pattern(HEX64, '64 lower-case hex characters') },
  '--mailbox': { key: 'mailbox', parse: absolute }, '--export': { key: 'export', repeat: true, parse: (value, label) => rolePair(value, label, absolute) },
  '--manifest': { key: 'manifest', repeat: true, parse: (value, label) => rolePair(value, label, absolute) },
  '--manifest-sha256': { key: 'manifestSha256', repeat: true, parse: (value, label) => rolePair(value, label, pattern(HEX64, '64 lower-case hex characters')) },
  '--no-export': { key: 'noExport', boolean: true }, '--exclude': { key: 'exclude', repeat: true, parse: checkExclude },
  '--image': { key: 'image', parse: pattern(IMAGE, '<name>@sha256:<64 hex> or sha256:<64 hex> (a tag is refused)') },
  '--allow-image-env': { key: 'allowImageEnv', repeat: true, parse: pattern(ENV_NAME, 'an environment variable name') },
  '--model-endpoint': { key: 'modelEndpoint', parse: checkEndpoint }, '--provider': { key: 'provider', parse: pattern(NAME, 'a provider name') },
  '--model': { key: 'model', parse: pattern(MODEL, 'a model id, optionally <provider>/<id>') }, '--effort': { key: 'effort', parse: pattern(/^[a-z]+$/, 'lower-case letters') },
  '--agent': { key: 'agent', parse: pattern(NAME, 'an adapter name') },
  '--budget-minutes': { key: 'budgetMinutes', parse: positiveInteger }, '--budget-calls': { key: 'budgetCalls', parse: positiveInteger }, '--budget-tokens': { key: 'budgetTokens', parse: positiveInteger },
  '--max-in-flight': { key: 'maxInFlight', parse: (value, label) => positiveInteger(value, label, 16) },
  '--api-key-env': { key: 'apiKeyEnv', parse: pattern(ENV_NAME, 'an environment variable name') }, '--config': { key: 'config', parse: absolute },
  '--runtime': { key: 'runtime', parse: pattern(/^(docker|podman)$/, 'docker or podman') }, '--extra-ca-cert': { key: 'extraCaCert', parse: absolute },
  '--scratch-size': { key: 'scratchSize', parse: pattern(/^[1-9][0-9]*[kmg]?$/, 'a size such as 512m or 2g') },
  '--scratch-max-bytes': { key: 'scratchMaxBytes', parse: positiveInteger }, '--reviewer-skill': { key: 'reviewerSkill', parse: absolute },
  '--staging-dir': { key: 'stagingDir', parse: absolute }, '--snapshot-max-bytes': { key: 'snapshotMaxBytes', parse: positiveInteger },
  '--dry-run': { key: 'dryRun', boolean: true },
};
const REQUIRED = ['--ticket', '--ticket-sha256', '--mailbox', '--image', '--budget-minutes', '--budget-calls', '--budget-tokens'];

function rolePair(value, label, parseRest) {
  const at = value.indexOf('=');
  if (at < 0) throw new Refusal(`${label} needs <role>=<value>`);
  const role = value.slice(0, at);
  if (!ROLE.test(role)) throw new Refusal(`${label} has a role that does not match [a-z0-9-]+`);
  return { role, value: parseRest(value.slice(at + 1), label) };
}

// A flag's value is the next argument; a value that starts with "--" is a missing value, so a mistyped flag is never swallowed.
function collect(argv, spec) {
  const found = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) throw new Refusal(`unexpected argument ${safe(flag.slice(0, 40))}`);
    const definition = spec[flag];
    if (definition === undefined) throw new Refusal(`unknown flag ${safe(flag.split('=')[0].slice(0, 40))}`);
    if (found.has(flag) && !definition.repeat) throw new Refusal(`${flag} was given twice`);
    let value = true;
    if (!definition.boolean) {
      index += 1;
      if (argv[index] === undefined || argv[index].startsWith('--')) throw new Refusal(`${flag} needs a value`);
      value = definition.parse(argv[index], flag);
    }
    found.set(flag, [...(found.get(flag) ?? []), value]);
  }
  return found;
}

export function parseReviewRun(argv) {
  const found = collect(argv, REVIEW_FLAGS);
  for (const flag of REQUIRED) if (!found.has(flag)) throw new Refusal(`missing required flag ${flag}`);
  const one = flag => found.get(flag)?.[0] ?? null;
  if (found.has('--export') && found.has('--no-export')) throw new Refusal('--export and --no-export cannot be used together');
  if (!found.has('--export') && !found.has('--no-export')) throw new Refusal('give --export or --no-export');
  const exports = (found.get('--export') ?? []).map(({ role, value }) => ({ role, dir: value }));
  const roles = new Set();
  for (const { role } of exports) {
    if (roles.has(role)) throw new Refusal(`duplicate export role ${role}`);
    roles.add(role);
  }
  const perRole = flag => {
    const map = {};
    for (const { role, value } of found.get(flag) ?? []) {
      if (!roles.has(role)) throw new Refusal(`${flag} names role ${role}, which has no --export`);
      if (role in map) throw new Refusal(`duplicate ${flag} for role ${role}`);
      map[role] = value;
    }
    return map;
  };
  const manifests = perRole('--manifest');
  const manifestSha256 = perRole('--manifest-sha256');
  for (const role of roles) {
    if (!(role in manifests)) throw new Refusal(`role ${role} has --export but no --manifest`);
    if (!(role in manifestSha256)) throw new Refusal(`role ${role} has --export but no --manifest-sha256`);
  }
  return {
    ticket: one('--ticket'), ticketSha256: one('--ticket-sha256'), mailbox: one('--mailbox'), exports, noExport: found.has('--no-export'), manifests, manifestSha256,
    excludes: found.get('--exclude') ?? [], image: one('--image'), allowImageEnv: found.get('--allow-image-env') ?? [], modelEndpoint: one('--model-endpoint'),
    provider: one('--provider'), model: one('--model'), effort: one('--effort'), agent: one('--agent'),
    budgetMinutes: one('--budget-minutes'), budgetCalls: one('--budget-calls'), budgetTokens: one('--budget-tokens'), maxInFlight: one('--max-in-flight'),
    apiKeyEnv: one('--api-key-env') ?? 'ACODER_MODEL_API_KEY', config: one('--config'), runtime: one('--runtime'), extraCaCert: one('--extra-ca-cert'),
    scratchSize: one('--scratch-size') ?? '2g', scratchMaxBytes: one('--scratch-max-bytes') ?? DEFAULT_SCRATCH_MAX_BYTES,
    reviewerSkill: one('--reviewer-skill'), stagingDir: one('--staging-dir'), snapshotMaxBytes: one('--snapshot-max-bytes') ?? DEFAULT_SNAPSHOT_MAX_BYTES, dryRun: found.has('--dry-run'),
  };
}

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const EXPORT_MANIFEST_FLAGS = {
  '--export': { key: 'export', parse: absolute }, '--out': { key: 'out', parse: absolute },
  '--source-commit': { key: 'sourceCommit', parse: pattern(COMMIT, '40 or 64 lower-case hex characters') },
};

export function parseExportManifest(argv) {
  const found = collect(argv, EXPORT_MANIFEST_FLAGS);
  for (const flag of Object.keys(EXPORT_MANIFEST_FLAGS)) if (!found.has(flag)) throw new Refusal(`missing required flag ${flag}`);
  return { exportDir: found.get('--export')[0], sourceCommit: found.get('--source-commit')[0], out: found.get('--out')[0] };
}
