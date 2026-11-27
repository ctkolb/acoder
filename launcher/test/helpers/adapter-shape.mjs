// What A5 requires of an agent adapter and of a provider profile, as assertions: the stub, opencode and any later one must pass them.
import assert from 'node:assert/strict';

export function assertAdapterShape(adapter, { exact = true } = {}) {
  if (exact) assert.deepEqual(Object.keys(adapter).sort(), ['command', 'createParser', 'name', 'outcome', 'providers', 'versionArgv']);
  assert.equal(typeof adapter.name, 'string');
  assert.match(adapter.name, /^[a-z0-9-]+$/);
  assert.ok(Array.isArray(adapter.versionArgv) && adapter.versionArgv.length > 0 && adapter.versionArgv.every(item => typeof item === 'string'));
  assert.ok(Array.isArray(adapter.providers) && adapter.providers.length > 0 && adapter.providers.every(item => typeof item === 'string'));
  const built = adapter.command({ model: 'm-1', effort: 'high', provider: { id: adapter.providers[0], baseUrl: 'http://models.example.org:8080/v1', placeholderKey: 'acoder-placeholder-not-a-key' }, firstMessage: 'hello', workdir: '/work/dir' });
  assert.deepEqual(Object.keys(built).sort(), ['argv', 'env']);
  assert.ok(built.argv.length > 0 && built.argv.every(item => typeof item === 'string'));
  assert.ok(Object.entries(built.env).every(([key, value]) => /^[A-Z_][A-Z0-9_]*$/.test(key) && typeof value === 'string'));
  const parser = adapter.createParser();
  assert.deepEqual(Object.keys(parser).sort(), ['push', 'result']);
  const result = parser.result();
  assert.equal(typeof result.sawError, 'boolean');
  assert.equal(typeof result.sawStep, 'boolean');
  assert.ok(Number.isInteger(result.advisory.calls) && result.advisory.calls >= 0);
  assert.ok(result.advisory.tokens === null || typeof result.advisory.tokens === 'object');
  assert.ok(['success', 'error'].includes(adapter.outcome({ code: 0, signal: null, parsed: result })));
}

export function assertProfileShape(profile, { exact = true } = {}) {
  if (exact) assert.deepEqual(Object.keys(profile).sort(), ['authHeaders', 'createUsageExtractor', 'id', 'requests']);
  assert.match(profile.id, /^[a-z0-9-]+$/);
  assert.ok(Array.isArray(profile.requests) && profile.requests.length > 0);
  for (const request of profile.requests) {
    assert.deepEqual(Object.keys(request).sort(), ['method', 'suffix']);
    assert.match(request.method, /^[A-Z]+$/);
    assert.match(request.suffix, /^\/[A-Za-z0-9/_-]*$/);
  }
  const headers = profile.authHeaders('k'.repeat(24));
  assert.ok(Object.entries(headers).every(([key, value]) => key === key.toLowerCase() && typeof value === 'string'));
  const extractor = profile.createUsageExtractor('application/json');
  assert.deepEqual(Object.keys(extractor).sort(), ['push', 'result']);
  const result = extractor.result();
  assert.deepEqual(Object.keys(result).sort(), ['model', 'usage']);
}
