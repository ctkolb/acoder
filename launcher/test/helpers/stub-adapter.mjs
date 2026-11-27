// The stub agent adapter of the tests (A5): a full adapter that is not in the production registry, so `--agent stub` is refused by the
// production command. Its agent program (test/helpers/stub-agent.mjs) reaches the container in the fixture's reviewer skill folder, copied
// to /acoder/skill by the snapshot; it prints one JSON line per event: {"stub":"step"} and {"stub":"error"}.
export const name = 'stub';
export const versionArgv = ['stub-agent', '--version'];
export const providers = ['openai'];

export function command({ model, effort, provider, firstMessage, workdir }) {
  return {
    argv: ['node', '/acoder/skill/stub-agent.mjs', '--dir', workdir, '--model', model, '--effort', effort, firstMessage],
    env: { STUB_BASE_URL: provider.baseUrl, STUB_API_KEY: provider.placeholderKey, HOME: '/agent/user', TMPDIR: '/work/tmp' },
  };
}

export function createParser() {
  const seen = { sawError: false, sawStep: false, calls: 0 };
  return {
    push(line) {
      let value;
      try { value = JSON.parse(line); } catch { return; }
      if (value?.stub === 'error') seen.sawError = true;
      if (value?.stub === 'step') { seen.sawStep = true; seen.calls += 1; }
    },
    result: () => ({ sawError: seen.sawError, sawStep: seen.sawStep, advisory: { calls: seen.calls, tokens: null } }),
  };
}

export const outcome = ({ code, signal, parsed }) => (code === 0 && (signal === null || signal === undefined) && !parsed.sawError && parsed.sawStep ? 'success' : 'error');
