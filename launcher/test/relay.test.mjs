import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import nodeTest from 'node:test';
import { RELAY_HOST, RELAY_PORT, startRelay } from '../container/relay.mjs';
import { fixtureBase, forceRemove, mustAsync } from './helpers/fixtures.mjs';

// G11: every test has a finite time limit of its own and is registered from this file.
const t = (name, fn, timeout = 30000) => nodeTest(name, { timeout }, fn);

// A3.1.4: the relay listens on 127.0.0.1:8080 and copies the bytes of each connection to the request socket and back; it parses nothing.
async function withEcho(fn) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fixtureBase(), 'arl-')));
  const socketPath = path.join(base, 's');
  const received = [];
  const server = net.createServer(connection => {
    const chunks = [];
    received.push(chunks);
    connection.on('data', chunk => { chunks.push(chunk); connection.write(chunk); });
    connection.on('end', () => connection.end());
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  let relay = null;
  try {
    relay = await mustAsync(() => startRelay({ port: 0, socketPath }));
    return await fn({ relay, received, socketPath, server });
  } finally {
    await relay?.close?.();
    await new Promise(resolve => server.close(resolve));
    forceRemove(base);
  }
}

// The answer of one connection, or null when the relay could not be reached.
const exchange = (port, payload) => new Promise(resolve => {
  const socket = net.connect(port, '127.0.0.1');
  const chunks = [];
  const timer = setTimeout(() => { socket.destroy(); resolve(Buffer.concat(chunks)); }, 3000);
  socket.on('connect', () => socket.end(payload));
  socket.on('data', chunk => chunks.push(chunk));
  socket.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
  socket.on('error', () => { clearTimeout(timer); resolve(null); });
});

t('relay: the production address is 127.0.0.1:8080', () => {
  assert.equal(RELAY_HOST, '127.0.0.1');
  assert.equal(RELAY_PORT, 8080);
});

t('relay: arbitrary bytes (not HTTP, with NUL and high bytes) reach the socket unchanged and the answer comes back unchanged', async () => {
  await withEcho(async ({ relay, received }) => {
    const payload = Buffer.concat([randomBytes(4096), Buffer.from('\0\r\nGET / HTTP/9.9\r\n\r\n')]);
    const answer = await exchange(relay.port, payload);
    assert.ok(answer !== null && answer.equals(payload), 'the answer came back unchanged');
    assert.ok(received.length === 1 && Buffer.concat(received[0]).equals(payload), 'the socket received exactly the bytes');
  });
});

t('relay: each connection gets its own socket connection; it listens on the loopback address only', async () => {
  await withEcho(async ({ relay, received }) => {
    const answers = await Promise.all([exchange(relay.port, 'one'), exchange(relay.port, 'two'), exchange(relay.port, 'three')]);
    assert.deepEqual(answers.map(answer => String(answer)).sort(), ['one', 'three', 'two']);
    assert.equal(received.length, 3);
    assert.equal(relay.address, '127.0.0.1');
  });
});

t('relay: when the request socket cannot be reached the client connection is closed, and the relay keeps serving', async () => {
  await withEcho(async ({ socketPath, server }) => {
    const missing = await mustAsync(() => startRelay({ port: 0, socketPath: `${socketPath}-absent` }));
    try {
      const answer = await exchange(missing.port, 'hello');
      assert.equal(answer?.length, 0, 'the relay accepted and closed the connection');
      const again = await exchange(missing.port, 'again');
      assert.equal(again?.length, 0);
    } finally { await missing.close(); }
    assert.ok(server.listening);
  });
});
