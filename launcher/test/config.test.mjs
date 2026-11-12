import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadDefaults, loadOwnerConfig, resolveSettings, checkApiKey } from '../lib/config.mjs';
import { parseReviewRun } from '../lib/args.mjs';
import { attempt, expectRefusal, LAUNCHER, t, withFixture } from './helpers/fixtures.mjs';

const registry = { adapters: { opencode: { providers: ['openai', 'other'] }, narrow: { providers: ['other'] } }, providers: { openai: {}, other: {} } };
const DEFAULTS = { agent: 'opencode', provider: 'openai', model: 'gpt-6-luna', effort: 'high', max_in_flight: 4 };
const optionsFor = (fx, extra = []) => parseReviewRun(fx.argv({ add: extra }).slice(2));

// S2-AC2 (dod1-config): flag, then owner configuration file, then launcher/defaults.json; the endpoint from the flag, then the file.
t('dod1-config: defaults.json has exactly the content of A4 item 2', () => {
  const text = attempt(() => fs.readFileSync(path.join(LAUNCHER, 'defaults.json'), 'utf8'));
  assert.deepEqual(attempt(() => JSON.parse(text)), DEFAULTS);
  assert.deepEqual(attempt(() => loadDefaults()), DEFAULTS);
  assert.ok(!String(text).includes('http'), 'no endpoint is tracked');
});

t('dod1-config: with no flag and no file the defaults apply and the endpoint comes from the flag', () => withFixture({}, async fx => {
  const settings = attempt(() => resolveSettings({ options: optionsFor(fx), owner: {}, defaults: DEFAULTS, ...registry }));
  assert.deepEqual({ ...settings, limits: undefined }, { agent: 'opencode', provider: 'openai', model: 'gpt-6-luna', effort: 'high', maxInFlight: 4, endpoint: 'https://models.example.org/v1', limits: undefined });
}));

t('dod1-config: the owner file overrides the defaults and the flags override the file', () => withFixture({}, async fx => {
  const owner = { agent: 'narrow', provider: 'other', model: 'file-model', effort: 'medium', endpoint: 'https://file.example.org/v1', max_in_flight: 6 };
  const fromFile = attempt(() => resolveSettings({ options: parseReviewRun(fx.argv({ drop: ['--model-endpoint'] }).slice(2)), owner, defaults: DEFAULTS, ...registry }));
  assert.deepEqual({ ...fromFile, limits: undefined }, { agent: 'narrow', provider: 'other', model: 'file-model', effort: 'medium', maxInFlight: 6, endpoint: 'https://file.example.org/v1', limits: undefined });
  const flags = ['--agent', 'opencode', '--provider', 'openai', '--model', 'flag-model', '--effort', 'low', '--max-in-flight', '2'];
  const fromFlags = attempt(() => resolveSettings({ options: optionsFor(fx, [flags.slice(0, 2), flags.slice(2, 4), flags.slice(4, 6), flags.slice(6, 8), flags.slice(8)]), owner, defaults: DEFAULTS, ...registry }));
  assert.deepEqual({ ...fromFlags, limits: undefined }, { agent: 'opencode', provider: 'openai', model: 'flag-model', effort: 'low', maxInFlight: 2, endpoint: 'https://models.example.org/v1', limits: undefined });
}));

t('dod1-config: limits are wall_seconds, calls, tokens, max_in_flight and scratch_max_bytes', () => withFixture({}, async fx => {
  const settings = attempt(() => resolveSettings({ options: optionsFor(fx, [['--scratch-max-bytes', '99']]), owner: {}, defaults: DEFAULTS, ...registry }));
  assert.deepEqual(settings.limits, { wall_seconds: 300, calls: 10, tokens: 1000, max_in_flight: 4, scratch_max_bytes: 99 });
}));

t('dod1-config: refusals of the resolution (unknown agent or provider, adapter without the provider, unknown key, missing endpoint)', () => withFixture({}, async fx => {
  const resolve = (extra, owner = {}, dropEndpoint = false) => attempt(() => resolveSettings({ options: parseReviewRun(fx.argv({ add: extra, drop: dropEndpoint ? ['--model-endpoint'] : [] }).slice(2)), owner, defaults: DEFAULTS, ...registry }));
  assert.match(resolve([['--agent', 'nope']]).thrown, /agent/);
  assert.match(resolve([['--provider', 'nope']]).thrown, /provider/);
  assert.match(resolve([['--agent', 'narrow']]).thrown, /narrow.*openai|openai.*narrow/);
  assert.match(resolve([], {}, true).thrown, /endpoint/);
  assert.match(resolve([], { provider: 'nope' }).thrown, /provider/);
  assert.match(resolve([], { agent: 'nope' }).thrown, /agent/);
  assert.match(attempt(() => resolveSettings({ options: optionsFor(fx), owner: { bogus: 1 }, defaults: DEFAULTS, ...registry })).thrown, /bogus/);
}));

t('dod1-config: the owner file loader refuses an unknown key, a wrong type, bad JSON and a non-object', () => withFixture({}, async fx => {
  const file = path.join(fx.base, 'owner.json');
  const load = text => { fs.writeFileSync(file, text); return attempt(() => loadOwnerConfig(file)); };
  assert.deepEqual(load('{"effort":"low","max_in_flight":3,"endpoint":"https://x.example.org/v1"}'), { effort: 'low', max_in_flight: 3, endpoint: 'https://x.example.org/v1' });
  assert.match(load('{"bogus":1}').thrown, /bogus/);
  assert.match(load('{"max_in_flight":"3"}').thrown, /max_in_flight/);
  assert.match(load('{"max_in_flight":99}').thrown, /max_in_flight/);
  assert.match(load('{"endpoint":"http://x.example.org"}').thrown, /endpoint/);
  assert.match(load('{"effort":"HIGH"}').thrown, /effort/);
  assert.match(load('not json').thrown, /JSON/);
  assert.match(load('[1]').thrown, /object/);
  assert.deepEqual(attempt(() => loadOwnerConfig(null)), {});
}));

t('dod1-config: through the command, --config supplies the endpoint and the model, and a bad file refuses with no effect', () => withFixture({}, async fx => {
  const file = path.join(fx.base, 'owner.json');
  fs.writeFileSync(file, JSON.stringify({ endpoint: 'https://file.example.org/v1', model: 'file-model', effort: 'medium' }));
  const result = await fx.run({ drop: ['--model-endpoint'], add: [['--config', file]] });
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.endpoint, 'https://file.example.org/v1');
  assert.equal(plan.model, 'file-model');
  assert.equal(plan.effort, 'medium');
  assert.equal(plan.agent, 'opencode');
  fs.writeFileSync(file, '{"unknown_key": true}');
  await expectRefusal(fx, { drop: ['--model-endpoint'], add: [['--config', file]] }, /unknown_key/);
  await expectRefusal(fx, { add: [['--agent', 'ghost']] }, /agent/);
  await expectRefusal(fx, { add: [['--provider', 'ghost']] }, /provider/);
  await expectRefusal(fx, { deps: { adapters: { opencode: { providers: ['other'] } }, providers: { openai: {}, other: {} } } }, /opencode.*openai|openai.*opencode/);
}));

// S2-AC3: no flag accepts a key value; the key is read only from the environment variable named by --api-key-env.
t('key: an acceptable key passes from the default and from a named variable', () => withFixture({}, async fx => {
  assert.equal(attempt(() => checkApiKey(fx.env, 'ACODER_MODEL_API_KEY')), undefined);
  assert.equal(attempt(() => checkApiKey({ OTHER_NAME: 'a'.repeat(16) }, 'OTHER_NAME')), undefined);
  const result = await fx.run({ env: { MY_KEY: fx.key }, add: [['--api-key-env', 'MY_KEY']] });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!result.stdout.includes(fx.key) && !result.stderr.includes(fx.key));
  assert.equal(JSON.parse(result.stdout).key.env, 'MY_KEY');
}));

t('key: unset, empty, short and bad-byte keys are refused and no message holds the value', () => withFixture({}, async fx => {
  const bad = { unset: undefined, empty: '', 'one too short': 'a'.repeat(15), space: `${'a'.repeat(20)} b`, dot: `${'a'.repeat(20)}.b`, plus: `${'a'.repeat(20)}+b`, newline: `${'a'.repeat(20)}\nb`, quote: `${'a'.repeat(20)}"b`, backslash: `${'a'.repeat(20)}\\b`, nonascii: `${'a'.repeat(20)}é` };
  for (const [name, value] of Object.entries(bad)) {
    const env = value === undefined ? {} : { ACODER_MODEL_API_KEY: value };
    const result = await fx.run({ env });
    assert.equal(result.code, 2, `${name}: ${result.stderr}`);
    assert.match(result.stderr, /^refused: .*ACODER_MODEL_API_KEY/);
    assert.equal(result.stderr.trimEnd().split('\n').length, 1);
    if (value) assert.ok(!result.stderr.includes(value) && !result.stdout.includes(value), `${name}: the message holds the value`);
    assert.match(attempt(() => checkApiKey(env, 'ACODER_MODEL_API_KEY')).thrown, /ACODER_MODEL_API_KEY/);
  }
  assert.equal(attempt(() => checkApiKey({ ACODER_MODEL_API_KEY: 'a'.repeat(16) }, 'ACODER_MODEL_API_KEY')), undefined);
  assert.notEqual(attempt(() => checkApiKey({ ACODER_MODEL_API_KEY: 'a'.repeat(15) }, 'ACODER_MODEL_API_KEY')), undefined);
  await expectRefusal(fx, { env: { OTHER: fx.key }, add: [['--api-key-env', 'MISSING_VAR']] }, /MISSING_VAR/);
}));

t('key: the message of a refused key never holds the value (unit)', () => {
  const secret = 'Z9_-Z9_-Z9_-Z9_-!!';
  const outcome = attempt(() => checkApiKey({ ACODER_MODEL_API_KEY: secret }, 'ACODER_MODEL_API_KEY'));
  assert.match(outcome.thrown ?? '', /ACODER_MODEL_API_KEY/);
  assert.ok(!outcome.thrown.includes(secret) && !outcome.thrown.includes('Z9_-'));
});

t('dod1-config: the owner file must be a regular file of at most 65536 bytes', () => withFixture({}, async fx => {
  const big = path.join(fx.base, 'big.json');
  fs.writeFileSync(big, JSON.stringify({ effort: 'low', pad: 'x'.repeat(70000) }));
  assert.match(attempt(() => loadOwnerConfig(big)).thrown, /larger/);
  const target = path.join(fx.base, 'real.json');
  fs.writeFileSync(target, '{}');
  fs.symlinkSync(target, path.join(fx.base, 'link.json'));
  assert.match(attempt(() => loadOwnerConfig(path.join(fx.base, 'link.json'))).thrown, /regular file/);
  assert.match(attempt(() => loadOwnerConfig(fx.base)).thrown, /regular file/);
  assert.match(attempt(() => loadOwnerConfig(path.join(fx.base, 'missing.json'))).thrown, /regular file/);
}));
