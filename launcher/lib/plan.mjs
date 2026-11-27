// The pure construction of the runtime arguments of both containers, the volume and the network (A2.1, A2.2, A3.1, A3.3, A8.3), and the
// image configuration check (A8.4, A10.3). Nothing here touches the file system, the runtime or the key: the function has no parameter
// that could carry the key, so no argument, payload file or plan field can hold it.
import { Refusal, safe } from './refusal.mjs';

export const PLACEHOLDER_KEY = 'acoder-placeholder-not-a-key';
export const UPSTREAM_KEY_ENV = 'ACODER_UPSTREAM_KEY';
const RELAY_PORT = 8080;
const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HEX64 = /^[0-9a-f]{64}$/;
const IMAGE_BUILT_IN_ENV = ['PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'TZ', 'NODE_VERSION', 'YARN_VERSION'];
const LAUNCHER_ENV = ['ACODER_CONTAINER', 'ACODER_RUN_ID', 'ACODER_TAG', 'ACODER_TICKET_SHA256', 'ACODER_EVENT_PREFIX', 'ACODER_PROBE_INPUT'];
const INPUT_FIELDS = [
  'runtime', 'runId', 'tag', 'ticketSha256', 'skillSha256', 'launcherVersion', 'uid', 'gid', 'image', 'imageEnvNames', 'mailbox', 'exports', 'staging', 'writable', 'scratchSize', 'limits', 'endpoint',
  'provider', 'agent', 'extraCa', 'eventPrefix', 'probeInput',
];

const fail = message => { throw new Error(`invalid plan input: ${message}`); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isInt = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;

// The --mount syntax is comma separated and a path with a quote, a backslash or a control character is never passed (A2.4.4).
function safePath(value, label) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[,"\\\x00-\x1f\x7f]/.test(value)) fail(`${label} is not an absolute path that can be passed to the runtime`);
  return value;
}

// A3.1.5, A1.5: the allowed host and the path of the endpoint (https, a DNS name, no port, no user info, no query, no fragment).
export function endpointParts(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { fail('the endpoint is not a URL'); }
  if (typeof endpoint !== 'string' || /[\s?#\\]/.test(endpoint) || url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || !HOST_NAME.test(url.hostname)) {
    fail('the endpoint is not an https URL with a DNS host name, no port, no user info, no query and no fragment');
  }
  return { host: url.hostname, path: url.pathname.replace(/\/+$/, '') };
}

// A3.1.5: the base URL the agent CLI is configured with: plain HTTP on the loopback relay, the host name resolved by the hosts file (M11).
export function containerBaseUrl(endpoint) {
  const { host, path } = endpointParts(endpoint);
  return `http://${host}:${RELAY_PORT}${path}`;
}

// M11 and M12 (A2.1, A3.4).
export function hostsFile(names) {
  for (const name of names) if (typeof name !== 'string' || !HOST_NAME.test(name)) fail('an allowed name is not a DNS host name');
  return `127.0.0.1 localhost\n${names.map(name => `127.0.0.1 ${name}\n`).join('')}`;
}
export const resolvConf = () => '# acoder: no name server is configured\n';

// A8.3: the names the agent container is expected to have: the launcher's, the adapter's and the image-defined ones accepted by A8.4.
export const agentEnvNames = (adapterEnv, imageEnvNames) => [...new Set([...LAUNCHER_ENV, ...Object.keys(adapterEnv), ...imageEnvNames])].sort();

function validate(input) {
  if (!isObject(input)) fail('the input is not an object');
  for (const key of Object.keys(input)) if (!INPUT_FIELDS.includes(key)) fail(`unknown field ${safe(key)}`);
  for (const key of INPUT_FIELDS) if (!(key in input)) fail(`missing field ${key}`);
  if (!['docker', 'podman'].includes(input.runtime)) fail('the runtime is docker or podman');
  if (typeof input.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(input.runId)) fail('the run id is not a runtime resource name');
  if (typeof input.tag !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(input.tag)) fail('the tag is not a ticket tag');
  for (const field of ['ticketSha256', 'skillSha256']) if (typeof input[field] !== 'string' || !HEX64.test(input[field])) fail(`${field} is not 64 lower-case hex characters`);
  if (typeof input.launcherVersion !== 'string' || input.launcherVersion === '') fail('the launcher version is missing');
  if (!isInt(input.uid) || !isInt(input.gid)) fail('uid and gid are non-negative integers');
  if (typeof input.image !== 'string' || !/^(?:[^\s,"\\]+@)?sha256:[0-9a-f]{64}$/.test(input.image)) fail('the image is <name>@sha256:<64 hex> or sha256:<64 hex>');
  if (!Array.isArray(input.imageEnvNames) || !input.imageEnvNames.every(name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) fail('the image environment names are not variable names');
  safePath(input.mailbox, 'the mailbox');
  if (!Array.isArray(input.exports)) fail('exports is a list');
  const roles = new Set();
  for (const entry of input.exports) {
    if (!isObject(entry) || typeof entry.role !== 'string' || !/^[a-z0-9-]+$/.test(entry.role) || roles.has(entry.role) || typeof entry.insideMailbox !== 'boolean') fail('an export is {role, dir, insideMailbox} with a unique role');
    roles.add(entry.role);
    safePath(entry.dir, `export ${entry.role}`);
  }
  const { staging, writable } = input;
  if (!isObject(staging) || !isObject(staging.exports)) fail('staging is {dir, mailbox, agentPayload, egressPayload, exports}');
  for (const field of ['dir', 'mailbox', 'agentPayload', 'egressPayload']) safePath(staging[field], `staging.${field}`);
  for (const entry of input.exports) if (!entry.insideMailbox) safePath(staging.exports[entry.role], `the staged copy of export ${entry.role}`);
  if (!isObject(writable)) fail('writable is {scratch, reportMd, reportJson}');
  for (const field of ['scratch', 'reportMd', 'reportJson']) safePath(writable[field], `writable.${field}`);
  if (typeof input.scratchSize !== 'string' || !/^[1-9][0-9]*[kmg]?$/.test(input.scratchSize)) fail('the scratch size is a number with an optional k, m or g');
  const { limits } = input;
  if (!isObject(limits) || !isInt(limits.wall_seconds, 1) || !isInt(limits.calls, 1) || !(limits.tokens === null || isInt(limits.tokens, 1)) || !isInt(limits.max_in_flight, 1) || limits.max_in_flight > 16 || !isInt(limits.scratch_max_bytes, 1)) {
    fail('the limits are positive integers');
  }
  if (!isObject(input.provider) || Object.keys(input.provider).join() !== 'id' || !/^[a-z0-9-]+$/.test(input.provider.id)) fail('the provider is {id}');
  const { agent } = input;
  if (!isObject(agent) || !Array.isArray(agent.argv) || agent.argv.length === 0 || !agent.argv.every(item => typeof item === 'string' && !item.includes('\0')) || !isObject(agent.env)) fail('the agent command is {argv, env}');
  for (const [name, value] of Object.entries(agent.env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || name.startsWith('ACODER_') || typeof value !== 'string' || value.includes('\0')) fail(`the adapter environment entry ${safe(name)} cannot be passed`);
  }
  if (new Set([...Object.keys(agent.env), ...input.imageEnvNames]).size !== Object.keys(agent.env).length + new Set(input.imageEnvNames).size) fail('an environment name is defined twice');
  if (input.imageEnvNames.some(name => name.startsWith('ACODER_') || name === 'NODE_EXTRA_CA_CERTS')) fail('an image variable shadows a variable of the launcher');
  if (typeof input.extraCa !== 'boolean') fail('extraCa is a boolean');
  if (typeof input.eventPrefix !== 'string' || !/^[0-9a-f]{32}$/.test(input.eventPrefix)) fail('the event prefix is 32 lower-case hex characters');
  if (!isObject(input.probeInput)) fail('the probe input is an object');
  return endpointParts(input.endpoint);
}

const TMPFS_OPTIONS = size => ({ '/work': `rw,exec,size=${size},mode=1777`, '/tmp': 'rw,size=64m', '/agent': 'rw,size=256m' });

// One mount of the plan: its record in the shape of A9 and its runtime arguments. Binds and volumes use the explicit --mount syntax.
function mountOf(container, target, source, kind, mode, role, tmpfsOptions = null) {
  const record = { container, target, source, kind, mode, persistent: kind === 'bind', role };
  const args = kind === 'tmpfs' ? ['--tmpfs', `${target}:${tmpfsOptions}`] : ['--mount', `type=${kind},source=${source},target=${target}${mode === 'ro' ? ',readonly' : ''}`];
  return { record, args };
}

export function buildPlan(input) {
  const { host, path } = validate(input);
  const { runId, uid, gid, image, runtime, writable, staging } = input;
  const label = `acoder.run=${runId}`;
  const names = { agent: `acoder-agent-${runId}`, egress: `acoder-sidecar-${runId}`, volume: `acoder-egress-${runId}`, network: `acoder-ext-${runId}` };
  const tmpfs = TMPFS_OPTIONS(input.scratchSize);
  const agentMounts = [
    mountOf('agent', '/acoder', staging.agentPayload, 'bind', 'ro', 'payload'),
    mountOf('agent', input.mailbox, staging.mailbox, 'bind', 'ro', 'mailbox'),
    ...input.exports.filter(entry => !entry.insideMailbox).map(entry => mountOf('agent', entry.dir, staging.exports[entry.role], 'bind', 'ro', 'export')),
    mountOf('agent', writable.scratch, writable.scratch, 'bind', 'rw', 'scratch'),
    mountOf('agent', writable.reportMd, writable.reportMd, 'bind', 'rw', 'report'),
    mountOf('agent', writable.reportJson, writable.reportJson, 'bind', 'rw', 'report'),
    mountOf('agent', '/work', null, 'tmpfs', 'rw', 'work', tmpfs['/work']),
    mountOf('agent', '/tmp', null, 'tmpfs', 'rw', 'work', tmpfs['/tmp']),
    mountOf('agent', '/agent', null, 'tmpfs', 'rw', 'work', tmpfs['/agent']),
    mountOf('agent', '/run/acoder-egress', names.volume, 'volume', 'ro', 'socket'),
    mountOf('agent', '/etc/hosts', `${staging.agentPayload}/etc/hosts`, 'bind', 'ro', 'etc'),
    mountOf('agent', '/etc/resolv.conf', `${staging.agentPayload}/etc/resolv.conf`, 'bind', 'ro', 'etc'),
  ];
  const egressMounts = [
    mountOf('egress', '/acoder', staging.egressPayload, 'bind', 'ro', 'payload'),
    mountOf('egress', '/run/acoder-egress', names.volume, 'volume', 'rw', 'socket'),
  ];
  const common = ['--label', label];
  const shared = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', `${uid}:${gid}`, ...(runtime === 'podman' ? ['--userns', 'keep-id'] : [])];
  const tail = ['--pull', 'never', '--log-driver', 'none', '--rm', '--no-healthcheck', '--interactive', '--entrypoint', 'node'];

  const agentEnv = [
    ['ACODER_CONTAINER', '1'], ['ACODER_RUN_ID', runId], ['ACODER_TAG', input.tag], ['ACODER_TICKET_SHA256', input.ticketSha256], ['ACODER_EVENT_PREFIX', input.eventPrefix],
    ['ACODER_PROBE_INPUT', JSON.stringify(input.probeInput)], ...Object.entries(input.agent.env),
  ];
  const agentCreate = [
    'create', '--name', names.agent, ...common, '--network', 'none', ...shared, '--pids-limit', '512', ...tail, '--workdir', writable.scratch,
    ...agentMounts.flatMap(mount => mount.args), ...agentEnv.flatMap(([name, value]) => ['--env', `${name}=${value}`]), image, '/acoder/container/entry.mjs',
  ];
  const egressEnv = ['--env', `ACODER_RUN_ID=${runId}`, '--env', UPSTREAM_KEY_ENV, ...(input.extraCa ? ['--env', 'NODE_EXTRA_CA_CERTS=/acoder/ca.pem'] : [])];
  const egressCreate = [
    'create', '--name', names.egress, ...common, '--network', names.network, ...shared, '--pids-limit', '128', ...tail,
    ...egressMounts.flatMap(mount => mount.args), ...egressEnv, image, '/acoder/container/proxy.mjs',
  ];
  const json = value => `${JSON.stringify(value, null, 2)}\n`;
  return {
    runtime, run_id: runId, label, names, allowlist: [host],
    network: { name: names.network, create: ['network', 'create', ...common, names.network], agent_network: 'none' },
    volume: {
      name: names.volume,
      create: ['volume', 'create', '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', `o=size=1m,uid=${uid},gid=${gid},mode=0750`, ...common, names.volume],
    },
    egress: { name: names.egress, create: egressCreate, key_env: UPSTREAM_KEY_ENV, env_names: [...new Set(['ACODER_RUN_ID', UPSTREAM_KEY_ENV, ...(input.extraCa ? ['NODE_EXTRA_CA_CERTS'] : []), ...input.imageEnvNames])].sort() },
    agent: { name: names.agent, create: agentCreate, env_names: agentEnvNames(input.agent.env, input.imageEnvNames) },
    mounts: [...agentMounts, ...egressMounts].map(mount => mount.record),
    payload_files: {
      agent: {
        'etc/hosts': hostsFile([host]), 'etc/resolv.conf': resolvConf(),
        'run.json': json({ run_id: runId, tag: input.tag, ticket_sha256: input.ticketSha256, limits: { ...input.limits }, launcher_version: input.launcherVersion, skill_sha256: input.skillSha256 }),
        'agent-command.json': json({ argv: [...input.agent.argv] }),
      },
      egress: {
        'egress.json': json({
          run_id: runId, provider: { id: input.provider.id, module: `/acoder/providers/${input.provider.id}.mjs` }, endpoint: { host, path }, allowlist: [host], key_env: UPSTREAM_KEY_ENV,
          limits: { calls: input.limits.calls, tokens: input.limits.tokens, max_in_flight: input.limits.max_in_flight }, extra_ca: input.extraCa,
        }),
      },
    },
  };
}

// A8.4 and A10.3 on the parsed answer of `image inspect`. A refusal names the item and never a value.
export function checkImageConfig(inspect, { image, allowImageEnv }) {
  if (!Array.isArray(allowImageEnv)) throw new TypeError('allowImageEnv is a list');
  const reference = typeof image === 'string' ? /^(?:.+@)?(sha256:[0-9a-f]{64})$/.exec(image) : null;
  if (reference === null) throw new Refusal('the image reference must be <name>@sha256:<64 hex> or sha256:<64 hex>; a tag or a bare name is refused');
  const entry = Array.isArray(inspect) ? (inspect.length === 1 ? inspect[0] : null) : inspect;
  if (!isObject(entry) || typeof entry.Id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(entry.Id) || !isObject(entry.Config)) throw new Refusal('the answer of image inspect does not describe one local image with an id and a configuration');
  const repoDigests = Array.isArray(entry.RepoDigests) ? entry.RepoDigests.filter(item => typeof item === 'string') : [];
  if (reference[1] !== entry.Id && !repoDigests.some(item => item.slice(item.lastIndexOf('@') + 1) === reference[1])) throw new Refusal('the image digest matches neither the image id nor a repository digest of the local image');
  const rawEnv = entry.Config.Env ?? [];
  if (!Array.isArray(rawEnv)) throw new Refusal('the image has a malformed environment list');
  const envNames = new Set();
  for (const item of rawEnv) {
    const name = typeof item === 'string' ? item.slice(0, item.includes('=') ? item.indexOf('=') : undefined) : '';
    if (name === '') throw new Refusal('the image has a malformed environment entry');
    envNames.add(name);
  }
  const allowed = new Set([...IMAGE_BUILT_IN_ENV, ...allowImageEnv]);
  const sorted = [...envNames].sort();
  for (const name of sorted) {
    if (!allowed.has(name)) throw new Refusal(`the image defines the environment variable ${safe(name)}, which is not on the list of A8.4 (give --allow-image-env ${safe(name)} to accept it)`);
  }
  const volumes = entry.Config.Volumes ?? null;
  if (volumes !== null && (!isObject(volumes) || Object.keys(volumes).length > 0)) throw new Refusal('the image declares a volume');
  return { ref: image, id: entry.Id, repo_digests: repoDigests, env_names: sorted, allowed_env_names: [...new Set(allowImageEnv)].sort() };
}
