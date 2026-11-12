// Production registries of agent adapters and provider profiles. Stage S2 part 1 only needs their names and which
// providers an adapter lists; part 2 replaces this file with launcher/adapters/index.mjs and launcher/providers/index.mjs.
export const adapters = { opencode: { name: 'opencode', providers: ['openai'] } };
export const providers = { openai: { name: 'openai' } };
