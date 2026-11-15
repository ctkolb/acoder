// The loopback relay (red-commit placeholder; the implementation follows).
export const RELAY_HOST = '';
export const RELAY_PORT = 0;
export async function startRelay() { return { port: 0, address: '', close: async () => {} }; }
