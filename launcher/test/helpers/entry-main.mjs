// Runs the supervisor's main() as its own process for the unit tests (S4-AC6): the agent command file, the request socket and the relay
// port of the test, a release wait of the test's choice, and injected probes (no probe runs on the host: they would read the host's
// network and resolver). The injected probes connect once to the relay, so the test sees that it was started before them.
// Argument: one JSON object {agentCommand, socketPath, releaseWaitMs}.
import net from 'node:net';
import { main } from '../../container/entry.mjs';

const { agentCommand, socketPath, releaseWaitMs } = JSON.parse(process.argv[2]);
const probes = async (input, { relayPort }) => {
  const reached = await new Promise(resolve => {
    const socket = net.connect(relayPort, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
  return [{ id: 'P1', result: reached ? 'pass' : 'fail', detail: reached ? 'relay_listening' : 'relay_absent' }];
};
main({ paths: { agentCommand, socket: socketPath }, relayPort: 0, releaseWaitMs, probes });
