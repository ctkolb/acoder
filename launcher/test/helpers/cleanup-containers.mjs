// `npm run test:container:cleanup` (A11, K1.3): removes every container, volume and network whose label key is `acoder.test`, and prints
// what it removed and what remained. Without a runtime there is nothing to remove.
import { listLabelled, removeLabelled, testRuntime, TEST_LABEL_KEY } from './container-env.mjs';

if (testRuntime() === null) {
  process.stdout.write('no container runtime is installed; nothing to remove\n');
} else {
  const filter = `label=${TEST_LABEL_KEY}`;
  const before = await listLabelled(filter);
  const after = await removeLabelled(filter);
  const count = found => found.containers.length + found.volumes.length + found.networks.length;
  process.stdout.write(`removed ${count(before) - count(after)} labelled resources\n`);
  if (count(after) > 0) {
    process.stdout.write(`remaining: ${JSON.stringify(after)}\n`);
    process.exitCode = 1;
  }
}
