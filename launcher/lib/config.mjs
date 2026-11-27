// Defaults, the owner configuration file and the precedence of A1.5: flag, owner file, launcher/defaults.json.
// The endpoint comes from the flag or the owner file only; it is in no tracked file.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkEndpoint, isModelId, positiveInteger } from './args.mjs';
import { Refusal, safe } from './refusal.mjs';

export const DEFAULTS_PATH = fileURLToPath(new URL('../defaults.json', import.meta.url));
const KEY_CHARACTERS = /^[A-Za-z0-9_-]+$/;
const MAX_CONFIG_BYTES = 65536;
const VALUE_CHECKS = {
  agent: value => typeof value === 'string' && /^[a-z0-9-]+$/.test(value),
  provider: value => typeof value === 'string' && /^[a-z0-9-]+$/.test(value),
  model: isModelId,
  effort: value => typeof value === 'string' && /^[a-z]+$/.test(value),
  max_in_flight: value => Number.isInteger(value) && value >= 1 && value <= 16,
};

function readObject(file, label) {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile()) throw new Refusal(`${label} is not a regular file`);
  if (info.size > MAX_CONFIG_BYTES) throw new Refusal(`${label} is larger than ${MAX_CONFIG_BYTES} bytes`);
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Refusal(`${label} is not valid JSON`); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Refusal(`${label} must hold a JSON object`);
  return value;
}

function checkValues(object, label, allowEndpoint) {
  for (const [key, value] of Object.entries(object)) {
    if (key === 'endpoint' && allowEndpoint) { checkEndpoint(value, `${label}: endpoint`); continue; }
    if (!Object.hasOwn(VALUE_CHECKS, key)) throw new Refusal(`unknown key ${safe(key)} in ${label}`);
    if (!VALUE_CHECKS[key](value)) throw new Refusal(`${label}: ${key} has a value that is not allowed`);
  }
  return object;
}

export function loadDefaults(file = DEFAULTS_PATH) {
  const defaults = checkValues(readObject(file, 'launcher/defaults.json'), 'launcher/defaults.json', false);
  for (const key of Object.keys(VALUE_CHECKS)) if (!(key in defaults)) throw new Refusal(`launcher/defaults.json lacks ${key}`);
  return defaults;
}

export function loadOwnerConfig(file) {
  if (file === null) return {};
  return checkValues(readObject(file, 'the owner configuration file'), 'the owner configuration file', true);
}

const registered = (registry, name) => Object.hasOwn(registry, name);

export function resolveSettings({ options, owner, defaults, adapters, providers }) {
  checkValues(owner, 'the owner configuration file', true);
  const pick = (flag, key) => flag ?? owner[key] ?? defaults[key];
  const agent = pick(options.agent, 'agent');
  const provider = pick(options.provider, 'provider');
  if (!registered(adapters, agent)) throw new Refusal(`unknown agent ${safe(agent)}`);
  if (!registered(providers, provider)) throw new Refusal(`unknown provider ${safe(provider)}`);
  if (!adapters[agent].providers.includes(provider)) throw new Refusal(`agent ${agent} does not list provider ${provider}`);
  // D-2 (rule R-A): the model id is opaque; nothing is stripped and no segment is compared with the provider.
  const model = pick(options.model, 'model');
  const endpoint = options.modelEndpoint ?? owner.endpoint;
  if (endpoint === undefined) throw new Refusal('no model endpoint: give --model-endpoint or set "endpoint" in the owner configuration file');
  const maxInFlight = options.maxInFlight ?? owner.max_in_flight ?? defaults.max_in_flight;
  const limits = { wall_seconds: options.budgetMinutes * 60, calls: options.budgetCalls, tokens: options.budgetTokens, max_in_flight: maxInFlight, scratch_max_bytes: options.scratchMaxBytes };
  positiveInteger(String(limits.wall_seconds), '--budget-minutes');
  return { agent, provider, model, effort: pick(options.effort, 'effort'), maxInFlight, endpoint, limits };
}

// A8.2: the key is read only from the named host variable; the message never holds the value.
export function checkApiKey(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.length < 16 || !KEY_CHARACTERS.test(value)) {
    throw new Refusal(`the key in ${name} is unset, empty, shorter than 16 characters or has a character outside [A-Za-z0-9_-]`);
  }
}
