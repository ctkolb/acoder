// The openai provider profile (A5): all provider-specific code of the sidecar. It imports nothing: the sidecar loads it from its payload.
export const id = 'openai';
export const requests = [{ method: 'POST', suffix: '/responses' }, { method: 'POST', suffix: '/chat/completions' }];

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;

export function authHeaders(key) {
  if (typeof key !== 'string' || key === '') throw new Error('a key is required');
  return { authorization: `Bearer ${key}` };
}

// A usage object as the Responses API or the chat API prints it; null when a counter is missing or is not a count.
function usageFrom(raw) {
  if (!isObject(raw)) return null;
  const input = raw.input_tokens ?? raw.prompt_tokens;
  const output = raw.output_tokens ?? raw.completion_tokens;
  const reasoning = raw.output_tokens_details?.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens ?? 0;
  const cached = raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? 0;
  return [input, output, reasoning, cached].every(isCount) ? { input, output, reasoning, cached_input: cached } : null;
}

export function createUsageExtractor(contentType) {
  const type = typeof contentType === 'string' ? contentType.toLowerCase() : '';
  const mode = type.includes('text/event-stream') ? 'stream' : type.includes('json') ? 'json' : 'none';
  const decoder = new TextDecoder('utf-8');
  const bytesOf = chunk => (typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));

  // JSON answer: the body is kept up to 8 MiB and read at the end.
  let parts = [];
  let size = 0;
  let oversize = false;
  // Event stream: complete `data:` lines are read as they arrive; an event over 1 MiB or one that is not JSON ends the request with usage null.
  let pending = '';
  let skipping = false;
  let broken = false;
  let usage = null;
  let model = null;

  function readLine(raw) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.startsWith('data:')) return;
    const payload = line.slice(line.startsWith('data: ') ? 6 : 5);
    if (payload === '[DONE]') return;
    if (Buffer.byteLength(payload) > MAX_EVENT_BYTES) { broken = true; return; }
    let event;
    try { event = JSON.parse(payload); } catch { broken = true; return; }
    if (!isObject(event)) { broken = true; return; }
    const response = isObject(event.response) ? event.response : null;
    const named = typeof event.model === 'string' ? event.model : response !== null && typeof response.model === 'string' ? response.model : undefined;
    if (named !== undefined) model = named;
    if (event.type === 'response.completed') { if (response !== null && response.usage !== undefined && response.usage !== null) usage = usageFrom(response.usage); }
    else if (event.usage !== undefined && event.usage !== null) usage = usageFrom(event.usage);
  }

  function feed(text) {
    pending += text;
    for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (skipping) skipping = false;
      else readLine(line);
    }
    if (pending.length > MAX_EVENT_BYTES + 6) { broken = true; pending = ''; skipping = true; }
  }

  return {
    push(chunk) {
      if (mode === 'json') {
        if (oversize) return;
        const bytes = bytesOf(chunk);
        size += bytes.length;
        if (size > MAX_JSON_BYTES) { oversize = true; parts = []; return; }
        parts.push(bytes);
      } else if (mode === 'stream') feed(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    },
    result() {
      if (mode === 'stream') {
        feed(decoder.decode());
        if (pending !== '') { const last = pending; pending = ''; if (!skipping) readLine(last); }
        return { usage: broken ? null : usage, model };
      }
      if (mode === 'none' || oversize) return { usage: null, model: null };
      let body;
      try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return { usage: null, model: null }; }
      if (!isObject(body)) return { usage: null, model: null };
      return { usage: usageFrom(body.usage), model: typeof body.model === 'string' ? body.model : null };
    },
  };
}
