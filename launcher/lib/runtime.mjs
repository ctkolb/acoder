// The docker and podman command wrapper (red-commit placeholder; the implementation follows in the next commit).
export const RUN_LABEL_KEY = 'acoder.run';
export function findRuntime() { return { name: null, bin: null }; }
export function createRuntime() { return { call: async () => ({ code: null, stdout: '', stderr: '' }), answers: async () => ({}) }; }
