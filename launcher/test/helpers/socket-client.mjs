// A client of the sidecar's Unix socket: one HTTP request through `node:http`, or raw bytes through `node:net` for requests that
// `node:http` would not send (bad framing, HTTP/1.0 and 0.9, pipelining). Each call has its own time limit.
import http from 'node:http';
import net from 'node:net';

// The answer {status, headers, rawHeaders, body}, or {error} when the connection failed before an answer.
export function request(socketPath, { method = 'POST', path = '/v1/responses', headers = {}, body = null, timeoutMs = 10000 } = {}) {
  return new Promise(resolve => {
    const req = http.request({ socketPath, method, path, headers: { host: 'models.test', ...headers }, agent: false, setHost: false });
    const timer = setTimeout(() => { req.destroy(new Error('client timeout')); }, timeoutMs);
    req.on('response', res => {
      const parts = [];
      res.on('data', chunk => parts.push(chunk));
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(parts) }); });
      res.on('error', error => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(parts), error: error.code ?? error.message }); });
    });
    req.on('error', error => { clearTimeout(timer); resolve({ error: error.code ?? error.message }); });
    if (body !== null) req.write(body);
    req.end();
  });
}

// One request whose answer is read as it arrives: {chunks, text(), status(), done, abort()}. `done` resolves with {status, complete, error}
// when the answer ended, the connection closed or `timeoutMs` passed; abort() closes the connection from the client side.
export function streaming(socketPath, { method = 'POST', path = '/v1/responses', headers = {}, body = '{}', timeoutMs = 10000 } = {}) {
  const chunks = [];
  let status = null;
  let req;
  const done = new Promise(resolve => {
    req = http.request({ socketPath, method, path, headers: { host: 'models.test', ...headers }, agent: false, setHost: false });
    const timer = setTimeout(() => { req.destroy(new Error('client timeout')); }, timeoutMs);
    const finish = result => { clearTimeout(timer); resolve(result); };
    req.on('response', res => {
      status = res.statusCode;
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => finish({ status, complete: true, error: null }));
      res.on('error', error => finish({ status, complete: false, error: error.code ?? error.message }));
      res.on('close', () => finish({ status, complete: res.complete, error: null }));
    });
    req.on('error', error => finish({ status, complete: false, error: error.code ?? error.message }));
    req.end(body);
  });
  return { chunks, text: () => Buffer.concat(chunks).toString('latin1'), status: () => status, done, abort: () => req.destroy() };
}

// The error code of a JSON answer of the sidecar, or null.
export const errorCode = answer => {
  try { return JSON.parse(answer.body.toString('utf8')).error.code; } catch { return null; }
};

// Writes `text` to the socket and returns everything that comes back until the server closes or `waitMs` passes.
export function raw(socketPath, text, { waitMs = 1500 } = {}) {
  return new Promise(resolve => {
    const socket = net.connect(socketPath);
    const parts = [];
    const finish = () => { clearTimeout(timer); socket.destroy(); resolve(Buffer.concat(parts).toString('latin1')); };
    const timer = setTimeout(finish, waitMs);
    socket.on('data', chunk => parts.push(chunk));
    socket.on('close', finish);
    socket.on('error', finish);
    socket.write(text);
  });
}

// The status codes of the answers in a raw response text (several for pipelining: an answer follows the previous body directly).
export const rawStatuses = text => [...text.matchAll(/HTTP\/1\.[01] (\d{3}) [A-Z]/g)].map(match => Number(match[1]));
