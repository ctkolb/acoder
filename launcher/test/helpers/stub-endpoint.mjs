// The stub model endpoint of the sidecar tests: an HTTPS server on the loopback address with certificates made by `openssl` at test time
// (a test CA, a leaf for the endpoint name, a leaf for another name and a self-signed leaf). It counts every connection and records
// every request (method, target, raw headers, body size) before the scenario answers it. It never contacts anything.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

export const ENDPOINT_HOST = 'models.test';
export const OTHER_HOST = 'other.test';

// G11: tests that need the stub certificates are skipped with this reason when `openssl` is absent.
export const OPENSSL_MISSING = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0 ? false : 'openssl is not available to make the stub endpoint certificate';

function openssl(dir, args) {
  const result = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr}`);
}

// Keys and certificates in `dir`: ca (PEM), and {key, cert} for good (signed for the endpoint name), other (signed for another name)
// and self (self-signed for the endpoint name).
export function makeCertificates(dir) {
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2'];
  openssl(dir, ['req', '-x509', ...ec, '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=acoder test ca', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign']);
  const leaf = (name, host, signed) => openssl(dir, [
    'req', '-x509', ...ec, '-keyout', `${name}.key`, '-out', `${name}.pem`, '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`, '-addext', 'basicConstraints=CA:FALSE',
    ...(signed ? ['-CA', 'ca.pem', '-CAkey', 'ca.key'] : []),
  ]);
  leaf('good', ENDPOINT_HOST, true);
  leaf('other', OTHER_HOST, true);
  leaf('self', ENDPOINT_HOST, false);
  const read = name => fs.readFileSync(path.join(dir, name), 'utf8');
  const pair = name => ({ key: read(`${name}.key`), cert: read(`${name}.pem`) });
  return { ca: read('ca.pem'), good: pair('good'), other: pair('other'), self: pair('self') };
}

// The default answer: a JSON body with usage and a model, as the Responses API prints it.
export const jsonAnswer = (res, { usage = { input_tokens: 11, output_tokens: 7 }, model = 'stub-model', headers = {} } = {}) => {
  const body = JSON.stringify({ id: 'resp_stub', model, usage });
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
};

// The text of an event stream: one `data:` line per event.
export const sseText = events => events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
// A comment line of an event stream that pads a chunk (the sidecar's body redactor holds back fewer bytes than this).
export const ssePad = (size = 2048) => `: ${'p'.repeat(size)}\n\n`;
// A gate a scenario waits on: open() lets it go on; wait(ms) resolves true when opened, false when `ms` passed first.
export function gate() {
  let open;
  let opened = false;
  const promise = new Promise(resolve => { open = () => { opened = true; resolve(true); }; });
  return { open: () => open(), opened: () => opened, wait: ms => Promise.race([promise, new Promise(resolve => { const timer = setTimeout(() => resolve(false), ms); promise.then(() => clearTimeout(timer)); })]) };
}

// scenario(req, res, record) answers a request after its body was read; it defaults to jsonAnswer.
export async function startStub({ tls, scenario = (req, res) => jsonAnswer(res) }) {
  const requests = [];
  // open: requests whose answer has not closed yet; maxOpen: the most that were open at once.
  const counts = { tcp: 0, tls: 0, open: 0, maxOpen: 0 };
  const sockets = new Set();
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const record = { method: req.method, url: req.url, rawHeaders: [...req.rawHeaders], bytes: 0 };
    requests.push(record);
    counts.open += 1;
    counts.maxOpen = Math.max(counts.maxOpen, counts.open);
    res.on('close', () => { counts.open -= 1; });
    req.on('data', chunk => { record.bytes += chunk.length; });
    req.on('end', () => scenario(req, res, record));
  });
  server.on('connection', socket => { counts.tcp += 1; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('secureConnection', () => { counts.tls += 1; });
  server.on('tlsClientError', () => {});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    port: server.address().port, requests, counts,
    // The headers of a recorded request as [lower-case name, value] pairs.
    headerPairs: record => record.rawHeaders.flatMap((value, index) => (index % 2 === 0 ? [[value.toLowerCase(), record.rawHeaders[index + 1]]] : [])),
    close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
  };
}
