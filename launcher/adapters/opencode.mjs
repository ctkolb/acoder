// The opencode agent adapter (A4, A5): all opencode-specific code. It holds no key: the configuration carries the fixed placeholder.
export const name = 'opencode';
export const versionArgv = ['opencode', '--version'];
export const providers = ['openai'];

const PERMISSION = '{"*":"allow","external_directory":{"*":"allow"},"doom_loop":"allow","webfetch":"deny","websearch":"deny","question":"deny"}';
// Every other name of the environment of A4 is a fixed value.
const FIXED_ENV = {
  OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_PURE: '1',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_CONFIG_DIR: '/agent/config', XDG_CONFIG_HOME: '/agent/xdg/config', XDG_DATA_HOME: '/agent/xdg/data', XDG_CACHE_HOME: '/agent/xdg/cache', XDG_STATE_HOME: '/agent/xdg/state',
  HOME: '/agent/user', TMPDIR: '/work/tmp',
};
// D-2 (rule R-A): the same model id rule as launcher/lib/args.mjs, checked here on its own; the id is passed whole as <provider>/<id>.
const MODEL = /^[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/;
const isModelId = value => typeof value === 'string' && value.length <= 128 && MODEL.test(value) && !value.includes('..') && !value.split('/').includes('.');
const EFFORT = /^[a-z]+$/;
const nonEmpty = value => typeof value === 'string' && value !== '';

// input = {model, effort, provider: {id, baseUrl, placeholderKey}, firstMessage, workdir}; returns {argv, env} (A4: invocation, environment, inline configuration).
export function command({ model, effort, provider, firstMessage, workdir }) {
  if (!isModelId(model)) throw new Error('the model id is not allowed');
  if (typeof effort !== 'string' || !EFFORT.test(effort)) throw new Error('the effort is not allowed');
  if (provider === null || typeof provider !== 'object' || !providers.includes(provider.id)) throw new Error('this adapter does not drive that provider');
  if (!nonEmpty(provider.placeholderKey)) throw new Error('the placeholder key is missing');
  if (!nonEmpty(provider.baseUrl) || !provider.baseUrl.startsWith('http://')) throw new Error('the base URL is the plain HTTP address of the relay');
  if (!nonEmpty(firstMessage)) throw new Error('the first message is missing');
  if (typeof workdir !== 'string' || !/^\/[^\n\0]*$/.test(workdir)) throw new Error('the working directory must be an absolute path');
  const config = {
    autoupdate: false, share: 'disabled', snapshot: false, enabled_providers: [provider.id], small_model: `${provider.id}/${model}`,
    provider: {
      [provider.id]: {
        npm: '@ai-sdk/openai', options: { baseURL: provider.baseUrl, apiKey: provider.placeholderKey },
        models: { [model]: { name: model, reasoning: true, options: { reasoningEffort: effort } } },
      },
    },
  };
  return {
    argv: ['opencode', 'run', '--format', 'json', '--auto', '--pure', '--dir', workdir, '-m', `${provider.id}/${model}`, firstMessage],
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_PERMISSION: PERMISSION, ...FIXED_ENV },
  };
}

const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The parser reads the agent's output lines. The counts are ADVISORY and never enforce anything (A5). The printed envelope of an event
// (`type`, and the tokens of a finished step under `part.tokens` or `tokens`) is UNVERIFIED (F15).
export function createParser() {
  const seen = { sawError: false, sawStep: false, calls: 0, tokens: null };
  const add = tokens => {
    const parts = { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cache_read: tokens.cache?.read, cache_write: tokens.cache?.write };
    if (!Object.values(parts).some(isCount)) return;
    seen.tokens ??= { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
    for (const [field, value] of Object.entries(parts)) if (isCount(value)) seen.tokens[field] += value;
  };
  return {
    push(line) {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (!isObject(event) || typeof event.type !== 'string') return;
      if (event.type === 'error') seen.sawError = true;
      if (event.type === 'step_finish') {
        seen.sawStep = true;
        seen.calls += 1;
        const tokens = event.part?.tokens ?? event.tokens;
        if (isObject(tokens)) add(tokens);
      }
    },
    result: () => ({ sawError: seen.sawError, sawStep: seen.sawStep, advisory: { calls: seen.calls, tokens: seen.tokens === null ? null : { ...seen.tokens } } }),
  };
}

// A5: success only when the exit code is 0, there is no signal, no error event was printed and a step finished.
export function outcome({ code, signal, parsed }) {
  return code === 0 && (signal === null || signal === undefined) && !parsed.sawError && parsed.sawStep ? 'success' : 'error';
}
