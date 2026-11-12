// Stub for the tests-only commit: every path that is not implemented ends as an internal error (exit code 1).
export async function main(argv, env, deps) {
  try {
    throw new Error('not implemented');
  } catch (error) {
    (deps.stderr ?? process.stderr).write(`error: ${error.message}\n`);
    return 1;
  }
}
