// The connection recorder: the sidecar's upstream connect seam in the tests. It records the host, port and TLS server name the sidecar
// asks for, then connects to the stub endpoint on the loopback address with every other option unchanged (so certificate
// verification is the sidecar's own). It never contacts any other address.
import tls from 'node:tls';

export function createRecorder(stubPort) {
  const connects = [];
  return {
    connects,
    connect(options) {
      connects.push({ host: options.host, port: options.port, servername: options.servername });
      return tls.connect({ ...options, host: '127.0.0.1', port: stubPort });
    },
  };
}
