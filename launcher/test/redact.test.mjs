import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import nodeTest from 'node:test';
import { buildRecord, validateRecord, writeRecord } from '../lib/record.mjs';
import { REPLACEMENT, createRedactor, emptyScan, keyForms, scanTree } from '../lib/redact.mjs';
import { must, thrownOf, withFixture } from './helpers/fixtures.mjs';
import { embedBase64, expectedForms, syntheticKey } from './helpers/key-forms.mjs';
import { recordValues } from './helpers/record-values.mjs';

// G11: every test has a finite time limit of its own. The test is registered from this file, so that the mutation runner can count it per module.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, async (...args) => {
  // A failure that is not an assertion (a TypeError from a broken module) is reported as an assertion failure.
  try { return await fn(...args); } catch (error) { if (error?.code === 'ERR_ASSERTION') throw error; assert.fail(`threw: ${String(error?.message ?? error)}`); }
});

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const FORM_NAMES = ['raw', 'base64-0', 'base64-1', 'base64-2', 'base64url-0', 'base64url-1', 'base64url-2', 'hex-lower', 'hex-upper', 'percent-upper', 'percent-lower'];
const BOUNDS = { maxBytes: 4294967296, maxEntries: 200000, maxDepth: 64, maxSeconds: 60, reportMaxBytes: 16777216 };

const collect = (redactor, chunks) => {
  const stream = redactor.stream();
  const parts = chunks.map(chunk => stream.push(chunk));
  parts.push(stream.end());
  return { output: Buffer.concat(parts.map(part => Buffer.from(part))), count: stream.count(), parts };
};

// Everything under a directory: names, link targets and file contents as text, for "no key form is left anywhere".
function everything(root) {
  const lines = [];
  const walk = directory => {
    for (const name of fs.readdirSync(directory)) {
      const full = path.join(directory, name);
      const info = fs.lstatSync(full);
      lines.push(`name:${name}`);
      if (info.isDirectory()) walk(full);
      else if (info.isSymbolicLink()) lines.push(`target:${fs.readlinkSync(full)}`);
      else if (info.isFile()) lines.push(`content:${fs.readFileSync(full).toString('latin1')}`);
    }
  };
  walk(root);
  return lines.join('\n');
}
const holdsAnyForm = (text, key) => Object.values(expectedForms(key)).some(form => text.includes(form));
const scan = (fx, over = {}) => must(() => scanTree({ key: fx.key, scratch: fx.writable.scratch, files: [fx.writable.reportMd, fx.writable.reportJson], ...over }));
const makeScratch = fx => { fs.mkdirSync(fx.writable.scratch); return fx.writable.scratch; };
// Every descriptor the scan opens is closed on every path: the tracker holds the descriptors that are still open.
function tracker() {
  const open = new Set();
  return {
    open,
    ops: { openSync: (file, flags, mode) => { const fd = fs.openSync(file, flags, mode); open.add(fd); return fd; }, closeSync: fd => { open.delete(fd); return fs.closeSync(fd); } },
  };
}

t('dod8-redact: the key forms are exactly those of A8.6 (raw, base64 and base64url in three alignments, hex in two cases, percent-encoded)', () => {
  const key = syntheticKey();
  const forms = must(() => keyForms(key));
  assert.deepEqual(forms.map(form => form.name), FORM_NAMES);
  const oracle = expectedForms(key);
  for (const form of forms) assert.equal(Buffer.from(form.bytes).toString('latin1'), oracle[form.name], form.name);
  assert.equal(REPLACEMENT, '[REDACTED]');
  // The oracle itself is checked against real encodings of texts that hold the key at every byte alignment.
  for (const offset of [0, 1, 2]) for (const urlSafe of [false, true]) {
    for (let trial = 0; trial < 10; trial += 1) assert.ok(embedBase64(key, offset, urlSafe).includes(oracle[`${urlSafe ? 'base64url' : 'base64'}-${offset}`]), `${urlSafe} ${offset}`);
  }
  assert.ok(thrownOf(() => createRedactor('')) !== null, 'an empty key cannot be redacted');
  assert.ok(thrownOf(() => createRedactor('short')) !== null, 'a key shorter than 16 characters is not a key');
  assert.equal(thrownOf(() => createRedactor('a'.repeat(16))), null, 'a key of 16 characters is a key');
  assert.ok(thrownOf(() => createRedactor('a'.repeat(15))) !== null, '15 characters are not');
  assert.ok(thrownOf(() => createRedactor(7)) !== null && thrownOf(() => createRedactor(undefined)) !== null);
  assert.ok(thrownOf(() => createRedactor(Buffer.from('a'.repeat(20)))) !== null, 'a key is text');
});

t('dod8-redact: every key form in a text is replaced, in a string and in a stream, and other text is unchanged', () => {
  const key = syntheticKey();
  const redactor = must(() => createRedactor(key));
  const oracle = expectedForms(key);
  for (const name of FORM_NAMES) {
    const text = `before ${oracle[name]} after`;
    const result = must(() => redactor.redactString(text));
    assert.deepEqual(result, { text: 'before [REDACTED] after', count: 1 }, name);
    assert.equal(redactor.containsKey(text), true, name);
    assert.equal(redactor.containsKey(Buffer.from(text)), true, `${name} (buffer)`);
    const streamed = collect(redactor, [text]);
    assert.equal(streamed.output.toString(), 'before [REDACTED] after', name);
    assert.equal(streamed.count, 1);
  }
  for (const offset of [0, 1, 2]) for (const urlSafe of [false, true]) {
    const embedded = embedBase64(key, offset, urlSafe);
    const redacted = must(() => redactor.redactString(`x${embedded}y`));
    assert.equal(redacted.count, 1, `embedded at ${offset} (${urlSafe})`);
    assert.ok(redacted.text.includes('[REDACTED]') && !holdsAnyForm(redacted.text, key));
  }
  const plain = 'no key here, only text: 0123456789abcdef and %41%42 and base64 QUJDREVGRw==';
  assert.deepEqual(must(() => redactor.redactString(plain)), { text: plain, count: 0 });
  assert.equal(redactor.containsKey(plain), false);
  assert.equal(redactor.containsKey(key.slice(0, -1)), false, 'a prefix of the key is not the key');
  assert.deepEqual(must(() => redactor.redactString(`${key}${key} ${oracle['hex-lower']}-${key}`)), { text: '[REDACTED][REDACTED] [REDACTED]-[REDACTED]', count: 4 });
  assert.deepEqual(must(() => redactor.redactString('')), { text: '', count: 0 });
});

t('dod8-redact: a key split across two chunks is replaced at every split position of every form', () => {
  const key = syntheticKey();
  const redactor = must(() => createRedactor(key));
  const oracle = expectedForms(key);
  for (const name of FORM_NAMES) {
    const text = `lead-${oracle[name]}-trail`;
    for (let cut = 0; cut <= text.length; cut += 1) {
      const { output, count } = collect(redactor, [text.slice(0, cut), text.slice(cut)]);
      assert.equal(output.toString(), 'lead-[REDACTED]-trail', `${name} split at ${cut}`);
      assert.equal(count, 1, `${name} split at ${cut}`);
    }
  }
  const text = `a${key}b${oracle['base64-1']}c`;
  for (let first = 1; first < text.length; first += 7) for (let second = first + 1; second < text.length; second += 11) {
    const { output, count } = collect(redactor, [text.slice(0, first), text.slice(first, second), text.slice(second)]);
    assert.equal(output.toString(), 'a[REDACTED]b[REDACTED]c', `three chunks ${first} ${second}`);
    assert.equal(count, 2);
  }
  const bytewise = collect(redactor, [...Buffer.from(`x${oracle['percent-upper']}y${key}z`)].map(byte => Buffer.from([byte])));
  assert.equal(bytewise.output.toString(), 'x[REDACTED]y[REDACTED]z');
  assert.equal(bytewise.count, 2);
  // Held-back bytes are released at the end, a stream of plain text is not delayed beyond the hold-back, and the output never holds a key form.
  const plain = collect(redactor, ['abc', 'def']);
  assert.equal(plain.output.toString(), 'abcdef');
  assert.equal(plain.parts.at(-1).length > 0 || plain.parts.some(part => part.length > 0), true);
  const early = redactor.stream();
  assert.equal(Buffer.from(early.push(`${'a'.repeat(300)}`)).length > 0, true, 'text far from the end is passed on without waiting for the end');
});

t('dod8-redact: the stream passes arbitrary bytes through unchanged, and text and Buffer chunks mix', () => {
  const key = syntheticKey();
  const redactor = must(() => createRedactor(key));
  const binary = Buffer.from([0xff, 0x00, 0xfe, 0x80, 0x0a, 0xc3]);
  const { output, count } = collect(redactor, [binary, Buffer.from(key), binary, `${key}`]);
  assert.deepEqual(output, Buffer.concat([binary, Buffer.from('[REDACTED]'), binary, Buffer.from('[REDACTED]')]));
  assert.equal(count, 2);
  assert.deepEqual(collect(redactor, []).output, Buffer.alloc(0));
  const stream = redactor.stream();
  stream.push('x');
  stream.end();
  assert.ok(thrownOf(() => stream.push('y')) !== null, 'a stream that has ended takes no more data');
});

t('dod8-redact: the four scan status values and the precedence of a found key over an incomplete scan', () => withFixture({ noExport: true }, async fx => {
  const none = must(() => emptyScan());
  assert.equal(none.status, 'not_run');
  assert.deepEqual(none, {
    status: 'not_run', files_scanned: 0, log_redactions: 0, redacted_files: [], redacted_names: 0, removed_links: 0, unresolved_redactions: [], special_entries: 0, bytes_read: 0,
    entries_seen: 0, max_bytes: 4294967296, max_entries: 200000, max_depth: 64, max_seconds: 60, report_max_bytes: 16777216,
  });
  const scratch = makeScratch(fx);
  fs.writeFileSync(path.join(scratch, 'a.txt'), 'nothing');
  const clean = scan(fx);
  assert.equal(clean.secret_scan.status, 'clean');
  assert.deepEqual(clean.conditions, []);
  assert.equal(clean.found, false);
  assert.equal(clean.incomplete, false);
  fs.writeFileSync(path.join(scratch, 'b.txt'), `has ${fx.key}`);
  const found = scan(fx);
  assert.equal(found.secret_scan.status, 'found');
  assert.deepEqual(found.conditions, ['secret_found']);
  assert.equal(found.found, true);
  fs.writeFileSync(path.join(scratch, 'a2.txt'), `again ${fx.key}`);
  const incomplete = scan(fx, { bounds: { ...BOUNDS, maxEntries: 1 } });
  assert.equal(incomplete.secret_scan.status, 'incomplete');
  assert.equal(incomplete.incomplete, true);
  const hitAndIncomplete = scan(fx, { bounds: { ...BOUNDS, maxEntries: 2 } });
  assert.equal(hitAndIncomplete.secret_scan.status, 'incomplete', 'incomplete with or without a hit');
  assert.equal(hitAndIncomplete.found, true);
  assert.deepEqual(hitAndIncomplete.conditions, ['secret_found', 'secret_scan_incomplete'], 'secret_found first, then secret_scan_incomplete');
  assert.equal(emptyScan().status, 'not_run');
  // Every status is a valid record value and every scan result is a valid secret_scan section.
  for (const result of [clean, found, incomplete, hitAndIncomplete]) {
    const values = recordValues({ secret_scan: result.secret_scan });
    values.inputs = { ...values.inputs, scratch_git_entries_complete: result.secret_scan.status !== 'incomplete' };
    assert.deepEqual(validateRecord(must(() => buildRecord(values))), []);
  }
}));

t('dod8-redact: the tree scan finds the key in contents, names and link targets in every form, and leaves no form behind', () => withFixture({ noExport: true }, async fx => {
  const scratch = makeScratch(fx);
  const oracle = expectedForms(fx.key);
  fs.mkdirSync(path.join(scratch, 'deep', 'er'), { recursive: true });
  fs.writeFileSync(fx.writable.reportMd, `report ${oracle['base64url-2']} end`);
  fs.writeFileSync(fx.writable.reportJson, JSON.stringify({ session: fx.tag }));
  for (const name of FORM_NAMES) {
    fs.writeFileSync(path.join(scratch, 'deep', 'er', `content-${name}.txt`), `pre ${oracle[name]} post`);
    fs.writeFileSync(path.join(scratch, `plain-${name}`), 'harmless');
    fs.symlinkSync(`../target-${oracle[name]}`, path.join(scratch, 'deep', `link-${name}`));
    if (!oracle[name].includes('/')) fs.writeFileSync(path.join(scratch, `n-${oracle[name]}`), 'name hit');
  }
  // On a case-insensitive file system the upper-case and lower-case forms name one file, and the two base64 alphabets give one text.
  const nameHits = fs.readdirSync(scratch).filter(name => name.startsWith('n-')).length;
  assert.ok(nameHits >= 6, `${nameHits} distinct name files`);
  const result = scan(fx);
  const report = result.secret_scan;
  assert.equal(report.status, 'found');
  assert.deepEqual(result.conditions, ['secret_found']);
  assert.equal(report.redacted_names, nameHits);
  assert.equal(report.removed_links, FORM_NAMES.length);
  assert.equal(report.redacted_files.length, FORM_NAMES.length + 1, 'every content hit is listed: one file per form and the report');
  assert.deepEqual(report.unresolved_redactions, []);
  assert.ok(report.files_scanned >= FORM_NAMES.length * 2 + 2);
  assert.ok(report.bytes_read > 0 && report.entries_seen >= FORM_NAMES.length * 3);
  for (const listed of [...report.redacted_files, ...report.unresolved_redactions]) assert.ok(!holdsAnyForm(listed, fx.key), 'the recorded paths hold no key');
  assert.ok(!holdsAnyForm(everything(scratch), fx.key), 'no form of the key is left in scratch');
  assert.ok(!holdsAnyForm(fs.readFileSync(fx.writable.reportMd, 'latin1'), fx.key), 'the report is redacted');
  assert.equal(fs.readFileSync(fx.writable.reportMd, 'utf8'), 'report [REDACTED] end');
  assert.equal(fs.readFileSync(path.join(scratch, 'deep', 'er', 'content-hex-lower.txt'), 'utf8'), 'pre [REDACTED] post');
  assert.ok(fs.readdirSync(scratch).some(name => /^redacted-name-\d+$/.test(name)), 'a name hit is renamed to redacted-name-<n>');
  assert.equal(fs.readdirSync(path.join(scratch, 'deep')).filter(name => name.startsWith('link-')).length, 0, 'a link whose target holds the key is removed');
  assert.deepEqual(fs.readdirSync(scratch).filter(name => name.startsWith('.acoder-')), [], 'no temporary file is left');
  const again = scan(fx);
  assert.equal(again.secret_scan.status, 'clean', 'a second scan finds nothing');
}));

t('dod8-redact: a directory with a key in its name is renamed before it is entered, and a link is never followed', () => withFixture({ noExport: true }, async fx => {
  const scratch = makeScratch(fx);
  const outside = path.join(fx.base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), `outside ${fx.key}`);
  fs.symlinkSync(outside, path.join(scratch, 'to-outside'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(scratch, 'to-file'));
  fs.mkdirSync(path.join(scratch, `dir-${fx.key}`));
  fs.writeFileSync(path.join(scratch, `dir-${fx.key}`, 'inner.txt'), `inner ${fx.key}`);
  const result = scan(fx);
  assert.equal(result.secret_scan.status, 'found');
  assert.equal(result.secret_scan.redacted_names, 1);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), `outside ${fx.key}`, 'the target of a link is never opened or changed');
  const renamed = fs.readdirSync(scratch).find(name => name.startsWith('redacted-name-'));
  assert.equal(fs.readFileSync(path.join(scratch, renamed, 'inner.txt'), 'utf8'), 'inner [REDACTED]', 'the renamed directory was entered');
  assert.equal(fs.lstatSync(path.join(scratch, 'to-outside')).isSymbolicLink(), true, 'a link whose target path has no key stays');
  assert.equal(result.secret_scan.removed_links, 0);
  assert.equal(result.secret_scan.redacted_names, 1);
  assert.ok(result.secret_scan.entries_seen >= 4);
  // The numbers of redacted-name-<n> do not collide with names that exist.
  fs.writeFileSync(path.join(scratch, `again-${fx.key}`), 'x');
  fs.writeFileSync(path.join(scratch, `third-${fx.key}`), 'x');
  const second = scan(fx);
  assert.equal(second.secret_scan.redacted_names, 2);
  const names = fs.readdirSync(scratch).filter(name => name.startsWith('redacted-name-'));
  assert.equal(new Set(names).size, 3);
}));

t('spec01-scan-rename: a file with two names is replaced under each name by a new file; a sentinel outside scratch is untouched', () => withFixture({ noExport: true }, async fx => {
  const scratch = makeScratch(fx);
  const original = path.join(scratch, 'one.txt');
  fs.writeFileSync(original, `shared ${fx.key} content`);
  fs.linkSync(original, path.join(scratch, 'two.txt'));
  fs.mkdirSync(path.join(scratch, 'sub'));
  fs.linkSync(original, path.join(scratch, 'sub', 'three.txt'));
  const sentinel = path.join(fx.base, 'sentinel.txt');
  fs.writeFileSync(sentinel, `sentinel ${fx.key} bytes`);
  const sentinelBefore = fs.statSync(sentinel);
  const sharedIno = fs.statSync(original).ino;
  assert.equal(fs.statSync(original).nlink, 3);
  const result = scan(fx);
  assert.equal(result.secret_scan.status, 'found');
  const names = ['one.txt', 'two.txt', 'sub/three.txt'];
  const inodes = new Set();
  for (const name of names) {
    const info = fs.statSync(path.join(scratch, name));
    assert.equal(fs.readFileSync(path.join(scratch, name), 'utf8'), 'shared [REDACTED] content', `${name} is redacted`);
    assert.equal(info.nlink, 1, `${name} has one name`);
    assert.notEqual(info.ino, sharedIno, `${name} is a new inode`);
    inodes.add(info.ino);
  }
  assert.equal(inodes.size, 3, 'each name has its own new inode');
  assert.deepEqual(result.secret_scan.redacted_files.length, 3);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), `sentinel ${fx.key} bytes`, 'the sentinel bytes are unchanged');
  const sentinelAfter = fs.statSync(sentinel);
  assert.equal(sentinelAfter.ino, sentinelBefore.ino);
  assert.equal(sentinelAfter.mtimeMs, sentinelBefore.mtimeMs);
  // A hard link between scratch and a file outside is never written through either.
  const twin = path.join(fx.base, 'twin.txt');
  fs.writeFileSync(twin, `twin ${fx.key}`);
  fs.linkSync(twin, path.join(scratch, 'twin-link.txt'));
  const second = scan(fx);
  assert.equal(second.secret_scan.status, 'found');
  assert.equal(fs.readFileSync(twin, 'utf8'), `twin ${fx.key}`, 'the other name of the inode keeps its bytes');
  assert.equal(fs.readFileSync(path.join(scratch, 'twin-link.txt'), 'utf8'), 'twin [REDACTED]');
  // The mode of the replaced file is the mode of the original.
  fs.writeFileSync(path.join(scratch, 'mode.txt'), `m ${fx.key}`);
  fs.chmodSync(path.join(scratch, 'mode.txt'), 0o664);
  scan(fx);
  assert.equal(fs.statSync(path.join(scratch, 'mode.txt')).mode & 0o777, 0o664, 'the mode of the original, whatever the umask');
}));

t('spec01-scan-rename: the replacement is made by exclusive creation of a new file and a rename, never by writing the existing inode', () => withFixture({ noExport: true }, async fx => {
  const scratch = makeScratch(fx);
  const target = path.join(scratch, 'f.txt');
  fs.writeFileSync(target, `x ${fx.key} y`);
  const calls = [];
  const tracked = tracker();
  const ops = {
    openSync: (file, flags, mode) => { calls.push({ op: 'open', file, flags, mode }); return tracked.ops.openSync(file, flags, mode); },
    closeSync: tracked.ops.closeSync,
    fsyncSync: fd => { calls.push({ op: 'fsync' }); return fs.fsyncSync(fd); },
    renameSync: (from, to) => { calls.push({ op: 'rename', from, to }); return fs.renameSync(from, to); },
  };
  const result = scan(fx, { ops });
  assert.equal(tracked.open.size, 0, 'every descriptor is closed');
  assert.deepEqual(calls.filter(call => call.op === 'fsync' || call.op === 'rename').map(call => call.op), ['fsync', 'rename'], 'the new file is flushed before it replaces the name');
  assert.equal(result.secret_scan.status, 'found');
  const creates = calls.filter(call => call.op === 'open' && (call.flags & fs.constants.O_CREAT) !== 0);
  assert.equal(creates.length, 1);
  assert.ok((creates[0].flags & fs.constants.O_EXCL) !== 0, 'the new file is created exclusively');
  assert.equal(path.dirname(creates[0].file), scratch, 'in the same directory');
  const writes = calls.filter(call => call.op === 'open' && ((call.flags & fs.constants.O_WRONLY) !== 0 || (call.flags & fs.constants.O_RDWR) !== 0));
  assert.deepEqual(writes.map(call => call.file), [creates[0].file], 'only the new file is ever opened for writing');
  const renames = calls.filter(call => call.op === 'rename');
  assert.deepEqual(renames, [{ op: 'rename', from: creates[0].file, to: target }]);
  for (const call of calls.filter(entry => entry.op === 'open' && (entry.flags & fs.constants.O_CREAT) === 0)) assert.ok((call.flags & fs.constants.O_NOFOLLOW) !== 0, `${call.file} is opened with no-follow`);
}));

t('r5-readback: every entry is lstat-ed first, a FIFO and a socket are never opened, and a copy that still holds the key is not accepted', () => withFixture({ noExport: true }, async fx => {
  const scratch = makeScratch(fx);
  const fifo = path.join(scratch, 'pipe');
  const made = spawnSync('mkfifo', [fifo]);
  assert.equal(made.status, 0, 'mkfifo is available');
  const socketPath = path.join(scratch, 'sock');
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  try {
    fs.writeFileSync(path.join(scratch, 'plain.txt'), 'plain');
    fs.writeFileSync(path.join(scratch, 'hit.txt'), `k ${fx.key}`);
    const calls = [];
    const lstatted = new Set();
    const ops = {
      lstatSync: (file, ...rest) => { calls.push(['lstat', file]); lstatted.add(file); return fs.lstatSync(file, ...rest); },
      openSync: (file, flags, mode) => { calls.push(['open', file]); assert.ok(lstatted.has(file) || file.includes('.acoder-'), `${file} was lstat-ed before it was opened`); return fs.openSync(file, flags, mode); },
    };
    const result = scan(fx, { ops });
    assert.equal(result.secret_scan.special_entries, 2, 'the FIFO and the socket are counted');
    assert.equal(calls.some(([op, file]) => op === 'open' && (file === fifo || file === socketPath)), false, 'a FIFO or a socket is never opened');
    assert.equal(result.secret_scan.status, 'found');
    assert.equal(fs.readFileSync(path.join(scratch, 'hit.txt'), 'utf8'), 'k [REDACTED]');
    assert.equal(fs.lstatSync(fifo).isFIFO(), true);
    // A special entry whose name holds the key is still renamed (rename opens nothing).
    fs.renameSync(fifo, path.join(scratch, `pipe-${fx.key}`));
    const second = scan(fx);
    assert.equal(second.secret_scan.redacted_names, 1);
    assert.equal(second.secret_scan.special_entries, 2);
    assert.equal(second.secret_scan.status, 'found');
  } finally { await new Promise(resolve => server.close(resolve)); }
  // Readback: a copy that still holds the key (the writer is broken) is unresolved and the scan is incomplete; the original is kept.
  fs.writeFileSync(path.join(scratch, 'again.txt'), `z ${fx.key}`);
  const broken = scan(fx, { ops: { writeSync: (fd, data, offset, length) => { fs.writeSync(fd, Buffer.from(Buffer.from(data.subarray(offset, offset + length)).toString('latin1').replaceAll('[REDACTED]', fx.key), 'latin1')); return length; } } });
  assert.equal(broken.secret_scan.status, 'incomplete');
  assert.deepEqual(broken.conditions, ['secret_found', 'secret_scan_incomplete']);
  assert.equal(broken.secret_scan.unresolved_redactions.length, 1);
  assert.ok(broken.secret_scan.unresolved_redactions[0].endsWith('again.txt'));
}));

t('r5-readback: an unreadable directory, an oversize report or file, a depth, entry, byte or time bound and a changed file end secret_scan_incomplete with a record that can be written', () => withFixture({ noExport: true }, async fx => {
  const scratch = makeScratch(fx);
  fs.writeFileSync(fx.writable.reportMd, 'md');
  fs.writeFileSync(fx.writable.reportJson, JSON.stringify({ session: fx.tag, pad: 'x'.repeat(200) }));
  const expectIncomplete = (result, label) => {
    assert.equal(result.secret_scan.status, 'incomplete', label);
    assert.deepEqual(result.conditions, ['secret_scan_incomplete'], label);
    assert.equal(result.incomplete, true, label);
    assert.equal(result.found, false, label);
  };
  expectIncomplete(scan(fx, { bounds: { ...BOUNDS, reportMaxBytes: 100 } }), 'a report JSON over its bound');
  fs.writeFileSync(path.join(scratch, 'big.bin'), Buffer.alloc(5000, 97));
  expectIncomplete(scan(fx, { bounds: { ...BOUNDS, maxBytes: 1000 } }), 'more bytes than the total bound');
  fs.mkdirSync(path.join(scratch, 'a', 'b', 'c'), { recursive: true });
  expectIncomplete(scan(fx, { bounds: { ...BOUNDS, maxDepth: 2 } }), 'deeper than the depth bound');
  assert.equal(scan(fx, { bounds: { ...BOUNDS, maxDepth: 3 } }).secret_scan.status, 'clean', 'exactly at the depth bound is complete');
  expectIncomplete(scan(fx, { bounds: { ...BOUNDS, maxEntries: 3 } }), 'more entries than the bound');
  let clock = 0;
  const slow = { openSync: (...args) => { clock += 40000; return fs.openSync(...args); } };
  expectIncomplete(scan(fx, { bounds: { ...BOUNDS, maxSeconds: 60 }, now: () => clock, ops: slow }), 'more seconds than the bound');
  assert.equal(scan(fx, { bounds: { ...BOUNDS, maxSeconds: 60 }, now: () => 0 }).secret_scan.status, 'clean');
  const changed = { fstatSync: fd => { const info = fs.fstatSync(fd); return { ...info, isFile: () => info.isFile(), ino: info.ino + 1, dev: info.dev }; } };
  expectIncomplete(scan(fx, { ops: changed }), 'a file that is not the one that was lstat-ed');
  const failing = { readSync: () => { throw Object.assign(new Error('boom'), { code: 'EIO' }); } };
  expectIncomplete(scan(fx, { ops: failing }), 'a read error');
  if (!IS_ROOT) {
    fs.mkdirSync(path.join(scratch, 'locked'));
    fs.chmodSync(path.join(scratch, 'locked'), 0o000);
    try {
      const result = scan(fx, { bounds: BOUNDS });
      expectIncomplete(result, 'an unreadable directory');
      // The final record is still written, with the scan result and the incomplete Git count.
      const values = recordValues({ secret_scan: result.secret_scan, conditions: result.conditions, exit_reason: 'error', error_detail: 'secret_scan_incomplete' });
      values.inputs = { ...values.inputs, scratch_git_entries_complete: false };
      const target = path.join(fx.stage, 'run-t.json');
      must(() => writeRecord(target, buildRecord(values), createRedactor(fx.key)));
      assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).secret_scan.status, 'incomplete');
    } finally { fs.chmodSync(path.join(scratch, 'locked'), 0o755); }
  }
  // A vanished entry (ENOENT after the listing) is skipped; the scan stays complete.
  fs.writeFileSync(path.join(scratch, 'gone.txt'), 'x');
  const vanish = { lstatSync: (file, ...rest) => { if (file.endsWith('gone.txt')) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return fs.lstatSync(file, ...rest); } };
  assert.equal(scan(fx, { ops: vanish }).secret_scan.status, 'clean');
}));

t('r5-readback: a tree of 200001 entries ends secret_scan_incomplete (injected file system; the entries are special files and are never opened)', () => withFixture({ noExport: true }, async fx => {
  const scratch = makeScratch(fx);
  const names = Array.from({ length: 200001 }, (_, index) => `e${index}`);
  const fifoInfo = { isDirectory: () => false, isFile: () => false, isSymbolicLink: () => false, isFIFO: () => true, isSocket: () => false, mode: 0o10600, size: 0, ino: 1, dev: 1 };
  const opened = [];
  const ops = {
    readdirSync: directory => (directory === scratch ? names : fs.readdirSync(directory)),
    lstatSync: (file, ...rest) => (path.dirname(file) === scratch && /\/e\d+$/.test(file) ? fifoInfo : fs.lstatSync(file, ...rest)),
    openSync: (file, ...rest) => { opened.push(file); return fs.openSync(file, ...rest); },
  };
  const result = scan(fx, { ops });
  assert.equal(result.secret_scan.status, 'incomplete');
  assert.deepEqual(result.conditions, ['secret_scan_incomplete']);
  assert.equal(result.secret_scan.max_entries, 200000);
  assert.ok(result.secret_scan.entries_seen >= 200000);
  assert.equal(opened.some(file => /\/e\d+$/.test(file)), false);
  const exact = scan(fx, { ops: { ...ops, readdirSync: directory => (directory === scratch ? names.slice(0, 200000) : fs.readdirSync(directory)) } });
  assert.equal(exact.secret_scan.status, 'clean', '200000 entries are within the bound');
  assert.equal(exact.secret_scan.special_entries, 200000);
}));

t('spec03-metadata: a key in a name or a link target in an unwritable directory keeps secret_found, adds secret_scan_incomplete and names the unresolved path (redacted)', () => withFixture({ noExport: true }, async fx => {
  const scratch = makeScratch(fx);
  const locked = path.join(scratch, 'locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, `name-${fx.key}`), 'harmless');
  fs.symlinkSync(`target-${fx.key}`, path.join(locked, 'link'));
  const inject = (kind, result) => {
    assert.equal(result.secret_scan.status, 'incomplete', kind);
    assert.deepEqual(result.conditions, ['secret_found', 'secret_scan_incomplete'], kind);
    assert.equal(result.found, true, kind);
    assert.equal(result.incomplete, true, kind);
    assert.ok(result.secret_scan.unresolved_redactions.length >= 1, kind);
    for (const unresolved of result.secret_scan.unresolved_redactions) assert.ok(!holdsAnyForm(unresolved, fx.key), `${kind}: the unresolved path is redacted`);
    assert.ok(result.secret_scan.unresolved_redactions.some(unresolved => unresolved.includes('[REDACTED]')), kind);
  };
  if (!IS_ROOT) {
    fs.chmodSync(locked, 0o555);
    try {
      const result = scan(fx);
      inject('unwritable directory', result);
      assert.ok(result.secret_scan.unresolved_redactions.length === 2, 'the name and the link are both unresolved');
      assert.equal(result.secret_scan.redacted_names, 0);
      assert.equal(result.secret_scan.removed_links, 0);
      assert.equal(fs.lstatSync(path.join(locked, `name-${fx.key}`)).isFile(), true, 'nothing is claimed cleaned');
    } finally { fs.chmodSync(locked, 0o755); }
  }
  const failing = { renameSync: () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); }, unlinkSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } };
  inject('injected rename and unlink failure', scan(fx, { ops: failing }));
  // With a working directory the same tree is resolved: the name is renamed, the link removed.
  const resolved = scan(fx);
  assert.equal(resolved.secret_scan.status, 'found');
  assert.deepEqual(resolved.conditions, ['secret_found']);
  assert.equal(resolved.secret_scan.redacted_names, 1);
  assert.equal(resolved.secret_scan.removed_links, 1);
}));

t('scan-content-unwritable: a content hit in an unwritable directory, and an injected replacement or rename failure, keep secret_found, add secret_scan_incomplete and leave the original', () => withFixture({ noExport: true }, async fx => {
  const scratch = makeScratch(fx);
  const locked = path.join(scratch, 'locked');
  fs.mkdirSync(locked);
  const file = path.join(locked, 'content.txt');
  fs.writeFileSync(file, `data ${fx.key}`);
  const check = (kind, result) => {
    assert.equal(result.secret_scan.status, 'incomplete', kind);
    assert.deepEqual(result.conditions, ['secret_found', 'secret_scan_incomplete'], kind);
    assert.equal(result.secret_scan.unresolved_redactions.length, 1, kind);
    assert.ok(result.secret_scan.unresolved_redactions[0].endsWith('locked/content.txt'), kind);
    assert.deepEqual(result.secret_scan.redacted_files, [], `${kind}: nothing is claimed redacted`);
    assert.equal(fs.readFileSync(file, 'utf8'), `data ${fx.key}`, `${kind}: the original is untouched`);
    assert.deepEqual(fs.readdirSync(locked), ['content.txt'], `${kind}: no temporary file is left`);
  };
  if (!IS_ROOT) {
    fs.chmodSync(locked, 0o555);
    try { check('unwritable directory', scan(fx)); } finally { fs.chmodSync(locked, 0o755); }
  }
  check('rename failure', scan(fx, { ops: { renameSync: () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); } } }));
  check('creation failure', scan(fx, { ops: { openSync: (target, flags, mode) => { if ((flags & fs.constants.O_CREAT) !== 0) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return fs.openSync(target, flags, mode); } } }));
  check('write failure', scan(fx, { ops: { writeSync: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } } }));
  // The final record is written with the result.
  const result = scan(fx, { ops: { renameSync: () => { throw new Error('EXDEV'); } } });
  const values = recordValues({ secret_scan: result.secret_scan, conditions: result.conditions, exit_reason: 'error', error_detail: 'secret_found' });
  values.inputs = { ...values.inputs, scratch_git_entries_complete: false };
  const target = path.join(fx.stage, 'run-t.json');
  must(() => writeRecord(target, buildRecord(values), createRedactor(fx.key)));
  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(written.secret_scan.status, 'incomplete');
  assert.deepEqual(written.conditions, ['secret_found', 'secret_scan_incomplete']);
  assert.equal(written.error_detail, 'secret_found');
  assert.ok(!holdsAnyForm(fs.readFileSync(target, 'latin1'), fx.key));
}));

t('dod8-redact: the scan covers the two reports and the log as files, scratch entries by relative path, and records counts', () => withFixture({ noExport: true }, async fx => {
  const scratch = makeScratch(fx);
  const log = path.join(fx.stage, 'run-t.log');
  fs.writeFileSync(fx.writable.reportMd, `md ${fx.key}`);
  fs.writeFileSync(fx.writable.reportJson, `{"a":"${fx.key}"}`);
  fs.writeFileSync(log, `log ${fx.key}\n`);
  fs.writeFileSync(path.join(scratch, 'in.txt'), `in ${fx.key}`);
  const result = scan(fx, { files: [fx.writable.reportMd, fx.writable.reportJson, log] });
  assert.equal(result.secret_scan.status, 'found');
  assert.equal(result.secret_scan.files_scanned, 4);
  assert.equal(result.secret_scan.redacted_files.length, 4);
  assert.ok(result.secret_scan.redacted_files.includes('scratch-fx-S2-r1/in.txt'), JSON.stringify(result.secret_scan.redacted_files));
  assert.ok(result.secret_scan.redacted_files.includes('report-fx-S2-r1.md'));
  assert.ok(result.secret_scan.redacted_files.includes('run-t.log'));
  assert.equal(fs.readFileSync(log, 'utf8'), 'log [REDACTED]\n');
  assert.equal(fs.readFileSync(fx.writable.reportJson, 'utf8'), '{"a":"[REDACTED]"}');
  const bytes = fs.readFileSync(fx.writable.reportMd).length;
  assert.ok(result.secret_scan.bytes_read >= bytes);
  assert.equal(result.secret_scan.max_bytes, 4294967296);
  assert.equal(result.secret_scan.report_max_bytes, 16777216);
  // A missing report is not a hit and not an error of the scan: the absent file is skipped (the report checks of A6.5 report it).
  fs.rmSync(fx.writable.reportMd);
  assert.equal(scan(fx, { files: [fx.writable.reportMd] }).secret_scan.status, 'clean');
  // A report that is a link is never followed.
  const outside = path.join(fx.base, 'outside.txt');
  fs.writeFileSync(outside, `o ${fx.key}`);
  fs.symlinkSync(outside, fx.writable.reportMd);
  const linked = scan(fx, { files: [fx.writable.reportMd] });
  assert.equal(linked.secret_scan.status, 'incomplete', 'a report that is a link cannot be scanned');
  assert.equal(fs.readFileSync(outside, 'utf8'), `o ${fx.key}`);
}));

t('r5-readback: the bounds are exact: an elapsed time, a byte total and a report size equal to the bound are complete, one more is not', () => withFixture({ noExport: true }, async fx => {
  const scratch = makeScratch(fx);
  const clockAt = elapsed => { let calls = 0; return () => (calls++ === 0 ? 0 : elapsed); };
  fs.writeFileSync(path.join(scratch, 'a.txt'), 'a'.repeat(1500));
  assert.equal(scan(fx, { now: clockAt(60000) }).secret_scan.status, 'clean', 'exactly 60 s');
  assert.equal(scan(fx, { now: clockAt(60001) }).secret_scan.status, 'incomplete', 'more than 60 s');
  assert.equal(scan(fx, { bounds: { ...BOUNDS, maxSeconds: 5 }, now: clockAt(5000) }).secret_scan.status, 'clean', 'the bound is a parameter');
  assert.equal(scan(fx, { bounds: { ...BOUNDS, maxBytes: 1500 } }).secret_scan.status, 'clean', 'exactly the byte bound');
  assert.equal(scan(fx, { bounds: { ...BOUNDS, maxBytes: 1499 } }).secret_scan.status, 'incomplete', 'one byte more');
  fs.writeFileSync(fx.writable.reportJson, 'j'.repeat(100));
  assert.equal(scan(fx, { bounds: { ...BOUNDS, reportMaxBytes: 100 } }).secret_scan.status, 'clean', 'a report of exactly the bound');
  assert.equal(scan(fx, { bounds: { ...BOUNDS, reportMaxBytes: 99 } }).secret_scan.status, 'incomplete', 'one byte over');
  fs.writeFileSync(fx.writable.reportMd, 'm'.repeat(5000));
  assert.equal(scan(fx, { bounds: { ...BOUNDS, reportMaxBytes: 99 }, files: [fx.writable.reportMd] }).secret_scan.status, 'clean', 'the report bound is for the JSON report, not for the Markdown report');
  assert.equal(scan(fx).secret_scan.max_seconds, 60);
  const reported = scan(fx, { bounds: { maxSeconds: 7, maxDepth: 3, maxEntries: 9, maxBytes: 99999, reportMaxBytes: 1234 } }).secret_scan;
  assert.deepEqual([reported.max_seconds, reported.max_depth, reported.max_entries, reported.max_bytes, reported.report_max_bytes], [7, 3, 9, 99999, 1234], 'the bounds are recorded');
}));

t('r5-readback: entries are scanned in name order, whatever order the file system lists them in; an unreadable entry does not stop the others', () => withFixture({ noExport: true }, async fx => {
  const scratch = makeScratch(fx);
  fs.writeFileSync(path.join(scratch, 'a1.txt'), `hit ${fx.key}`);
  fs.writeFileSync(path.join(scratch, 'b1.txt'), 'clean');
  fs.writeFileSync(path.join(scratch, 'c1.txt'), 'third');
  const reversed = { readdirSync: directory => fs.readdirSync(directory).sort().reverse() };
  const result = scan(fx, { ops: reversed, bounds: { ...BOUNDS, maxEntries: 1 } });
  assert.equal(result.found, true, 'a1.txt is the first entry in name order');
  assert.deepEqual(result.conditions, ['secret_found', 'secret_scan_incomplete']);
  assert.equal(result.secret_scan.entries_seen, 2, 'the scan stops at the first entry beyond the bound');
  // A read error on one file leaves the scan going: the other file is still found and redacted.
  fs.writeFileSync(path.join(scratch, 'a0.txt'), 'broken');
  const failOne = { readSync: (fd, ...rest) => { if (fs.fstatSync(fd).size === 6) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return fs.readSync(fd, ...rest); } };
  fs.writeFileSync(path.join(scratch, 'c1.txt'), `again ${fx.key}`);
  const second = scan(fx, { ops: failOne });
  assert.equal(second.secret_scan.status, 'incomplete');
  assert.deepEqual(second.conditions, ['secret_found', 'secret_scan_incomplete']);
  assert.equal(fs.readFileSync(path.join(scratch, 'c1.txt'), 'utf8'), 'again [REDACTED]');
}));

t('scan-content-unwritable: every descriptor is closed on every failure path of the replacement', () => withFixture({ noExport: true }, async fx => {
  const scratch = makeScratch(fx);
  fs.writeFileSync(path.join(scratch, 'f.txt'), `data ${fx.key}`);
  for (const [label, failing] of [
    ['write failure', { writeSync: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } }],
    ['rename failure', { renameSync: () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); } }],
    ['fsync failure', { fsyncSync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } }],
    ['mode failure', { fchmodSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } }],
    ['read failure', { readSync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } }],
  ]) {
    const tracked = tracker();
    const result = scan(fx, { ops: { ...tracked.ops, ...failing } });
    assert.equal(result.secret_scan.status, 'incomplete', label);
    assert.equal(tracked.open.size, 0, `${label}: no descriptor is left open`);
    assert.deepEqual(fs.readdirSync(scratch), ['f.txt'], `${label}: no temporary file is left`);
  }
  const tracked = tracker();
  assert.equal(scan(fx, { ops: tracked.ops }).secret_scan.status, 'found');
  assert.equal(tracked.open.size, 0, 'no descriptor is left open after a success either');
}));

t('dod8-redact: a key form that straddles the read boundary of the scan is found at every split position', () => withFixture({ noExport: true }, async fx => {
  const scratch = makeScratch(fx);
  const oracle = expectedForms(fx.key);
  const READ = 65536;
  for (const name of ['raw', 'hex-lower', 'percent-upper', 'base64-1']) {
    const form = oracle[name];
    for (let before = 1; before < form.length; before += 1) {
      const file = path.join(scratch, 'big.bin');
      fs.writeFileSync(file, `${'a'.repeat(READ - before)}${form}${'b'.repeat(40)}`);
      const result = scan(fx);
      assert.equal(result.secret_scan.status, 'found', `${name}: ${before} bytes before the boundary`);
      assert.equal(fs.readFileSync(file, 'utf8'), `${'a'.repeat(READ - before)}[REDACTED]${'b'.repeat(40)}`, `${name} at ${before}`);
    }
  }
}), 60000);

t('spec03-metadata: a link whose target holds the key alone is secret_found; an unreadable link and a file that changes between the read and the replacement make the scan incomplete', () => withFixture({ noExport: true }, async fx => {
  const scratch = makeScratch(fx);
  fs.symlinkSync(`target-${fx.key}`, path.join(scratch, 'only-link'));
  const found = scan(fx);
  assert.equal(found.secret_scan.status, 'found');
  assert.deepEqual(found.conditions, ['secret_found']);
  assert.equal(found.secret_scan.removed_links, 1);
  fs.symlinkSync('harmless', path.join(scratch, 'plain-link'));
  const unreadable = scan(fx, { ops: { readlinkSync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } } });
  assert.equal(unreadable.secret_scan.status, 'incomplete');
  assert.deepEqual(unreadable.conditions, ['secret_scan_incomplete']);
  fs.writeFileSync(path.join(scratch, 'f.txt'), `x ${fx.key}`);
  let calls = 0;
  const swapped = scan(fx, { ops: { fstatSync: fd => { calls += 1; const info = fs.fstatSync(fd); return calls === 2 ? { ...info, ino: info.ino + 1, isFile: () => true } : info; } } });
  assert.equal(swapped.secret_scan.status, 'incomplete', 'the identity of the file is checked again before the replacement');
  assert.deepEqual(swapped.conditions, ['secret_found', 'secret_scan_incomplete']);
  assert.equal(fs.readFileSync(path.join(scratch, 'f.txt'), 'utf8'), `x ${fx.key}`, 'nothing was replaced');
  assert.equal(swapped.secret_scan.unresolved_redactions.length, 1);
  // The redacted-name numbers have the form of A8.6.
  fs.writeFileSync(path.join(scratch, `n-${fx.key}`), 'x');
  scan(fx);
  assert.ok(fs.readdirSync(scratch).some(name => /^redacted-name-1$/.test(name)));
}));

t('r5-readback: after a bound stopped the scan no other directory is entered', () => withFixture({ noExport: true }, async fx => {
  const scratch = makeScratch(fx);
  fs.mkdirSync(path.join(scratch, 'd1'));
  fs.mkdirSync(path.join(scratch, 'd2'));
  for (const name of ['f1', 'f2']) fs.writeFileSync(path.join(scratch, 'd1', name), 'x');
  fs.writeFileSync(path.join(scratch, 'd2', 'g1'), `hit ${fx.key}`);
  const result = scan(fx, { bounds: { ...BOUNDS, maxEntries: 2 } });
  assert.equal(result.secret_scan.status, 'incomplete');
  assert.equal(result.secret_scan.entries_seen, 3, 'd1, d1/f1 and the entry that crossed the bound');
  assert.equal(result.found, false, 'd2 is not entered after the stop');
  assert.equal(fs.readFileSync(path.join(scratch, 'd2', 'g1'), 'utf8'), `hit ${fx.key}`);
}));
