// An independent implementation of the canonical tree hash of A9, written from the sheet's text (not lib/record.mjs), so that a test can
// compare the record's payload and skill hashes with its own: every entry under the root (the root itself as the empty path), sorted by the
// bytes of its relative UTF-8 path, contributes a type byte (F, D, L), four ASCII octal permission digits (0000 for a link), the path length
// as u64 big-endian, the path, the content length as u64 big-endian and the content (empty for a directory, the link target for a link).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function u64(value) {
  const out = Buffer.alloc(8);
  let rest = BigInt(value);
  for (let index = 7; index >= 0; index -= 1) { out[index] = Number(rest & 0xffn); rest >>= 8n; }
  return out;
}

export function treeHash(root) {
  const rows = [];
  const visit = (full, relative) => {
    const info = fs.lstatSync(full);
    const name = Buffer.from(relative, 'utf8');
    if (info.isSymbolicLink()) { rows.push([name, 'L', '0000', Buffer.from(fs.readlinkSync(full), 'utf8')]); return; }
    const mode = (info.mode & 0o777).toString(8).padStart(4, '0');
    if (info.isFile()) { rows.push([name, 'F', mode, fs.readFileSync(full)]); return; }
    assert(info.isDirectory(), `not a file, directory or link: ${relative}`);
    rows.push([name, 'D', mode, Buffer.alloc(0)]);
    for (const child of fs.readdirSync(full)) visit(path.join(full, child), relative === '' ? child : `${relative}/${child}`);
  };
  visit(root, '');
  rows.sort((a, b) => Buffer.compare(a[0], b[0]));
  const hash = createHash('sha256');
  for (const [name, type, mode, content] of rows) {
    hash.update(type, 'ascii');
    hash.update(mode, 'ascii');
    hash.update(u64(name.length));
    hash.update(name);
    hash.update(u64(content.length));
    hash.update(content);
  }
  return hash.digest('hex');
}

function assert(condition, message) { if (!condition) throw new Error(message); }
