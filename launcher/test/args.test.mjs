import assert from 'node:assert/strict';
import { parseReviewRun, DEFAULT_SCRATCH_MAX_BYTES } from '../lib/args.mjs';
import nodeTest from 'node:test';
import { attempt, expectRefusal, withFixture } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own. The test is registered from this file, so that the mutation runner can count it per module.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, fn);

// S2-AC1: `acoder review run` accepts exactly the flags of A1.5; each refusal is exit code 2, one line, the refused last line, no effect.
t('flags: a complete valid command line parses to the expected options', () => withFixture({}, async fx => {
  const options = attempt(() => parseReviewRun(fx.argv({ add: [['--exclude', 'S1'], ['--allow-image-env', 'FOO_BAR'], ['--max-in-flight', '8'], ['--effort', 'low'], ['--provider', 'openai'], ['--agent', 'opencode'], ['--model', 'openai/gpt-x'], ['--scratch-size', '3g'], ['--runtime', 'podman']] }).slice(2)));
  assert.equal(options.ticket, fx.ticket);
  assert.equal(options.ticketSha256, fx.ticketSha);
  assert.equal(options.mailbox, fx.mailbox);
  assert.deepEqual(options.exports, [{ role: 'code', dir: fx.export('code').dir }]);
  assert.deepEqual(options.manifests, { code: fx.export('code').manifest });
  assert.deepEqual(options.manifestSha256, { code: fx.export('code').manifestSha });
  assert.deepEqual(options.excludes, ['S1']);
  assert.deepEqual(options.allowImageEnv, ['FOO_BAR']);
  assert.equal(options.budgetMinutes, 5);
  assert.equal(options.budgetCalls, 10);
  assert.equal(options.budgetTokens, 1000);
  assert.equal(options.maxInFlight, 8);
  assert.equal(options.effort, 'low');
  assert.equal(options.model, 'openai/gpt-x');
  assert.equal(options.scratchSize, '3g');
  assert.equal(options.runtime, 'podman');
  assert.equal(options.apiKeyEnv, 'ACODER_MODEL_API_KEY');
  assert.equal(options.dryRun, true);
  assert.equal(options.noExport, false);
}));

t('flags: --no-export parses and the defaults are filled', () => withFixture({ noExport: true }, async fx => {
  const options = attempt(() => parseReviewRun(fx.argv().slice(2)));
  assert.equal(options.noExport, true);
  assert.deepEqual(options.exports, []);
  assert.equal(options.scratchSize, '2g');
  assert.equal(options.snapshotMaxBytes, 4294967296);
  assert.equal(options.maxInFlight, null);
  assert.equal(options.runtime, null);
}));

const REQUIRED = ['--ticket', '--ticket-sha256', '--mailbox', '--image', '--budget-minutes', '--budget-calls', '--budget-tokens'];
for (const flag of REQUIRED) {
  t(`refuses: missing required flag ${flag}`, () => withFixture({}, fx => expectRefusal(fx, { drop: [flag] }, new RegExp(flag))));
}
t('refuses: missing --model-endpoint when no configuration has it', () => withFixture({}, fx => expectRefusal(fx, { drop: ['--model-endpoint'] }, /endpoint/)));
t('refuses: an unknown flag', () => withFixture({}, fx => expectRefusal(fx, { add: [['--bogus', 'x']] }, /unknown flag --bogus/)));
t('refuses: a flag that takes a key value is unknown', () => withFixture({}, fx => expectRefusal(fx, { add: [['--api-key', 'x'.repeat(20)]] }, /unknown flag --api-key/)));
t('refuses: a positional argument', () => withFixture({}, fx => expectRefusal(fx, { add: [['stray']] }, /stray/)));
t('refuses: a flag without its value', () => withFixture({}, fx => expectRefusal(fx, { drop: ['--effort'], add: [['--effort']] }, /--effort/)));
for (const flag of ['--ticket', '--mailbox', '--image', '--budget-minutes', '--budget-calls', '--budget-tokens', '--model-endpoint', '--staging-dir', '--ticket-sha256', '--max-in-flight', '--scratch-max-bytes']) {
  t(`refuses: repeated single-value flag ${flag}`, () => withFixture({}, fx => {
    const present = fx.tokens().find(([name]) => name === flag);
    const value = present?.[1] ?? '3';
    return expectRefusal(fx, { add: present ? [[flag, value]] : [[flag, value], [flag, value]] }, new RegExp(`${flag}.*twice`));
  }));
}
for (const [name, value] of [['ticket', 'rel/ticket-x.md'], ['mailbox', 'run'], ['staging-dir', 'tmp'], ['reviewer-skill', 'skill'], ['config', 'cfg.json'], ['extra-ca-cert', 'ca.pem']]) {
  t(`refuses: a relative path for --${name}`, () => withFixture({}, fx => expectRefusal(fx, { drop: [`--${name}`], add: [[`--${name}`, value]] }, new RegExp(`--${name}`))));
}
t('refuses: a relative path for --export and --manifest', () => withFixture({}, async fx => {
  await expectRefusal(fx, { set: { '--export': 'code=exp/code' } }, /--export/);
  await expectRefusal(fx, { set: { '--manifest': 'code=manifest.json' } }, /--manifest/);
}));
t('refuses: --export together with --no-export', () => withFixture({}, fx => expectRefusal(fx, { add: [['--no-export']] }, /--export.*--no-export|--no-export.*--export/)));
t('refuses: neither --export nor --no-export', () => withFixture({}, fx => expectRefusal(fx, { drop: ['--export', '--manifest', '--manifest-sha256'] }, /--export or --no-export/)));
t('refuses: an export role without its manifest', () => withFixture({}, fx => expectRefusal(fx, { drop: ['--manifest'] }, /code.*--manifest\b/)));
t('refuses: an export role without its manifest hash', () => withFixture({}, fx => expectRefusal(fx, { drop: ['--manifest-sha256'] }, /code.*--manifest-sha256/)));
t('refuses: a manifest for a role that has no export', () => withFixture({}, fx => expectRefusal(fx, { add: [['--manifest', `docs=${fx.export('code').manifest}`], ['--manifest-sha256', `docs=${'c'.repeat(64)}`]] }, /docs/)));
t('refuses: a manifest flag with --no-export', () => withFixture({ noExport: true }, fx => expectRefusal(fx, { add: [['--manifest', `docs=${fx.ticket}`]] }, /--manifest/)));
t('refuses: a duplicate role', () => withFixture({}, fx => expectRefusal(fx, { add: [['--export', `code=${fx.export('code').dir}`]] }, /duplicate.*code/)));
for (const role of ['Code', 'a_b', '', 'a b']) {
  t(`refuses: export role ${JSON.stringify(role)}`, () => withFixture({}, fx => expectRefusal(fx, { set: { '--export': `${role}=${fx.export('code').dir}` } }, /role/)));
}
t('refuses: an export flag without a role', () => withFixture({}, fx => expectRefusal(fx, { set: { '--export': fx.export('code').dir } }, /--export/)));
for (const value of ['abc', '0', '-1', '1.5', '', '1e3', ' 7', '007', '9007199254740993']) {
  for (const flag of ['--budget-minutes', '--budget-calls', '--budget-tokens']) {
    t(`refuses: ${flag} ${JSON.stringify(value)}`, () => withFixture({}, fx => expectRefusal(fx, { set: { [flag]: value } }, new RegExp(flag))));
  }
}
for (const value of ['0', '17', 'x', '-1', '4.5']) {
  t(`refuses: --max-in-flight ${value}`, () => withFixture({}, fx => expectRefusal(fx, { add: [['--max-in-flight', value]] }, /--max-in-flight/)));
}
for (const value of ['1', '16']) {
  t(`accepts: --max-in-flight ${value}`, () => withFixture({}, async fx => assert.equal(attempt(() => parseReviewRun(fx.argv({ add: [['--max-in-flight', value]] }).slice(2))).maxInFlight, Number(value))));
}
const ENDPOINTS = {
  'a plain http scheme': 'http://models.example.org/v1', 'a port other than 443': 'https://models.example.org:8443/v1',
  'an IPv4 literal': 'https://192.0.2.7/v1', 'an IPv6 literal': 'https://[2001:db8::1]/v1', 'user info': 'https://user:pw@models.example.org/v1',
  'a user name only': 'https://user@models.example.org/v1', 'a query': 'https://models.example.org/v1?x=1', 'a fragment': 'https://models.example.org/v1#frag',
  'an empty query': 'https://models.example.org/v1?', 'no host': 'https:///v1', 'not a URL': 'models.example.org', 'a number host': 'https://3232235777/v1', 'a hex host': 'https://0x7f.1/v1',
  'a space': 'https://models.example.org/a b', 'a backslash': 'https://models.example.org\\v1',
};
for (const [name, value] of Object.entries(ENDPOINTS)) {
  t(`refuses: an endpoint with ${name}`, () => withFixture({}, fx => expectRefusal(fx, { set: { '--model-endpoint': value } }, /--model-endpoint/)));
}
for (const value of ['https://models.example.org', 'https://models.example.org:443/v1', 'https://models.example.org/a/b/']) {
  t(`accepts: endpoint ${value}`, () => withFixture({}, async fx => assert.equal(attempt(() => parseReviewRun(fx.argv({ set: { '--model-endpoint': value } }).slice(2))).modelEndpoint, value)));
}
t('refuses: --model with a provider prefix that differs from the provider', () => withFixture({}, async fx => {
  await expectRefusal(fx, { add: [['--model', 'other/gpt-x']] }, /--model/);
  await expectRefusal(fx, { add: [['--provider', 'openai'], ['--model', 'anthropic/x']] }, /--model/);
}));
t('accepts: --model with the matching provider prefix or none', () => withFixture({}, async fx => {
  for (const model of ['openai/gpt-x', 'gpt-x']) {
    const result = await fx.run({ add: [['--model', model]] });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).model, 'gpt-x');
  }
}));
for (const [flag, value] of [['--ticket-sha256', 'A'.repeat(64)], ['--ticket-sha256', 'a'.repeat(63)], ['--effort', 'High'], ['--effort', 'a1'], ['--runtime', 'lxc'], ['--scratch-size', '0'], ['--scratch-size', 'big'],
  ['--image', 'repo/name:latest'], ['--image', 'name'], ['--image', 'sha256:abc'], ['--allow-image-env', 'a b'], ['--allow-image-env', '1X'], ['--exclude', '../S1'], ['--exclude', '/abs'], ['--exclude', 'a/../b'], ['--exclude', ''],
  ['--api-key-env', 'a b'], ['--api-key-env', '1X'], ['--agent', 'Bad'], ['--provider', 'Bad'], ['--snapshot-max-bytes', '0']]) {
  t(`refuses: ${flag} ${JSON.stringify(value)}`, () => withFixture({}, fx => expectRefusal(fx, { drop: [flag], add: [[flag, value]] }, new RegExp(flag))));
}

// dod5-disk (flag part): --scratch-max-bytes takes a positive safe integer and defaults to 4294967296.
t('dod5-disk: --scratch-max-bytes default, valid and invalid values', () => withFixture({}, async fx => {
  assert.equal(DEFAULT_SCRATCH_MAX_BYTES, 4294967296);
  assert.equal(attempt(() => parseReviewRun(fx.argv().slice(2))).scratchMaxBytes, 4294967296);
  for (const [value, expected] of [['1', 1], ['4294967296', 4294967296], ['9007199254740991', 9007199254740991]]) {
    assert.equal(attempt(() => parseReviewRun(fx.argv({ add: [['--scratch-max-bytes', value]] }).slice(2))).scratchMaxBytes, expected);
  }
  for (const value of ['0', '-5', '1.5', 'abc', '', '9007199254740992', '1e9', '0x10']) {
    await expectRefusal(fx, { add: [['--scratch-max-bytes', value]] }, /--scratch-max-bytes/);
  }
}));

// dod5-minutes: --budget-minutes becomes wall_seconds = minutes * 60.
t('dod5-minutes: the plan carries wall_seconds = minutes * 60', () => withFixture({}, async fx => {
  for (const minutes of [1, 7, 90]) {
    const result = await fx.run({ set: { '--budget-minutes': String(minutes) } });
    assert.equal(result.code, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.limits.wall_seconds, minutes * 60);
    assert.equal(plan.limits.calls, 10);
    assert.equal(plan.limits.tokens, 1000);
    assert.equal(plan.limits.max_in_flight, 4);
    assert.equal(plan.limits.scratch_max_bytes, 4294967296);
  }
}));

t('flags: a budget whose wall-clock seconds are not a safe integer is refused', () => withFixture({}, async fx => {
  await expectRefusal(fx, { set: { '--budget-minutes': '9007199254740991' } }, /--budget-minutes/);
}));
