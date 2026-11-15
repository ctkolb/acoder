// The relay of the agent container (A3.1.4): it listens on 127.0.0.1:8080 and copies the bytes of each connection to the request socket
// and back. It parses nothing; the sidecar treats every byte it receives as untrusted. It imports only `node:` modules.
import net from 'node:net';

export const RELAY_HOST = '127.0.0.1';
export const RELAY_PORT = 8080;
export const SOCKET_PATH = '/run/acoder-egress/egress.sock';

// Resolves {port, address, close()} once it listens. port 0 (tests) takes a free port.
export function startRelay({ port = RELAY_PORT, socketPath = SOCKET_PATH } = {}) {
  const open = new Set();
  // Half-open connections are kept: a client that ends its side still gets the whole answer.
  const server = net.createServer({ allowHalfOpen: true }, client => {
    const upstream = net.connect({ path: socketPath, allowHalfOpen: true });
    open.add(client);
    open.add(upstream);
    client.on('error', () => { client.destroy(); upstream.destroy(); });
    upstream.on('error', () => { upstream.destroy(); client.end(); });
    client.on('close', () => { open.delete(client); upstream.destroy(); });
    upstream.on('close', () => { open.delete(upstream); client.end(); });
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, RELAY_HOST, () => {
      server.off('error', reject);
      const address = server.address();
      resolve({
        port: address.port, address: address.address,
        close: () => new Promise(done => { for (const socket of open) socket.destroy(); server.close(() => done()); }),
      });
    });
  });
}
