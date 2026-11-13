// The opencode agent adapter (A4, A5): all opencode-specific code.
const todo = () => { throw new Error('not implemented'); };

export const name = 'opencode';
export const versionArgv = ['opencode', '--version'];
export const providers = ['openai'];
export const command = todo;
export const createParser = todo;
export const outcome = todo;
