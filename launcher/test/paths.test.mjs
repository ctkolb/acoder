import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkOverlap, homeRuleViolation, isReservedTarget, resolveHome, writablePaths } from '../lib/paths.mjs';
import nodeTest from 'node:test';
import { attempt, expectRefusal, lastLine, listing, makeFixture, withFixture } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own. The test is registered from this file, so that the mutation runner can count it per module.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, fn);

const dryRun = (fx, options) => fx.run(options);

// S2-AC4 (dod2-paths): each rule of A2.4 is a refusal with exit code 2 and no effect.
const INPUTS = [
  ['--ticket', fx => fx.ticket], ['--mailbox', fx => fx.mailbox], ['--export', fx => `code=${fx.export('code').dir}`, 'code='], ['--manifest', fx => `code=${fx.export('code').manifest}`, 'code='],
  ['--reviewer-skill', fx => fx.skill], ['--staging-dir', fx => fx.staging],
];
for (const [flag, valueOf, prefix = ''] of INPUTS) {
  t(`dod2-paths rule 1: ${flag} must equal its real path (symbolic link, dot, dot-dot, trailing slash, double slash)`, () => withFixture({}, async fx => {
    const real = valueOf(fx).slice(prefix.length);
    const link = `${fx.base}/link-to-input`;
    fs.symlinkSync(path.dirname(real), link);
    const variants = {
      'symbolic link component': `${link}/${path.basename(real)}`,
      'dot-dot component': `${path.dirname(real)}/../${path.basename(path.dirname(real))}/${path.basename(real)}`,
      'dot component': `${path.dirname(real)}/./${path.basename(real)}`,
      'trailing slash': `${real}/`,
      'double slash': `${path.dirname(real)}//${path.basename(real)}`,
      'missing path': `${real}-missing`,
    };
    for (const [name, value] of Object.entries(variants)) {
      await expectRefusal(fx, { set: { [flag]: prefix + value } }, new RegExp(flag)).catch(error => { error.message = `${flag} ${name}: ${error.message}`; throw error; });
    }
  }));
}
t('dod2-paths rule 1: --config and --extra-ca-cert must equal their real paths', () => withFixture({}, async fx => {
  const config = path.join(fx.base, 'owner.json');
  const ca = path.join(fx.base, 'ca.pem');
  fs.writeFileSync(config, '{}');
  fs.writeFileSync(ca, 'pem\n');
  fs.symlinkSync(config, path.join(fx.base, 'cfg-link'));
  fs.symlinkSync(ca, path.join(fx.base, 'ca-link'));
  await expectRefusal(fx, { add: [['--config', path.join(fx.base, 'cfg-link')]] }, /--config/);
  await expectRefusal(fx, { add: [['--extra-ca-cert', path.join(fx.base, 'ca-link')]] }, /--extra-ca-cert/);
  assert.equal((await dryRun(fx, { add: [['--config', config], ['--extra-ca-cert', ca]] })).code, 0);
}));

t('dod2-paths rule 2: the ticket lies two levels below the mailbox and is named ticket-<tag>.md', () => withFixture({}, async fx => {
  const deep = path.join(fx.stage, 'deeper');
  fs.mkdirSync(deep);
  const moved = path.join(deep, path.basename(fx.ticket));
  fs.copyFileSync(fx.ticket, moved);
  await expectRefusal(fx, { set: { '--ticket': moved } }, /two levels/);
  const shallow = path.join(fx.mailbox, path.basename(fx.ticket));
  fs.copyFileSync(fx.ticket, shallow);
  await expectRefusal(fx, { set: { '--ticket': shallow } }, /two levels/);
  const misnamed = path.join(fx.stage, 'notes.md');
  fs.copyFileSync(fx.ticket, misnamed);
  await expectRefusal(fx, { set: { '--ticket': misnamed } }, /ticket-<tag>\.md|named/);
}));
t('dod2-paths rule 2: the tag matches [A-Za-z0-9._-]+ and has at most 120 characters', () => withFixture({}, async fx => {
  for (const tag of ['has space', 'semi;colon', 'x'.repeat(121), 'a/b']) {
    const name = tag.includes('/') ? null : `ticket-${tag}.md`;
    if (!name) continue;
    const file = path.join(fx.stage, name);
    fs.writeFileSync(file, `TICKET ${tag}\nTo: REVIEWER\n`);
    await expectRefusal(fx, { set: { '--ticket': file } }, /tag/);
  }
  const longest = 'y'.repeat(120);
  const file = path.join(fx.stage, `ticket-${longest}.md`);
  const text = `TICKET ${longest}\nTo: REVIEWER\n${path.join(fx.stage, `scratch-${longest}`)} ${path.join(fx.stage, `report-${longest}.md`)} ${path.join(fx.stage, `report-${longest}.json`)}\n`;
  fs.writeFileSync(file, text);
  const ledger = JSON.parse(fs.readFileSync(fx.ledger, 'utf8'));
  ledger.tickets.push({ tag: longest, role: 'REVIEWER', state: 'pending' });
  fs.writeFileSync(fx.ledger, JSON.stringify(ledger));
  const sha = (await import('node:crypto')).createHash('sha256').update(text).digest('hex');
  const result = await dryRun(fx, { set: { '--ticket': file, '--ticket-sha256': sha } });
  assert.equal(result.code, 0, result.stderr);
}));

t('dod2-paths rule 4: a comma, double quote, backslash, newline or other control character in a path is refused', () => {
  const chars = { comma: ',', quote: '"', backslash: '\\', newline: '\n', tab: '\t', escape: '\u001b', del: '\u007f' };
  return Promise.all(Object.entries(chars).map(([name, char]) => withFixture({ mailboxName: `run${char}x` }, async fx => {
    await expectRefusal(fx, {}, /--mailbox|character/).catch(error => { error.message = `${name}: ${error.message}`; throw error; });
  })));
});
t('dod2-paths rule 4: the same characters in an export path and in the staging directory path', () => Promise.all([',', '"'].map(char => withFixture({}, async fx => {
  const odd = path.join(fx.base, `odd${char}dir`);
  fs.mkdirSync(odd);
  await expectRefusal(fx, { set: { '--staging-dir': odd } }, /--staging-dir/);
  const exportDir = path.join(fx.base, 'exp', `x${char}y`);
  fs.renameSync(fx.export('code').dir, exportDir);
  await expectRefusal(fx, { set: { '--export': `code=${exportDir}` } }, /--export/);
}))));

t('dod2-paths rule 5: every reserved container target, and everything inside it, is reserved', () => {
  for (const target of ['/', '/acoder', '/work', '/agent', '/tmp', '/proc', '/sys', '/dev', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/run', '/var/run']) {
    assert.equal(attempt(() => isReservedTarget(target)), true, target);
    if (target !== '/') assert.equal(attempt(() => isReservedTarget(`${target}/deeper/path`)), true, `${target}/deeper/path`);
  }
  for (const other of ['/tmpfoo', '/usr2/x', '/var/tmp', '/var/runner', '/acoder2', '/home2', '/private/tmp']) {
    assert.equal(attempt(() => isReservedTarget(other)), false, other);
  }
});
t('dod2-paths rule 5: a mailbox or export inside a reserved target is refused (the fixture base is added as a target)', () => withFixture({}, async fx => {
  await expectRefusal(fx, { deps: { extraReserved: [fx.base] } }, /reserved/);
  await withFixture({}, async other => {
    await expectRefusal(other, { deps: { extraReserved: [path.dirname(other.export('code').dir)] } }, /reserved/);
    assert.equal((await other.run({})).code, 0, 'without the extra target the same inputs pass');
  });
}));

// spec10-overlap (A2.4.6): pure cases for every kind, and a few end to end.
const model = fx => ({ mailbox: fx.mailbox, exports: [{ role: 'code', dir: fx.export('code').dir }], manifests: [{ role: 'code', file: fx.export('code').manifest }], ...fx.writable, staging: fx.staging });
const overlap = value => attempt(() => checkOverlap(value));
t('spec10-overlap: the accepted layout passes and each overlap kind is a refusal (pure)', () => withFixture({}, async fx => {
  const base = model(fx);
  assert.equal(overlap(base), undefined);
  const cases = {
    'export equals the mailbox': { exports: [{ role: 'code', dir: fx.mailbox }] },
    'export contains the mailbox': { exports: [{ role: 'code', dir: fx.base }] },
    'export equals the scratch path': { exports: [{ role: 'code', dir: fx.writable.scratch }] },
    'export lies inside the scratch path': { exports: [{ role: 'code', dir: `${fx.writable.scratch}/inner` }] },
    'export contains the scratch path': { exports: [{ role: 'code', dir: fx.stage }] },
    'export equals a report path': { exports: [{ role: 'code', dir: fx.writable.reportMd }] },
    'export lies inside a report path': { exports: [{ role: 'code', dir: `${fx.writable.reportJson}/inner` }] },
    'export contains a report path': { exports: [{ role: 'code', dir: path.dirname(fx.writable.reportMd) }] },
    'export equals another export': { exports: [{ role: 'code', dir: fx.export('code').dir }, { role: 'docs', dir: fx.export('code').dir }] },
    'export contains another export': { exports: [{ role: 'code', dir: fx.export('code').dir }, { role: 'docs', dir: path.dirname(fx.export('code').dir) }] },
    'export lies inside another export': { exports: [{ role: 'code', dir: fx.export('code').dir }, { role: 'docs', dir: `${fx.export('code').dir}/src` }] },
    'manifest inside an export': { manifests: [{ role: 'code', file: `${fx.export('code').dir}/m.json` }] },
    'manifest inside the scratch path': { manifests: [{ role: 'code', file: `${fx.writable.scratch}/m.json` }] },
    'manifest outside the mailbox': { manifests: [{ role: 'code', file: `${fx.base}/m.json` }] },
    'staging equals the mailbox': { staging: fx.mailbox },
    'staging contains the mailbox': { staging: fx.base },
    'staging lies inside the mailbox': { staging: `${fx.mailbox}/S1` },
    'staging equals an export': { staging: fx.export('code').dir },
    'staging contains an export': { staging: path.dirname(fx.export('code').dir) },
    'staging lies inside an export': { staging: `${fx.export('code').dir}/src` },
  };
  const patterns = {
    'export equals the mailbox': /equals or contains the mailbox/, 'export contains the mailbox': /equals or contains the mailbox/,
    'export equals the scratch path': /scratch path/, 'export lies inside the scratch path': /scratch path/, 'export contains the scratch path': /scratch path/,
    'export equals a report path': /report path/, 'export lies inside a report path': /report path/, 'export contains a report path': /scratch path|report path/,
    'export equals another export': /export docs|export code/, 'export contains another export': /export docs|export code/, 'export lies inside another export': /export docs|export code/,
    'manifest inside an export': /lies inside an export/, 'manifest inside the scratch path': /inside the scratch path/, 'manifest outside the mailbox': /outside the mailbox/,
    'staging equals the mailbox': /staging directory .* the mailbox/, 'staging contains the mailbox': /staging directory/, 'staging lies inside the mailbox': /staging directory .* the mailbox/,
    'staging equals an export': /staging directory .* export/, 'staging contains an export': /staging directory .* export/, 'staging lies inside an export': /staging directory .* export/,
  };
  for (const [name, change] of Object.entries(cases)) {
    const outcome = overlap({ ...base, ...change });
    assert.match(outcome?.thrown ?? '', patterns[name], `${name}: expected this refusal`);
  }
  assert.equal(overlap({ ...base, exports: [{ role: 'code', dir: fx.export('code').dir }, { role: 'docs', dir: `${fx.base}/exp-docs` }] }), undefined, 'a sibling export of a similar name is not an overlap');
  assert.equal(overlap({ ...base, exports: [{ role: 'code', dir: `${fx.base}/exp/code` }, { role: 'docs', dir: `${fx.base}/exp/code2` }] }), undefined, 'a name that only shares a prefix is not an overlap');
}));
t('spec10-overlap: end to end an export that contains the stage folder, the mailbox or equals the mailbox is refused', () => withFixture({ exports: [{ role: 'code', place: 'inside' }] }, async fx => {
  const real = fx.export('code');
  await expectRefusal(fx, { set: { '--export': `code=${fx.mailbox}` } }, /export/);
  await expectRefusal(fx, { set: { '--export': `code=${fx.base}` } }, /export/);
  await expectRefusal(fx, { set: { '--export': `code=${fx.stage}` } }, /export/);
  await expectRefusal(fx, { set: { '--staging-dir': real.dir } }, /staging/);
  await expectRefusal(fx, { set: { '--staging-dir': fx.stage } }, /staging/);
  assert.equal((await dryRun(fx, {})).code, 0);
}));

// spec21-manifest-location: the four combinations of export and manifest inside or outside the mailbox.
t('spec21-manifest-location: inside or outside the mailbox for the export and for the manifest', () => withFixture({}, async outside => {
  // export outside the mailbox, manifest inside the mailbox: accepted
  assert.equal((await dryRun(outside, {})).code, 0);
  // export outside the mailbox, manifest outside the mailbox (next to the export): refused
  const beside = path.join(outside.base, 'exp', 'manifest-code.json');
  fs.copyFileSync(outside.export('code').manifest, beside);
  await expectRefusal(outside, { set: { '--manifest': `code=${beside}` } }, /manifest/);
  // export outside, manifest inside the export: refused
  await withFixture({ exports: [{ role: 'code', place: 'inside' }] }, async inside => {
    // export inside the mailbox, manifest inside the mailbox but outside the export: accepted
    assert.equal((await dryRun(inside, {})).code, 0);
    const text = fs.readFileSync(inside.export('code').manifest);
    const within = path.join(inside.export('code').dir, 'src', 'm.json');
    fs.chmodSync(path.dirname(within), 0o755);
    fs.writeFileSync(within, text);
    fs.chmodSync(path.dirname(within), 0o555);
    await expectRefusal(inside, { set: { '--manifest': `code=${within}` } }, /manifest/);
    // export inside the mailbox, manifest outside the mailbox: refused
    const elsewhere = path.join(inside.base, 'manifest-code.json');
    fs.writeFileSync(elsewhere, text);
    await expectRefusal(inside, { set: { '--manifest': `code=${elsewhere}` } }, /manifest/);
  });
}));

// S2-AC5 (spec01-scratch-exists): the three writable paths come from the tag only; any existing path is a refusal.
t('spec01-scratch-exists: the three writable paths are derived from the tag only', () => {
  const stage = '/syn/run/S2';
  const derived = attempt(() => writablePaths(`${stage}/ticket-abc.def_1.md`));
  assert.deepEqual(derived, {
    tag: 'abc.def_1', stage, scratch: `${stage}/scratch-abc.def_1`, reportMd: `${stage}/report-abc.def_1.md`, reportJson: `${stage}/report-abc.def_1.json`,
    runRecord: `${stage}/run-abc.def_1.json`, startedRecord: `${stage}/run-abc.def_1.started.json`,
  });
});
t('spec01-scratch-exists: an existing scratch path of any kind, report file, run record or started file is a refusal', () => withFixture({}, async fx => {
  const { scratch, reportMd, reportJson, stage } = fx.writable;
  const place = {
    'an empty scratch directory': () => fs.mkdirSync(scratch), 'a scratch directory with a file': () => { fs.mkdirSync(scratch); fs.writeFileSync(`${scratch}/x`, 'x'); },
    'a scratch regular file': () => fs.writeFileSync(scratch, ''), 'a dangling scratch symbolic link': () => fs.symlinkSync(`${stage}/nowhere`, scratch), 'a scratch symbolic link to a directory': () => fs.symlinkSync(fx.mailbox, scratch),
    'an existing report md': () => fs.writeFileSync(reportMd, ''), 'an existing report json': () => fs.writeFileSync(reportJson, '{}'), 'a report md directory': () => fs.mkdirSync(reportMd),
    'a report json symbolic link': () => fs.symlinkSync(`${stage}/nowhere`, reportJson),
    'run-<tag>.json': () => fs.writeFileSync(`${stage}/run-${fx.tag}.json`, '{}'), 'run-<tag>.started.json': () => fs.writeFileSync(`${stage}/run-${fx.tag}.started.json`, '{}'),
  };
  for (const [name, make] of Object.entries(place)) {
    make();
    await expectRefusal(fx, {}, /exist|already/).catch(error => { error.message = `${name}: ${error.message}`; throw error; });
    fs.rmSync(scratch, { recursive: true, force: true });
    for (const file of [reportMd, reportJson, `${stage}/run-${fx.tag}.json`, `${stage}/run-${fx.tag}.started.json`]) fs.rmSync(file, { recursive: true, force: true });
  }
  assert.equal((await dryRun(fx, {})).code, 0, 'with none of them present the launch proceeds');
}));

// S2-AC6 (dod2-home): one case per row of table A2.6.6, a synthetic home passed as a parameter.
const HOME = '/syn/home-user';
t('dod2-home: table A2.6.6, one case per row', () => {
  const violation = p => attempt(() => homeRuleViolation(p, HOME));
  assert.equal(violation(HOME)?.rule, 1, 'mailbox = home');
  assert.equal(violation('/syn')?.rule, 2, 'mailbox = parent of home');
  assert.equal(violation('/')?.rule, 2, 'mailbox = /');
  assert.equal(violation(`${HOME}/agent-mailbox/proj/run-1`), null, 'mailbox under home');
  assert.equal(violation(`${HOME}/work/exports/tip`), null, 'export under home');
  assert.equal(violation(`${HOME}/.ssh/x`)?.rule, 4);
  assert.equal(violation(`${HOME}/.config/gcloud/x`)?.rule, 4);
  assert.equal(violation(`${HOME}/a/.AWS/b`)?.rule, 4);
  assert.equal(violation('/syn/elsewhere/run'), null, 'a path outside home is not refused by the home rule');
  assert.equal(violation(`${HOME}-other/run`), null, 'a sibling that only shares the prefix');
  assert.equal(violation(`${HOME}/.config/other/x`), null);
  assert.equal(violation(`${HOME}/.config`), null);
  assert.equal(violation(`${HOME}/work/.gitx/y`), null);
});
t('dod2-home: each credential name of rule 4, once, in differing letter case', () => {
  const single = ['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', '.claude', '.codex', '.password-store', '.terraform.d', '.oci', '.pki', 'Keychains'];
  const pairs = ['.config/gcloud', '.config/gh', '.config/git', '.config/op', '.config/opencode', '.config/containers', '.local/share/opencode', '.local/share/containers'];
  const files = ['.netrc', '.git-credentials', '.npmrc', '.pypirc', '.pgpass'];
  const swapCase = text => [...text].map((char, index) => (index % 2 === 0 ? char.toUpperCase() : char.toLowerCase())).join('');
  for (const name of [...single, ...pairs, ...files]) {
    for (const spelled of [name, swapCase(name), name.toUpperCase()]) {
      assert.equal(attempt(() => homeRuleViolation(`${HOME}/work/${spelled}/inner`, HOME))?.rule, 4, `${spelled} as a middle component`);
      assert.equal(attempt(() => homeRuleViolation(`/syn/outside/${spelled}`, HOME))?.rule, 4, `${spelled} outside home, last component`);
    }
  }
  assert.equal(attempt(() => homeRuleViolation(`${HOME}/work/.config/other/.local`, HOME)), null, 'the two names must be consecutive');
  assert.equal(attempt(() => homeRuleViolation(`${HOME}/work/gcloud/.config`, HOME)), null, 'and in that order');
});
t('dod2-home: end to end with a synthetic home: home = mailbox, parent of the mailbox, and a credential component', () => withFixture({}, async fx => {
  await expectRefusal(fx, { deps: { home: fx.mailbox } }, /home/);
  await expectRefusal(fx, { deps: { home: path.join(fx.mailbox, 'S1') } }, /home/);
  await expectRefusal(fx, { deps: { home: fx.export('code').dir } }, /home/);
  await expectRefusal(fx, { deps: { home: path.join(fx.staging) } }, /home/);
  assert.equal((await dryRun(fx, { deps: { home: path.join(fx.base, 'nowhere-home') } })).code, 0);
  assert.equal((await dryRun(fx, { deps: { home: path.dirname(fx.base) } })).code, 0, 'the mailbox under home is allowed');
}));
t('dod2-home: a credential component in the mailbox, export or staging path, and each source kind', () => Promise.all(['.Ssh', '.CLAUDE', '.config'].map(name => withFixture({ mailboxName: `${name}/run` }, async fx => {
  if (name === '.config') { assert.equal((await dryRun(fx, {})).code, 0); return; }
  await expectRefusal(fx, {}, /credential|\.ssh|\.claude/i);
}))));
t('dod2-home: a credential name in the export path, the staging path and the skill path is refused', () => withFixture({}, async fx => {
  const dirs = { '--staging-dir': path.join(fx.base, '.aws', 'tmp'), '--reviewer-skill': path.join(fx.base, '.codex', 'skill') };
  for (const [flag, dir] of Object.entries(dirs)) {
    fs.mkdirSync(dir, { recursive: true });
    await expectRefusal(fx, { set: { [flag]: dir } }, /credential/);
  }
  const exportDir = path.join(fx.base, 'exp', '.docker', 'code');
  fs.mkdirSync(path.dirname(exportDir), { recursive: true });
  fs.chmodSync(fx.export('code').dir, 0o755);
  fs.renameSync(fx.export('code').dir, exportDir);
  fs.chmodSync(exportDir, 0o555);
  await expectRefusal(fx, { set: { '--export': `code=${exportDir}` } }, /credential/);
}));
t('dod2-home: $HOME that resolves differently from the account home is a refusal; the same value is accepted', () => withFixture({}, async fx => {
  const home = path.join(fx.base, 'acct-home');
  const other = path.join(fx.base, 'other-home');
  fs.mkdirSync(home);
  fs.mkdirSync(other);
  await expectRefusal(fx, { env: { ...fx.env, HOME: other }, deps: { home } }, /HOME/);
  assert.equal((await dryRun(fx, { env: { ...fx.env, HOME: home }, deps: { home } })).code, 0);
  fs.symlinkSync(home, path.join(fx.base, 'home-link'));
  assert.equal((await dryRun(fx, { env: { ...fx.env, HOME: path.join(fx.base, 'home-link') }, deps: { home } })).code, 0, 'a link that resolves to the same home is fine');
}));
t('dod4-own-mailbox: a parent directory of two mailboxes without a ledger of its own', () => withFixture({}, async fx => {
  const parent = path.join(fx.base, 'both');
  fs.mkdirSync(parent);
  fs.renameSync(fx.mailbox, path.join(parent, 'run'));
  const ticket = path.join(parent, 'run', 'S2', path.basename(fx.ticket));
  const second = path.join(parent, 'run2', 'orchestrator');
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(second, 'tickets.json'), '{"tickets":[]}');
  const before = listing(fx.base);
  const result = await fx.run({ set: { '--mailbox': parent, '--ticket': ticket }, drop: ['--export', '--manifest', '--manifest-sha256'], add: [['--no-export']] });
  assert.equal(result.code, 2);
  assert.equal(result.stderr, `refused: ${parent} is not a run mailbox (no orchestrator/tickets.json)\n`);
  assert.deepEqual(listing(fx.base), before);
}));
t('dod4-own-mailbox: a parent that has its own ledger and holds another mailbox', () => withFixture({}, async fx => {
  const nested = path.join(fx.mailbox, 'run-b', 'orchestrator');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'tickets.json'), '{"tickets":[]}');
  await expectRefusal(fx, {}, new RegExp('^refused: the mailbox path contains another mailbox at run-b/orchestrator$'));
}));
t('dod4-own-mailbox: a nested mailbox inside a scratch folder, at any depth', () => withFixture({}, async fx => {
  const nested = path.join(fx.mailbox, 'S1', 'scratch-other', 'copy', 'deep', 'orchestrator');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'tickets.json'), '{}');
  await expectRefusal(fx, {}, /^refused: the mailbox path contains another mailbox at S1\/scratch-other\/copy\/deep\/orchestrator$/);
  const result = await dryRun(fx, { add: [['--exclude', 'S1/scratch-other']] });
  assert.equal(result.code, 2, 'the search runs before excludes are applied');
  assert.match(result.stderr, /another mailbox/);
}));
t('dod4-own-mailbox: an export that contains orchestrator/tickets.json, outside and inside the mailbox', () => withFixture({}, async fx => {
  const dir = fx.export('code').dir;
  fs.chmodSync(dir, 0o755);
  fs.mkdirSync(path.join(dir, 'orchestrator'));
  fs.writeFileSync(path.join(dir, 'orchestrator', 'tickets.json'), '{}');
  await expectRefusal(fx, {}, /another mailbox/);
  await withFixture({ exports: [{ role: 'code', place: 'inside' }] }, async inside => {
    const exportDir = inside.export('code').dir;
    fs.chmodSync(exportDir, 0o755);
    fs.mkdirSync(path.join(exportDir, 'orchestrator'));
    fs.writeFileSync(path.join(exportDir, 'orchestrator', 'tickets.json'), '{}');
    await expectRefusal(inside, {}, /another mailbox/);
  });
}));
t('dod4-own-mailbox: an orchestrator directory without tickets.json is not another mailbox, and a correct mailbox is accepted', () => withFixture({}, async fx => {
  fs.mkdirSync(path.join(fx.mailbox, 'S1', 'orchestrator'));
  fs.writeFileSync(path.join(fx.mailbox, 'S1', 'orchestrator', 'notes.md'), 'x');
  assert.equal((await dryRun(fx, {})).code, 0);
}));
t('dod4-own-mailbox: the mailbox must hold a regular file orchestrator/tickets.json (not a link, not a directory)', () => withFixture({}, async fx => {
  const ledger = fx.ledger;
  const copy = path.join(fx.base, 'ledger-copy.json');
  fs.renameSync(ledger, copy);
  fs.symlinkSync(copy, ledger);
  await expectRefusal(fx, {}, /is not a run mailbox/);
  fs.rmSync(ledger);
  fs.mkdirSync(ledger);
  await expectRefusal(fx, {}, /is not a run mailbox/);
}));

t('dod2-home: a .git entry in an ancestor of the mailbox is allowed; one in the source itself is refused (rule 5)', () => withFixture({}, async fx => {
  fs.mkdirSync(path.join(fx.base, '.git'));
  assert.equal((await dryRun(fx, {})).code, 0, 'an ancestor with .git');
  fs.mkdirSync(path.join(fx.mailbox, '.GIT'));
  await expectRefusal(fx, {}, /\.git/i);
}));

t('dod2-paths rule 1: the input kinds are checked (a directory as the ticket, a file as the mailbox, the export or the staging directory)', () => withFixture({}, async fx => {
  const asDirectory = path.join(fx.stage, 'ticket-dir-r1.md');
  fs.mkdirSync(asDirectory);
  await expectRefusal(fx, { set: { '--ticket': asDirectory } }, /--ticket/);
  await expectRefusal(fx, { set: { '--mailbox': fx.ticket } }, /--mailbox/);
  await expectRefusal(fx, { set: { '--staging-dir': fx.ticket } }, /--staging-dir/);
  await expectRefusal(fx, { set: { '--reviewer-skill': fx.ticket } }, /--reviewer-skill/);
  await expectRefusal(fx, { set: { '--export': `code=${fx.ticket}` } }, /--export/);
  await expectRefusal(fx, { set: { '--manifest': `code=${fx.stage}` } }, /--manifest/);
}));

t('dod2-home: the account home is the real path of the password database home directory', () => {
  assert.equal(attempt(() => resolveHome({}, {})), fs.realpathSync(os.userInfo().homedir));
  assert.equal(attempt(() => resolveHome({}, { home: '/syn/given-home' })), '/syn/given-home');
});
t('dod4-own-mailbox: an orchestrator entry that is a file is not a mailbox ledger', () => withFixture({}, async fx => {
  fs.rmSync(path.join(fx.mailbox, 'orchestrator'), { recursive: true });
  fs.writeFileSync(path.join(fx.mailbox, 'orchestrator'), 'not a directory');
  await expectRefusal(fx, {}, /is not a run mailbox/);
}));

// An orchestrator directory that the search finds but cannot read is a refusal of A2.7.2 (the search did not complete), not an internal error.
// G11: root bypasses directory permissions, so the cases cannot run as root and are reported as skipped with that reason.
const tUnlessRoot = (name, fn, timeout = 30000) => nodeTest(name, { timeout, skip: process.getuid?.() === 0 ? 'running as root: directory permissions are not enforced, so the directory stays readable' : false }, fn);
// expectRefusal lists the fixture, and the listing cannot enter a directory that is unreadable, so this variant lists it while the
// directory is readable (before the run and again after it) and checks that the run left the directory unreadable.
const expectRefusalWhileUnreadable = async (fx, directory, pattern) => {
  fs.mkdirSync(directory, { recursive: true });
  const before = listing(fx.base);
  fs.chmodSync(directory, 0o000);
  try {
    const result = await fx.run({});
    assert.equal(result.code, 2, `expected a refusal, got ${result.code}: ${result.stdout} ${result.stderr}`);
    const lines = result.stderr.trimEnd().split('\n');
    assert.equal(lines.length, 1, `one line on standard error: ${JSON.stringify(result.stderr)}`);
    assert.match(lines[0], pattern);
    assert.match(lastLine(result.stdout), /^ACODER LAUNCH (-|[A-Za-z0-9._-]+) refused -$/);
    assert.ok(!result.stderr.includes(fx.key) && !result.stdout.includes(fx.key), 'the key is in no message');
    assert.equal((fs.lstatSync(directory).mode & 0o7777), 0o000, 'the run did not change the mode of the directory');
  } finally { fs.chmodSync(directory, 0o755); }
  assert.deepEqual(listing(fx.base), before, 'a refusal has no effect');
};
tUnlessRoot('dod4-own-mailbox: an orchestrator directory the search cannot read is a refusal, not an internal error', () => withFixture({}, async fx => {
  await expectRefusalWhileUnreadable(fx, path.join(fx.mailbox, 'locked', 'orchestrator'), /^refused: cannot read locked\/orchestrator while searching for another mailbox$/);
}));
tUnlessRoot('dod4-own-mailbox: an orchestrator directory the search cannot read inside an export outside the mailbox is a refusal', () => withFixture({}, async fx => {
  const dir = fx.export('code').dir;
  fs.chmodSync(dir, 0o755);
  await expectRefusalWhileUnreadable(fx, path.join(dir, 'orchestrator'), /^refused: cannot read export-code\/orchestrator while searching for another mailbox$/);
}));
tUnlessRoot('dod4-own-mailbox: an orchestrator directory the search cannot read inside an export inside the mailbox is a refusal', () => withFixture({ exports: [{ role: 'code', place: 'inside' }] }, async fx => {
  const dir = fx.export('code').dir;
  fs.chmodSync(dir, 0o755);
  await expectRefusalWhileUnreadable(fx, path.join(dir, 'orchestrator'), /^refused: cannot read .*orchestrator while searching for another mailbox$/);
}));
tUnlessRoot('dod4-own-mailbox: an own orchestrator directory whose content cannot be searched is a refusal, not an internal error', () => withFixture({}, async fx => {
  const directory = path.join(fx.mailbox, 'orchestrator');
  const before = listing(fx.base);
  fs.chmodSync(directory, 0o000);
  try {
    const result = await fx.run({});
    assert.equal(result.code, 2, `expected a refusal, got ${result.code}: ${result.stdout} ${result.stderr}`);
    const lines = result.stderr.trimEnd().split('\n');
    assert.equal(lines.length, 1, `one line on standard error: ${JSON.stringify(result.stderr)}`);
    assert.match(lines[0], /^refused: cannot read .*orchestrator while checking the run mailbox$/);
    assert.match(lastLine(result.stdout), /^ACODER LAUNCH (-|[A-Za-z0-9._-]+) refused -$/);
    assert.ok(!result.stderr.includes(fx.key) && !result.stdout.includes(fx.key), 'the key is in no message');
    assert.equal((fs.lstatSync(directory).mode & 0o7777), 0o000, 'the run did not change the mode of the directory');
  } finally { fs.chmodSync(directory, 0o755); }
  assert.deepEqual(listing(fx.base), before, 'a refusal has no effect');
}));
