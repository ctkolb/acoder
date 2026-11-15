import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { adapters } from '../adapters/index.mjs';
import { parseReviewRun } from '../lib/args.mjs';
import { loadDefaults, resolveSettings } from '../lib/config.mjs';
import { prepare } from '../lib/prepare.mjs';
import { providers } from '../providers/index.mjs';
import { planFor, stagePayloads } from '../lib/run.mjs';
import { expectedForms } from './helpers/key-forms.mjs';
import { LAUNCHER, makeFixture, must, release, sha } from './helpers/fixtures.mjs';
import * as stub from './helpers/stub-adapter.mjs';

// G11: every test has a finite time limit of its own and is registered from this file.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, fn);

const IMAGE = { ref: `sha256:${'d'.repeat(64)}`, id: `sha256:${'d'.repeat(64)}`, repo_digests: [], env_names: ['NODE_VERSION', 'PATH', 'YARN_VERSION'], allowed_env_names: [] };
const registry = { ...adapters, stub };

function files(root) {
  assert.ok(fs.existsSync(root), `${path.basename(root)} exists`);
  const out = {};
  const walk = (directory, relative) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const shown = relative === '' ? name : `${relative}/${name}`;
      const info = fs.lstatSync(full);
      if (info.isDirectory()) walk(full, shown);
      else out[shown] = fs.readFileSync(full);
    }
  };
  walk(root, '');
  return out;
}

// S4-AC3 (DoD 2, 8): the payloads of A2.1 and A2.2, in the staging directory, without the key and (egress) without mailbox content.
async function withStaged({ extraCa = false, sidecarProgram = null, exports } = {}, fn) {
  const fx = makeFixture({ exports });
  let prepared = null;
  try {
    const add = extraCa ? [['--extra-ca-cert', path.join(fx.base, 'ca.pem')]] : [];
    if (extraCa) fs.writeFileSync(path.join(fx.base, 'ca.pem'), '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n');
    const options = must(() => parseReviewRun(fx.argv({ drop: ['--dry-run'], set: { '--image': IMAGE.ref }, add: [['--agent', 'stub'], ...add] }).slice(2)));
    const settings = must(() => resolveSettings({ options, owner: {}, defaults: loadDefaults(), adapters: registry, providers }));
    prepared = must(() => prepare(options, fx.env, {}));
    const plan = must(() => planFor({ options, settings, prepared, adapters: registry, providers, image: IMAGE, runtimeName: 'docker', runId: '20261115T101500Z-a1b2c3', eventPrefix: 'e'.repeat(32), nonce: 'f'.repeat(32), uid: 501, gid: 20 }));
    must(() => stagePayloads({ plan, prepared, options, sidecarProgram }));
    return await fn({ fx, plan, prepared, options });
  } finally {
    release(prepared);
    fx.cleanup();
  }
}

const source = relative => fs.readFileSync(path.join(LAUNCHER, relative));

t('S4-AC3: the agent payload holds exactly the supervisor, probe and relay programs, the skill copy, run.json, the agent command file and the two /etc files', async () => {
  await withStaged({}, async ({ fx, plan, prepared }) => {
    const agent = files(path.join(prepared.staging.dir, 'agent-payload'));
    assert.deepEqual(Object.keys(agent), ['agent-command.json', 'container/entry.mjs', 'container/probe.mjs', 'container/relay.mjs', 'etc/hosts', 'etc/resolv.conf', 'run.json', 'skill/SKILL.md', 'skill/references/role.md']);
    for (const name of ['entry', 'probe', 'relay']) assert.ok(agent[`container/${name}.mjs`].equals(source(`container/${name}.mjs`)), `${name}.mjs is the launcher's own file`);
    for (const [name, text] of Object.entries(plan.payload_files.agent)) assert.equal(agent[name].toString('utf8'), text, `${name} is the plan's text`);
    assert.equal(agent['etc/hosts'].toString('utf8'), '127.0.0.1 localhost\n127.0.0.1 models.example.org\n');
    assert.equal(JSON.parse(agent['run.json']).tag, fx.tag);
  });
});

t('S4-AC3: the egress payload holds exactly the sidecar, its accounting, the provider profile and egress.json; ca.pem only with --extra-ca-cert', async () => {
  await withStaged({}, async ({ plan, prepared }) => {
    const egress = files(path.join(prepared.staging.dir, 'egress-payload'));
    assert.deepEqual(Object.keys(egress), ['container/accounting.mjs', 'container/proxy.mjs', 'egress.json', 'providers/openai.mjs']);
    for (const relative of ['container/accounting.mjs', 'container/proxy.mjs', 'providers/openai.mjs']) assert.ok(egress[relative].equals(source(relative)), relative);
    assert.equal(egress['egress.json'].toString('utf8'), plan.payload_files.egress['egress.json']);
  });
  await withStaged({ extraCa: true }, async ({ fx, prepared }) => {
    const egress = files(path.join(prepared.staging.dir, 'egress-payload'));
    assert.deepEqual(Object.keys(egress), ['ca.pem', 'container/accounting.mjs', 'container/proxy.mjs', 'egress.json', 'providers/openai.mjs']);
    assert.ok(egress['ca.pem'].equals(fs.readFileSync(path.join(fx.base, 'ca.pem'))));
  });
});

t('S4-AC3: a sidecar double (deps.sidecarProgram) replaces proxy.mjs in the egress payload and nothing else changes', async () => {
  const fx = makeFixture();
  const double = path.join(fx.base, 'double.mjs');
  fs.writeFileSync(double, '// a sidecar double\n');
  try {
    await withStaged({ sidecarProgram: double }, async ({ prepared }) => {
      const egress = files(path.join(prepared.staging.dir, 'egress-payload'));
      assert.deepEqual(Object.keys(egress), ['container/accounting.mjs', 'container/proxy.mjs', 'egress.json', 'providers/openai.mjs']);
      assert.equal(egress['container/proxy.mjs'].toString('utf8'), '// a sidecar double\n');
    });
  } finally { fx.cleanup(); }
});

t('S4-AC3: neither payload holds the key in any form; the egress payload holds no mailbox content', async () => {
  await withStaged({}, async ({ fx, prepared }) => {
    const forms = Object.values(expectedForms(fx.key));
    for (const dir of ['agent-payload', 'egress-payload']) {
      for (const [name, bytes] of Object.entries(files(path.join(prepared.staging.dir, dir)))) {
        const text = bytes.toString('latin1');
        for (const form of forms) assert.ok(!text.includes(form) && !name.includes(form), `${dir}/${name} holds no key form`);
      }
    }
    const egress = files(path.join(prepared.staging.dir, 'egress-payload'));
    const mailboxHashes = new Set(Object.values(files(fx.mailbox)).map(bytes => sha(bytes)));
    for (const [name, bytes] of Object.entries(egress)) {
      assert.ok(!mailboxHashes.has(sha(bytes)), `${name} is not a mailbox file`);
      assert.ok(!bytes.toString('utf8').includes(fx.ticketText.split('\n')[0]), `${name} holds no ticket text`);
    }
  });
});

t('S4-AC3: both payloads and the snapshot live in the staging directory; only M4 to M6 are bind sources outside it, and no source is a live mailbox, export or the repository', async () => {
  await withStaged({ exports: [{ role: 'code' }, { role: 'docs', place: 'inside' }] }, async ({ fx, plan, prepared }) => {
    const staging = prepared.staging.dir;
    const writable = [fx.writable.scratch, fx.writable.reportMd, fx.writable.reportJson];
    const binds = plan.mounts.filter(mount => mount.kind === 'bind');
    for (const mount of binds) {
      if (writable.includes(mount.source)) { assert.ok(['scratch', 'report'].includes(mount.role) && mount.mode === 'rw' && mount.container === 'agent'); continue; }
      assert.ok(mount.source.startsWith(`${staging}/`), `${mount.target} comes from the staging directory`);
      assert.equal(mount.mode, 'ro', `${mount.target} is read-only`);
    }
    const sources = binds.map(mount => mount.source);
    for (const live of [fx.mailbox, fx.export('code').dir, fx.export('docs').dir, path.dirname(LAUNCHER), LAUNCHER]) assert.ok(!sources.includes(live), `${live} is no mount source`);
    assert.deepEqual(binds.filter(mount => writable.includes(mount.source)).map(mount => mount.target), writable);
    for (const dir of ['agent-payload', 'egress-payload', 'mailbox', 'export-code']) assert.ok(fs.lstatSync(path.join(staging, dir)).isDirectory(), dir);
  });
});

t('S4-AC3: the staged payload trees are read-only (no file or directory is writable)', async () => {
  await withStaged({}, async ({ prepared }) => {
    const walk = directory => {
      for (const name of fs.readdirSync(directory)) {
        const full = path.join(directory, name);
        const info = fs.lstatSync(full);
        assert.equal(info.mode & 0o222, 0, `${full} is not writable`);
        if (info.isDirectory()) walk(full);
      }
    };
    for (const dir of ['agent-payload', 'egress-payload']) {
      assert.ok(fs.existsSync(path.join(prepared.staging.dir, dir)), `${dir} exists`);
      assert.equal(fs.lstatSync(path.join(prepared.staging.dir, dir)).mode & 0o222, 0, `${dir} is not writable`);
      walk(path.join(prepared.staging.dir, dir));
    }
  });
});
