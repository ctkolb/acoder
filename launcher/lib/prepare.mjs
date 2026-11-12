// States V and S of A6.6 as far as this cut point has them: the path rules. The snapshot and its verification follow in cut point 3.
import { checkLaunchPaths } from './paths.mjs';

export function prepare(options, env, deps = {}) {
  const { writable } = checkLaunchPaths(options, env, deps);
  return { tag: writable.tag, writable, cleanup() {} };
}
