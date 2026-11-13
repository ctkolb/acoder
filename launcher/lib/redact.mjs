// Key forms, the stream redactor and the tree scan of A8.6. The scan never follows a link, never opens a special file and never
// writes into an existing inode: a content hit is replaced by exclusive creation of a new file and a rename over the name.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const REPLACEMENT = '[REDACTED]';
export const SCAN_BOUNDS = { maxBytes: 4294967296, maxEntries: 200000, maxDepth: 64, maxSeconds: 60, reportMaxBytes: 16777216 };
const MIN_KEY_LENGTH = 16;
const CHUNK = 65536;
const OPEN_READ = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const OPEN_CREATE = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;

// The characters of the base64 text of (offset bytes + key) that depend on the key bytes only: the group that mixes in the
// prefix and the last group, which holds padding bits, are left out (A8.6: all three byte alignments).
function base64Form(key, offset, encoding) {
  const text = Buffer.concat([Buffer.alloc(offset), key]).toString(encoding);
  return text.slice(Math.ceil((8 * offset) / 6), Math.floor((8 * (offset + key.length)) / 6));
}

export function keyForms(key) {
  if (typeof key !== 'string' || key.length < MIN_KEY_LENGTH) throw new Error('not a key');
  const bytes = Buffer.from(key);
  const hex = bytes.toString('hex');
  const percent = [...bytes].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('');
  const texts = {
    raw: key,
    'base64-0': base64Form(bytes, 0, 'base64'), 'base64-1': base64Form(bytes, 1, 'base64'), 'base64-2': base64Form(bytes, 2, 'base64'),
    'base64url-0': base64Form(bytes, 0, 'base64url'), 'base64url-1': base64Form(bytes, 1, 'base64url'), 'base64url-2': base64Form(bytes, 2, 'base64url'),
    'hex-lower': hex, 'hex-upper': hex.toUpperCase(), 'percent-upper': percent.toUpperCase(), 'percent-lower': percent,
  };
  return Object.entries(texts).map(([name, text]) => ({ name, bytes: Buffer.from(text, 'latin1') }));
}

export function createRedactor(key) {
  const forms = keyForms(key);
  // Forms with equal bytes (the two base64 alphabets agree on a key of [A-Za-z0-9_-]) are matched once, longest first.
  const patterns = [...new Map(forms.map(form => [form.bytes.toString('latin1'), form.bytes])).values()].sort((a, b) => b.length - a.length);
  const maxLength = patterns[0].length;
  const starts = new Set(patterns.map(pattern => pattern[0]));
  const replacement = Buffer.from(REPLACEMENT);
  const matchAt = (buffer, index) => {
    if (!starts.has(buffer[index])) return null;
    return patterns.find(pattern => buffer.length - index >= pattern.length && buffer.compare(pattern, 0, pattern.length, index, index + pattern.length) === 0) ?? null;
  };
  const containsKey = data => { const buffer = Buffer.from(data); return patterns.some(pattern => buffer.includes(pattern)); };

  // A stream redactor holds back the last (longest form - 1) bytes, so a form split across chunks is complete in the buffer.
  function stream() {
    let pending = Buffer.alloc(0);
    let count = 0;
    let ended = false;
    const run = (buffer, final) => {
      const limit = final ? buffer.length : buffer.length - (maxLength - 1);
      const out = [];
      let index = 0;
      let last = 0;
      while (index < limit) {
        const found = matchAt(buffer, index);
        if (found === null) { index += 1; continue; }
        out.push(buffer.subarray(last, index), replacement);
        count += 1;
        index += found.length;
        last = index;
      }
      out.push(buffer.subarray(last, index));
      pending = buffer.subarray(index);
      return Buffer.concat(out);
    };
    return {
      push(chunk) {
        if (ended) throw new Error('the stream has ended');
        return run(Buffer.concat([pending, Buffer.from(chunk)]), false);
      },
      end() {
        ended = true;
        return run(pending, true);
      },
      count: () => count,
    };
  }

  function redactString(text) {
    const piece = stream();
    const out = Buffer.concat([piece.push(text), piece.end()]);
    return { text: out.toString('utf8'), count: piece.count() };
  }

  return { forms, maxLength, containsKey, stream, redactString };
}

export function emptyScan(bounds = {}) {
  const limits = { ...SCAN_BOUNDS, ...bounds };
  return {
    status: 'not_run', files_scanned: 0, log_redactions: 0, redacted_files: [], redacted_names: 0, removed_links: 0, unresolved_redactions: [], special_entries: 0, bytes_read: 0, entries_seen: 0,
    max_bytes: limits.maxBytes, max_entries: limits.maxEntries, max_depth: limits.maxDepth, max_seconds: limits.maxSeconds, report_max_bytes: limits.reportMaxBytes,
  };
}

// scan: { key, scratch, files, bounds, ops, now }. `files` are the two reports and the log (absolute paths); an entry of `files` that does not exist is
// skipped. `ops` and `now` are test seams (the production run passes neither). Returns the secret_scan section of the record, the conditions
// that held (secret_found first, then secret_scan_incomplete) and the two flags.
export function scanTree({ key, scratch, files = [], bounds = {}, ops = {}, now = Date.now }) {
  const limits = { ...SCAN_BOUNDS, ...bounds };
  const io = {
    lstatSync: fs.lstatSync, readdirSync: fs.readdirSync, openSync: fs.openSync, fstatSync: fs.fstatSync, readSync: fs.readSync, writeSync: fs.writeSync, fsyncSync: fs.fsyncSync,
    fchmodSync: fs.fchmodSync, closeSync: fs.closeSync, readlinkSync: fs.readlinkSync, renameSync: fs.renameSync, unlinkSync: fs.unlinkSync, ...ops,
  };
  const redactor = createRedactor(key);
  const base = path.dirname(scratch);
  const started = now();
  const state = { found: false, incomplete: false, stop: false, scanned: 0, redactedFiles: [], redactedNames: 0, removedLinks: 0, unresolved: [], special: 0, bytes: 0, entries: 0, counter: 0 };
  const shown = full => redactor.redactString(path.relative(base, full)).text;
  const incomplete = () => { state.incomplete = true; };
  const unresolved = full => { state.unresolved.push(shown(full)); incomplete(); };
  const timeUp = () => {
    if ((now() - started) / 1000 <= limits.maxSeconds) return false;
    incomplete();
    state.stop = true;
    return true;
  };

  // Reads one regular file without following a link and looks for a key form, also across the boundary of two chunks.
  // Returns 'hit', 'clean' or 'failed' (the scan is then incomplete).
  function look(full, info, cap) {
    let input;
    try {
      input = io.openSync(full, OPEN_READ);
      const opened = io.fstatSync(input);
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) { incomplete(); return 'failed'; }
      if (cap !== null && opened.size > cap) { incomplete(); return 'failed'; }
      const buffer = Buffer.allocUnsafe(CHUNK);
      let carry = Buffer.alloc(0);
      for (;;) {
        const read = io.readSync(input, buffer, 0, buffer.length, null);
        if (read === 0) return 'clean';
        state.bytes += read;
        if (state.bytes > limits.maxBytes) { incomplete(); state.stop = true; return 'failed'; }
        const window = Buffer.concat([carry, buffer.subarray(0, read)]);
        if (redactor.containsKey(window)) return 'hit';
        carry = window.subarray(Math.max(0, window.length - (redactor.maxLength - 1)));
      }
    } catch {
      incomplete();
      return 'failed';
    } finally {
      if (input !== undefined) try { io.closeSync(input); } catch { incomplete(); }
    }
  }

  const writeAll = (fd, data) => {
    for (let offset = 0; offset < data.length;) offset += io.writeSync(fd, data, offset, data.length - offset);
  };

  // A8.6: a redacted copy is created exclusively next to the original and renamed over its name; the old inode is never written.
  function replace(full, info) {
    const temp = path.join(path.dirname(full), `.acoder-redact-${randomBytes(6).toString('hex')}.tmp`);
    let output;
    try {
      const input = io.openSync(full, OPEN_READ);
      try {
        const opened = io.fstatSync(input);
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) return false;
        output = io.openSync(temp, OPEN_CREATE, opened.mode & 0o777);
        io.fchmodSync(output, opened.mode & 0o777);
        const piece = redactor.stream();
        const buffer = Buffer.allocUnsafe(CHUNK);
        for (;;) {
          const read = io.readSync(input, buffer, 0, buffer.length, null);
          if (read === 0) break;
          writeAll(output, piece.push(buffer.subarray(0, read)));
        }
        writeAll(output, piece.end());
        io.fsyncSync(output);
      } finally { io.closeSync(input); }
      io.closeSync(output);
      output = undefined;
      io.renameSync(temp, full);
      return true;
    } catch {
      if (output !== undefined) try { io.closeSync(output); } catch { /* the copy is removed below */ }
      try { io.unlinkSync(temp); } catch { /* it may not exist */ }
      return false;
    }
  }

  function regular(full, info, cap) {
    state.scanned += 1;
    if (look(full, info, cap) !== 'hit') return;
    state.found = true;
    if (!replace(full, info)) { unresolved(full); return; }
    let again;
    try { again = io.lstatSync(full); } catch { unresolved(full); return; }
    if (look(full, again, cap) !== 'clean') { unresolved(full); return; }
    state.redactedFiles.push(shown(full));
  }

  function renameName(full, directory) {
    state.found = true;
    for (;;) {
      state.counter += 1;
      const candidate = path.join(directory, `redacted-name-${state.counter}`);
      try { io.lstatSync(candidate); } catch (error) {
        if (error?.code !== 'ENOENT') { unresolved(full); return null; }
        try { io.renameSync(full, candidate); } catch { unresolved(full); return null; }
        state.redactedNames += 1;
        return candidate;
      }
    }
  }

  function walk(directory, depth) {
    let names;
    try { names = io.readdirSync(directory).sort(); } catch { incomplete(); return; }
    if (depth + 1 > limits.maxDepth && names.length > 0) { incomplete(); return; }
    for (const name of names) {
      if (state.stop || timeUp()) return;
      state.entries += 1;
      if (state.entries > limits.maxEntries) { incomplete(); state.stop = true; return; }
      let full = path.join(directory, name);
      let info;
      try { info = io.lstatSync(full); } catch (error) {
        if (error?.code !== 'ENOENT') incomplete();
        continue;
      }
      if (redactor.containsKey(name)) {
        const renamed = renameName(full, directory);
        if (renamed !== null) {
          full = renamed;
          try { info = io.lstatSync(full); } catch { incomplete(); continue; }
        }
      }
      if (info.isSymbolicLink()) {
        let target;
        try { target = io.readlinkSync(full); } catch { incomplete(); continue; }
        if (!redactor.containsKey(target)) continue;
        state.found = true;
        try { io.unlinkSync(full); state.removedLinks += 1; } catch { unresolved(full); }
      } else if (info.isDirectory()) walk(full, depth + 1);
      else if (info.isFile()) regular(full, info, null);
      else state.special += 1;
    }
  }

  walk(scratch, 0);
  for (const file of files) {
    if (state.stop || timeUp()) break;
    let info;
    try { info = io.lstatSync(file); } catch (error) {
      if (error?.code !== 'ENOENT') incomplete();
      continue;
    }
    if (!info.isFile()) { incomplete(); continue; }
    regular(file, info, file.endsWith('.json') ? limits.reportMaxBytes : null);
  }
  timeUp();

  const status = state.incomplete ? 'incomplete' : state.found ? 'found' : 'clean';
  return {
    found: state.found, incomplete: state.incomplete, status,
    conditions: [...(state.found ? ['secret_found'] : []), ...(state.incomplete ? ['secret_scan_incomplete'] : [])],
    secret_scan: {
      ...emptyScan(bounds), status, files_scanned: state.scanned, redacted_files: state.redactedFiles, redacted_names: state.redactedNames, removed_links: state.removedLinks,
      unresolved_redactions: state.unresolved, special_entries: state.special, bytes_read: state.bytes, entries_seen: state.entries,
    },
  };
}
