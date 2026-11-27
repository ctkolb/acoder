// `npm run check:container` (A11, K1.3): prints NOT_CHECKED with the reason and exits 1 when the container tests cannot run, so a
// missing runtime or image is never reported as a pass.
import { containerSkipReason } from './container-env.mjs';

const reason = containerSkipReason();
if (reason !== false) {
  process.stdout.write(`NOT_CHECKED: ${reason}\n`);
  process.exitCode = 1;
}
