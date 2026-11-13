import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { adapters } from '../adapters/index.mjs';
import * as opencode from '../adapters/opencode.mjs';
import { providers } from '../providers/index.mjs';
import * as openai from '../providers/openai.mjs';
import { assertAdapterShape, assertProfileShape } from './helpers/adapter-shape.mjs';
import { LAUNCHER, must, runMain, thrownOf, withFixture, parseJson } from './helpers/fixtures.mjs';
import * as stub from './helpers/stub-adapter.mjs';

// G11: every test has a finite time limit of its own. The test is registered from this file, so that the mutation runner can count it per module.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, fn);

const PLACEHOLDER = 'acoder-placeholder-not-a-key';
const INPUT = { model: 'gpt-6-luna', effort: 'high', provider: { id: 'openai', baseUrl: 'http://models.example.org:8080/v1', placeholderKey: PLACEHOLDER }, firstMessage: 'This is an acoder container launch. TICKET t at /m/S2/ticket-t.md', workdir: '/m/S2/scratch-t' };
const command = (over = {}) => must(() => opencode.command({ ...INPUT, ...over }));

t('dod1-adapter: the adapter exports exactly the interface of A5 and is the only registered adapter', () => {
  must(() => assertAdapterShape(opencode));
  assert.equal(opencode.name, 'opencode');
  assert.deepEqual(opencode.versionArgv, ['opencode', '--version']);
  assert.deepEqual(opencode.providers, ['openai']);
  assert.deepEqual(Object.keys(adapters), ['opencode']);
  assert.equal(adapters.opencode, opencode);
  assert.deepEqual(Object.keys(providers), ['openai']);
  assert.equal(providers.openai, openai);
});

t('dod1-adapter: command returns the argv, environment and inline configuration of A4 exactly, with the placeholder and no other key-like value', () => {
  const result = command();
  assert.deepEqual(result.argv, ['opencode', 'run', '--format', 'json', '--auto', '--pure', '--dir', '/m/S2/scratch-t', '-m', 'openai/gpt-6-luna', INPUT.firstMessage]);
  const { OPENCODE_CONFIG_CONTENT: content, ...rest } = result.env;
  assert.deepEqual(rest, {
    OPENCODE_PERMISSION: '{"*":"allow","external_directory":{"*":"allow"},"doom_loop":"allow","webfetch":"deny","websearch":"deny","question":"deny"}',
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_PURE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_CONFIG_DIR: '/agent/config', XDG_CONFIG_HOME: '/agent/xdg/config', XDG_DATA_HOME: '/agent/xdg/data', XDG_CACHE_HOME: '/agent/xdg/cache', XDG_STATE_HOME: '/agent/xdg/state',
    HOME: '/agent/user', TMPDIR: '/work/tmp',
  });
  assert.deepEqual(parseJson(result.env.OPENCODE_PERMISSION), { '*': 'allow', external_directory: { '*': 'allow' }, doom_loop: 'allow', webfetch: 'deny', websearch: 'deny', question: 'deny' });
  assert.deepEqual(parseJson(content), {
    autoupdate: false, share: 'disabled', snapshot: false, enabled_providers: ['openai'],
    provider: { openai: { npm: '@ai-sdk/openai', options: { baseURL: 'http://models.example.org:8080/v1', apiKey: PLACEHOLDER }, models: { 'gpt-6-luna': { name: 'gpt-6-luna', reasoning: true, options: { reasoningEffort: 'high' } } } } },
  });
  // Another model and effort and directory; the endpoint path is passed through.
  const other = command({ model: 'gpt-5.1-mini:preview', effort: 'low', workdir: '/x/y', provider: { ...INPUT.provider, baseUrl: 'http://api.example.org:8080/openai/v2' } });
  assert.deepEqual(other.argv.slice(6), ['/x/y', '-m', 'openai/gpt-5.1-mini:preview', INPUT.firstMessage]);
  const config = parseJson(other.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(Object.keys(config.provider.openai.models), ['gpt-5.1-mini:preview']);
  assert.equal(config.provider.openai.models['gpt-5.1-mini:preview'].options.reasoningEffort, 'low');
  assert.equal(config.provider.openai.options.baseURL, 'http://api.example.org:8080/openai/v2');
  // The only key-like value anywhere is the placeholder, and the host environment is never read.
  const longRuns = value => String(value).match(/[A-Za-z0-9_-]{24,}/g) ?? [];
  for (const output of [result, other]) {
    const values = [...output.argv, ...Object.values(output.env)];
    assert.deepEqual([...new Set(values.flatMap(longRuns))], [PLACEHOLDER].filter(placeholder => values.some(value => value.includes(placeholder))));
  }
  const secret = 'SyntheticKeyValue0123456789abcdefABCDEF';
  const saved = process.env.ACODER_MODEL_API_KEY;
  process.env.ACODER_MODEL_API_KEY = secret;
  try { assert.ok(!JSON.stringify(command()).includes(secret), 'the adapter holds no key'); } finally {
    if (saved === undefined) delete process.env.ACODER_MODEL_API_KEY; else process.env.ACODER_MODEL_API_KEY = saved;
  }
  assert.notEqual(command().env, command().env, 'every call returns its own environment');
  const input = structuredClone(INPUT);
  must(() => opencode.command(input));
  assert.deepEqual(input, INPUT, 'the input is not changed');
});

t('dod1-adapter: command refuses an input it cannot build a safe invocation from', () => {
  const refused = over => assert.notEqual(thrownOf(() => opencode.command({ ...INPUT, ...over })), null, JSON.stringify(over));
  refused({ provider: { ...INPUT.provider, id: 'other' } });
  refused({ provider: { ...INPUT.provider, id: 'Openai' } });
  refused({ provider: { ...INPUT.provider, placeholderKey: '' } });
  refused({ provider: { ...INPUT.provider, placeholderKey: undefined } });
  refused({ provider: { ...INPUT.provider, baseUrl: 'https://models.example.org:8080/v1' } });
  refused({ provider: { ...INPUT.provider, baseUrl: '' } });
  refused({ provider: undefined });
  for (const model of ['', 'a b', 'a"b', 'a\nb', 'a/b', "a'b", undefined, 7]) refused({ model });
  for (const effort of ['', 'High', 'hi gh', 'x1', undefined]) refused({ effort });
  for (const workdir of ['', 'relative/dir', undefined, '/a\nb']) refused({ workdir });
  for (const firstMessage of ['', undefined, 7]) refused({ firstMessage });
  assert.equal(thrownOf(() => opencode.command({ ...INPUT, firstMessage: 'message with "quotes", spaces and\nnewlines' })), null, 'any message text is one argument');
});

const feed = lines => {
  const parser = must(() => opencode.createParser());
  for (const line of lines) must(() => parser.push(line));
  return must(() => parser.result());
};
const outcomeOf = (lines, end = {}) => must(() => opencode.outcome({ code: 0, signal: null, ...end, parsed: feed(lines) }));
const STEP = JSON.stringify({ type: 'step_finish', part: { tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } }, cost: 0 } });
const ERROR = JSON.stringify({ type: 'error', error: { message: 'boom' } });

t('dod1-adapter: the parser and the outcome for no events, steps only, an error before and after a step, non-JSON lines, exit code 1 and a signal', () => {
  assert.deepEqual(feed([]), { sawError: false, sawStep: false, advisory: { calls: 0, tokens: null } });
  assert.equal(outcomeOf([]), 'error', 'no events: no step finished');
  assert.deepEqual(feed([STEP]), { sawError: false, sawStep: true, advisory: { calls: 1, tokens: { input: 10, output: 5, reasoning: 2, cache_read: 3, cache_write: 1 } } });
  assert.equal(outcomeOf([STEP]), 'success');
  assert.equal(outcomeOf([JSON.stringify({ type: 'step_start' }), JSON.stringify({ type: 'text' }), JSON.stringify({ type: 'reasoning' }), STEP]), 'success', 'other events change nothing');
  assert.equal(outcomeOf([JSON.stringify({ type: 'step_start' }), JSON.stringify({ type: 'text' })]), 'error', 'steps started but none finished');
  const before = feed([ERROR, STEP]);
  assert.equal(before.sawError, true);
  assert.equal(before.sawStep, true);
  assert.equal(must(() => opencode.outcome({ code: 0, signal: null, parsed: before })), 'error', 'an error event before a step');
  assert.equal(outcomeOf([STEP, ERROR]), 'error', 'an error event after a step');
  assert.equal(outcomeOf([ERROR]), 'error');
  // Lines that are not JSON, or not an object with a type, change nothing.
  const noise = ['', '   ', 'not json', '{', '{"type":', '[1,2]', '7', '"step_finish"', 'null', 'true', '{}', '{"type":7}', '{"type":["error"]}', '{"kind":"error"}', 'step_finish', 'error'];
  assert.deepEqual(feed(noise), { sawError: false, sawStep: false, advisory: { calls: 0, tokens: null } });
  assert.equal(outcomeOf([...noise, STEP, ...noise]), 'success');
  assert.equal(outcomeOf([`  ${STEP}  `]), 'success', 'a line with surrounding blanks');
  // Exit code and signal: only code 0 without a signal can succeed.
  assert.equal(outcomeOf([STEP], { code: 1 }), 'error');
  assert.equal(outcomeOf([STEP], { code: 2 }), 'error');
  assert.equal(outcomeOf([STEP], { code: null, signal: 'SIGTERM' }), 'error');
  assert.equal(outcomeOf([STEP], { code: 0, signal: 'SIGKILL' }), 'error');
  assert.equal(outcomeOf([STEP], { code: null }), 'error');
  assert.equal(must(() => opencode.outcome({ code: 0, parsed: feed([STEP]) })), 'success', 'a missing signal is no signal');
  // The advisory counts: one call per finished step, tokens summed, bad numbers ignored.
  const two = feed([STEP, STEP, JSON.stringify({ type: 'step_finish', part: { tokens: { input: -1, output: 'x', reasoning: 1.5 } } }), JSON.stringify({ type: 'step_finish' })]);
  assert.equal(two.advisory.calls, 4);
  assert.deepEqual(two.advisory.tokens, { input: 20, output: 10, reasoning: 4, cache_read: 6, cache_write: 2 });
  assert.deepEqual(feed([JSON.stringify({ type: 'step_finish', tokens: { input: 1, output: 2 } })]).advisory.tokens, { input: 1, output: 2, reasoning: 0, cache_read: 0, cache_write: 0 }, 'tokens may sit on the event itself');
  const parser = must(() => opencode.createParser());
  parser.push(STEP);
  const snapshot = parser.result();
  parser.push(STEP);
  assert.equal(snapshot.advisory.calls, 1, 'a result is a copy');
  assert.equal(parser.result().advisory.calls, 2);
});

t('dod14-stub: the stub adapter is a full adapter of the same interface, is not in the production registry, and is refused by the production command', () => withFixture({}, async fx => {
  assertAdapterShape(stub);
  assert.equal(stub.name, 'stub');
  assert.ok(!('stub' in adapters), 'the production registry has no stub');
  const result = stub.command(INPUT);
  assert.equal(result.argv.at(-1), INPUT.firstMessage);
  const parser = stub.createParser();
  parser.push('{"stub":"step"}');
  parser.push('garbage');
  assert.equal(stub.outcome({ code: 0, signal: null, parsed: parser.result() }), 'success');
  parser.push('{"stub":"error"}');
  assert.equal(stub.outcome({ code: 0, signal: null, parsed: parser.result() }), 'error');
  assert.equal(stub.outcome({ code: 0, signal: null, parsed: stub.createParser().result() }), 'error');
  // The production registries refuse --agent stub; the tests' registry holds it.
  const production = await runMain(fx.argv({ add: [['--agent', 'stub']] }), { env: fx.env, deps: { adapters, providers } });
  assert.equal(production.code, 2);
  assert.match(production.stderr, /unknown agent stub/);
  const test = await fx.run({ add: [['--agent', 'stub']] });
  assert.equal(test.code, 0, test.stderr);
  assert.equal(parseJson(test.stdout).agent, 'stub');
}));

// The rules of A5, as a function of {path: text}, so that the test can also show that each rule refuses a broken tree.
const ALLOWED_AGENT = new Set(['adapters/opencode.mjs', 'adapters/index.mjs', 'defaults.json']);
const ALLOWED_PROVIDER = new Set(['providers/openai.mjs', 'providers/index.mjs', 'adapters/opencode.mjs', 'defaults.json']);
const CREDENTIAL_LINE = /\.config\/opencode|\.local\/share\/opencode/;
function violations(files) {
  const found = [];
  for (const [file, text] of Object.entries(files)) {
    if (file.startsWith('test/')) continue;
    if (file.startsWith('lib/') || file.startsWith('container/')) {
      for (const [, specifier] of [...text.matchAll(/from\s+'([^']+)'/g), ...text.matchAll(/import\(\s*'([^']+)'\s*\)/g)]) {
        if (/(^|\/)(adapters|providers)\//.test(specifier)) found.push(`${file} imports ${specifier}`);
      }
    }
    for (const [rule, needles, allowed] of [['agent-name', ['opencode', 'OPENCODE_'], ALLOWED_AGENT], ['provider-name', ['openai'], ALLOWED_PROVIDER]]) {
      if (allowed.has(file)) continue;
      for (const line of text.split('\n')) {
        // A2.6 lists two credential names (`.config/opencode`, `.local/share/opencode`) that paths.mjs must hold as data.
        if (file === 'lib/paths.mjs' && rule === 'agent-name' && CREDENTIAL_LINE.test(line) && !/OPENCODE_/.test(line)) continue;
        if (needles.some(needle => line.includes(needle))) { found.push(`${file} breaks the ${rule} rule: ${line.trim().slice(0, 60)}`); break; }
      }
    }
  }
  return found;
}
function readTree(root) {
  const files = {};
  const walk = (directory, relative) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const shown = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), shown);
      else if (entry.isFile()) files[shown] = fs.readFileSync(path.join(directory, entry.name), 'utf8');
    }
  };
  walk(root, '');
  return files;
}

t('dod14-seam: no lib or container file imports an adapter or a provider; the agent and provider names occur only where A5 allows', () => {
  const tree = readTree(LAUNCHER);
  assert.ok(Object.keys(tree).length > 30 && 'lib/cli.mjs' in tree && 'adapters/opencode.mjs' in tree && 'providers/openai.mjs' in tree, 'the whole launcher folder is read');
  assert.deepEqual(violations(tree), []);
  // The bin file imports exactly the two indexes and passes both registries to main.
  const bin = tree['bin/acoder.mjs'];
  assert.deepEqual([...bin.matchAll(/from '([^']+)'/g)].map(match => match[1]).filter(specifier => /adapters|providers/.test(specifier)).sort(), ['../adapters/index.mjs', '../providers/index.mjs']);
  assert.ok(bin.includes('{ adapters, providers, launchEnabled: LAUNCH_ENABLED }'));
  // The reference image definition names neither (A10).
  assert.ok(!/opencode|openai/i.test(tree['image/Containerfile'] ?? ''), 'the Containerfile names no agent and no provider');
  // The credential names of A2.6 are the one accepted use of the agent name outside the adapter, and only as data in paths.mjs.
  assert.deepEqual(Object.entries(tree).filter(([file, text]) => !file.startsWith('test/') && /opencode/.test(text)).map(([file]) => file).sort(), ['adapters/index.mjs', 'adapters/opencode.mjs', 'defaults.json', 'lib/paths.mjs']);
});

t('dod14-seam: each rule refuses a tree that breaks it (the rules are real checks)', () => {
  const base = { 'lib/cli.mjs': "import x from 'node:fs';\n", 'adapters/opencode.mjs': 'opencode openai\n', 'providers/openai.mjs': 'openai\n', 'test/a.test.mjs': 'opencode openai\n', 'defaults.json': 'opencode openai\n' };
  assert.deepEqual(violations(base), []);
  const broken = [
    { ...base, 'lib/run.mjs': "import { adapters } from '../adapters/index.mjs';\n" },
    { ...base, 'lib/run.mjs': "const a = await import('../providers/openai.mjs');\n" },
    { ...base, 'container/entry.mjs': "import p from '../providers/x.mjs';\n" },
    { ...base, 'lib/plan.mjs': '// the opencode agent\n' },
    { ...base, 'lib/plan.mjs': "const e = 'OPENCODE_PURE';\n" },
    { ...base, 'lib/plan.mjs': '// openai\n' },
    { ...base, 'providers/openai.mjs': "import x from '../adapters/opencode.mjs';\n", 'lib/state.mjs': "import y from '../providers/openai.mjs';\n" },
    { ...base, 'image/Containerfile': 'RUN npm install opencode\n' },
    { ...base, 'adapters/index.mjs': 'openai\n', 'providers/index.mjs': 'opencode\n' },
  ];
  for (const [index, tree] of broken.entries()) assert.ok(violations(tree).length > 0, `broken tree ${index}`);
  // paths.mjs may hold the two credential names and nothing else of the agent name.
  assert.deepEqual(violations({ ...base, 'lib/paths.mjs': "const X = ['.config/opencode', '.local/share/opencode'];\n" }), []);
  assert.ok(violations({ ...base, 'lib/paths.mjs': "const X = ['.config/opencode'];\nconst y = 'opencode';\n" }).length > 0);
  assert.ok(violations({ ...base, 'lib/paths.mjs': "const X = ['.config/opencode', 'OPENCODE_PURE'];\n" }).length > 0);
  assert.ok(violations({ ...base, 'lib/other.mjs': "const X = ['.config/opencode'];\n" }).length > 0, 'only paths.mjs has the exception');
});

// The openai profile.
const sse = events => events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
const extract = (contentType, chunks) => {
  const extractor = must(() => openai.createUsageExtractor(contentType));
  for (const chunk of chunks) extractor.push(chunk);
  return extractor.result();
};
const U = { input: 12, output: 7, reasoning: 3, cached_input: 5 };

t('dod14-stub: the openai profile exports exactly the interface of A5, the two request kinds and the bearer header', () => {
  must(() => assertProfileShape(openai));
  assert.equal(openai.id, 'openai');
  assert.deepEqual(openai.requests, [{ method: 'POST', suffix: '/responses' }, { method: 'POST', suffix: '/chat/completions' }]);
  assert.deepEqual(must(() => openai.authHeaders('abcdefghijklmnop')), { authorization: 'Bearer abcdefghijklmnop' });
  for (const bad of ['', undefined, 7, null]) assert.notEqual(thrownOf(() => openai.authHeaders(bad)), null, String(bad));
  assert.notEqual(openai.requests, openai.requests.slice(), 'a copy is a different list');
});

t('dod14-stub: the profile reads usage and model from a JSON answer (Responses and chat styles) and ignores other content types', () => {
  const responses = { id: 'r', model: 'gpt-6-luna-2026', usage: { input_tokens: 12, output_tokens: 7, input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 3 } } };
  assert.deepEqual(extract('application/json', [JSON.stringify(responses)]), { usage: U, model: 'gpt-6-luna-2026' });
  const chat = { model: 'gpt-x', usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 3 } } };
  assert.deepEqual(extract('application/json; charset=utf-8', [JSON.stringify(chat)]), { usage: U, model: 'gpt-x' });
  assert.deepEqual(extract('application/json', [JSON.stringify({ model: 'm', usage: { input_tokens: 1, output_tokens: 2 } })]).usage, { input: 1, output: 2, reasoning: 0, cached_input: 0 }, 'details default to 0');
  assert.deepEqual(extract('application/json', [JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0 } })]), { usage: { input: 0, output: 0, reasoning: 0, cached_input: 0 }, model: null });
  assert.deepEqual(extract('application/json', ['{"model":"a",', '"usage":{"input_tokens":1,', '"output_tokens":2}}']), { usage: { input: 1, output: 2, reasoning: 0, cached_input: 0 }, model: 'a' }, 'a body in several chunks');
  assert.deepEqual(extract('application/json', [Buffer.from(JSON.stringify(chat)), new Uint8Array(0)]), { usage: U, model: 'gpt-x' }, 'Buffer chunks');
  // No usage, malformed usage and a malformed or non-object body: usage is null; the model is read independently.
  assert.deepEqual(extract('application/json', [JSON.stringify({ model: 'm' })]), { usage: null, model: 'm' });
  assert.deepEqual(extract('application/json', [JSON.stringify({ model: 'm', usage: null })]), { usage: null, model: 'm' });
  for (const usage of [{ input_tokens: 'x', output_tokens: 2 }, { input_tokens: 1 }, { output_tokens: 2 }, { input_tokens: -1, output_tokens: 2 }, { input_tokens: 1.5, output_tokens: 2 }, { input_tokens: 1, output_tokens: 2, output_tokens_details: { reasoning_tokens: 'x' } },
    { input_tokens: 1, output_tokens: 2, input_tokens_details: { cached_tokens: -1 } }, [], 'usage', 7, {}]) {
    assert.deepEqual(extract('application/json', [JSON.stringify({ model: 'm', usage })]), { usage: null, model: 'm' }, JSON.stringify(usage));
  }
  for (const body of ['not json', '[1]', 'null', '7', '"x"', '']) assert.deepEqual(extract('application/json', [body]), { usage: null, model: null }, body);
  for (const model of [7, null, {}, ['x']]) assert.equal(extract('application/json', [JSON.stringify({ model, usage: { input_tokens: 1, output_tokens: 2 } })]).model, null, JSON.stringify(model));
  for (const type of ['text/plain', 'text/html', '', undefined, 'application/octet-stream']) assert.deepEqual(extract(type, [JSON.stringify(responses)]), { usage: null, model: null }, String(type));
  // A body over 8 MiB is not kept: no usage and no model.
  const big = `{"model":"m","usage":{"input_tokens":1,"output_tokens":2},"pad":"${'x'.repeat(8 * 1024 * 1024)}"}`;
  assert.deepEqual(extract('application/json', [big]), { usage: null, model: null });
  const nearly = `{"model":"m","usage":{"input_tokens":1,"output_tokens":2},"pad":"${'x'.repeat(8 * 1024 * 1024 - 100)}"}`;
  assert.equal(extract('application/json', [nearly]).usage?.input, 1, 'a body up to 8 MiB is read');
});

t('dod14-stub: the profile reads usage from an event stream: response.completed, a chat stream with a final usage chunk, no usage, malformed events, and events split across chunks', () => {
  const completed = sse([
    { type: 'response.created', response: { model: 'gpt-6-luna', usage: null } }, { type: 'response.output_text.delta', delta: 'hi' },
    { type: 'response.completed', response: { model: 'gpt-6-luna-final', usage: { input_tokens: 12, output_tokens: 7, input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 3 } } } }, '[DONE]',
  ]);
  assert.deepEqual(extract('text/event-stream', [completed]), { usage: U, model: 'gpt-6-luna-final' });
  const chat = sse([
    { model: 'm1', choices: [{ delta: { content: 'a' } }], usage: null }, { model: 'm2', choices: [{ delta: { content: 'b' } }] },
    { model: 'm3', choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 3 } } }, '[DONE]',
  ]);
  assert.deepEqual(extract('text/event-stream', [chat]), { usage: U, model: 'm3' }, 'the last chunk with a non-null usage, and the last model string');
  assert.deepEqual(extract('text/event-stream; charset=utf-8', [chat]).usage, U);
  assert.deepEqual(extract('text/event-stream', [sse([{ model: 'm', choices: [] }, '[DONE]'])]), { usage: null, model: 'm' }, 'no usage');
  assert.deepEqual(extract('text/event-stream', ['']), { usage: null, model: null });
  assert.deepEqual(extract('text/event-stream', [sse([{ model: 'm', usage: { prompt_tokens: 'x', completion_tokens: 1 } }])]), { usage: null, model: 'm' }, 'malformed usage');
  assert.deepEqual(extract('text/event-stream', [sse([{ model: 'a', usage: { prompt_tokens: 1, completion_tokens: 1 } }, { model: 'b', usage: { prompt_tokens: 'x', completion_tokens: 1 } }])]), { usage: null, model: 'b' }, 'a later malformed usage replaces an earlier one');
  assert.deepEqual(extract('text/event-stream', [sse([{ model: 'a', usage: { prompt_tokens: 1, completion_tokens: 1 } }, { model: 'b', usage: { prompt_tokens: 2, completion_tokens: 2 } }])]).usage, { input: 2, output: 2, reasoning: 0, cached_input: 0 }, 'the last usage wins');
  // A malformed event means the request ends with usage null (A3.3); the model read so far is kept.
  const withBad = sse([{ model: 'a', usage: { prompt_tokens: 1, completion_tokens: 1 } }, '{not json', { model: 'z' }]);
  assert.deepEqual(extract('text/event-stream', [withBad]), { usage: null, model: 'z' });
  // Lines that are not data lines (comments, event names, ids, blank lines, other fields) are ignored, also with CRLF line ends.
  const noisy = `: keep-alive\nevent: message\nid: 3\nretry: 5\n\n${sse([{ model: 'm', usage: { prompt_tokens: 1, completion_tokens: 2 } }])}`.replaceAll('\n', '\r\n');
  assert.deepEqual(extract('text/event-stream', [noisy]), { usage: { input: 1, output: 2, reasoning: 0, cached_input: 0 }, model: 'm' });
  assert.deepEqual(extract('text/event-stream', ['data:{"model":"nospace","usage":{"prompt_tokens":1,"completion_tokens":1}}\n']).model, 'nospace', 'no space after the colon');
  assert.deepEqual(extract('text/event-stream', ['data: {"model":"last","usage":{"prompt_tokens":1,"completion_tokens":1}}']).model, 'last', 'a last line without a line end is read at the end');
  // Events split across chunks at every position, and at every byte of a multi-byte model name.
  const split = sse([{ model: 'mé', choices: [] }, { type: 'response.completed', response: { model: 'mé', usage: { input_tokens: 12, output_tokens: 7, input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 3 } } } }]);
  const bytes = Buffer.from(split);
  for (let cut = 0; cut <= bytes.length; cut += 1) {
    assert.deepEqual(extract('text/event-stream', [bytes.subarray(0, cut), bytes.subarray(cut)]), { usage: U, model: 'mé' }, `cut at ${cut}`);
  }
  assert.deepEqual(extract('text/event-stream', [...bytes].map(byte => Buffer.from([byte]))), { usage: U, model: 'mé' }, 'one byte at a time');
  // An event over 1 MiB ends the request with usage null; the extractor stays usable afterwards.
  const oversized = `data: {"model":"big","pad":"${'x'.repeat(1024 * 1024)}"}\n\n${sse([{ model: 'after', usage: { prompt_tokens: 1, completion_tokens: 1 } }])}`;
  assert.deepEqual(extract('text/event-stream', [oversized]), { usage: null, model: 'after' });
  assert.deepEqual(extract('text/event-stream', [`data: {"model":"big","pad":"${'x'.repeat(1024 * 1024)}`, `${'y'.repeat(1000)}"}\n\n`, sse([{ model: 'after' }])]), { usage: null, model: 'after' }, 'an oversized event across chunks');
  const limit = `data: {"model":"fits","usage":{"prompt_tokens":1,"completion_tokens":1},"pad":"${'x'.repeat(1024 * 1024 - 200)}"}\n\n`;
  assert.equal(extract('text/event-stream', [limit]).usage?.input, 1, 'an event just under 1 MiB is read');
  // The result can be read twice with the same answer.
  const extractor = must(() => openai.createUsageExtractor('text/event-stream'));
  extractor.push(completed);
  assert.deepEqual(extractor.result(), extractor.result());
});
