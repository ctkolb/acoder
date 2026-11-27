// Runs the sidecar's main() as its own process for the start-up tests: the configuration and socket paths of the test, and an upstream
// connect seam that reaches the stub endpoint on the loopback address (every TLS option, including verification, stays the sidecar's).
// Argument: one JSON object {configPath, socketPath, stubPort, caPath}.
import fs from 'node:fs';
import tls from 'node:tls';
import { main } from '../../container/proxy.mjs';

const { configPath, socketPath, stubPort, caPath } = JSON.parse(process.argv[2]);
const ca = [...tls.rootCertificates, fs.readFileSync(caPath, 'utf8')];
main({ configPath, socketPath, deps: { connect: options => tls.connect({ ...options, host: '127.0.0.1', port: stubPort }), ca } });
