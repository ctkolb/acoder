// The scripted model endpoint of the opencode tests (S6, RA15): a program that runs in the stub endpoint's container (HTTPS on 443 with the
// test certificate, as the endpoint of container-run.mjs) and answers the real opencode as the OpenAI API would, for both request kinds the
// openai profile admits: `POST <base>/responses` and `POST <base>/chat/completions`, streamed (event stream) or not. It never contacts
// anything. /srv/scenario.json holds the script: {turns: [{tool, args} | {text}], usage: {input_tokens, output_tokens}, usage_delay_ms,
// fail_after, after: 'fail' | 'close'}. With usage_delay_ms, a streamed answer sends everything but its last event at once and the last
// event, the only one that carries the usage, that many milliseconds later (spec08-usage: the usage is withheld until the last event). The turn of a conversation request is the number of tool results already in its conversation, so a request that
// opencode repeats gets the same answer; a request without tools (a side request such as a title) is answered with text. A string value in a
// turn's args may hold {{run_id}} and {{skill_sha256}}, taken from the tool results in the conversation (the agent read /acoder/run.json).
// Every request is counted in /out/count when its body has arrived; /out/requests.jsonl holds its headers and /out/bodies.jsonl its body,
// the answer and the usage the endpoint sent with it (null when it sent none).
// With fail_after N, every request after the N-th is answered by `after`: a 500 or a closed connection (spec16).
import fs from 'node:fs';
import https from 'node:https';

const plan = fs.existsSync('/srv/scenario.json') ? JSON.parse(fs.readFileSync('/srv/scenario.json', 'utf8')) : {};
const turns = plan.turns ?? [];
const usage = plan.usage ?? { input_tokens: 11, output_tokens: 7 };
const usageDelay = Number.isSafeInteger(plan.usage_delay_ms) ? plan.usage_delay_ms : 0;
let count = 0;
let open = 0;

const json = (res, value, status = 200) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

// The text of every tool result in the conversation (Responses: function_call_output items; chat: tool messages).
function toolResults(body) {
  const texts = [];
  const text = value => (typeof value === 'string' ? value : JSON.stringify(value ?? ''));
  for (const item of Array.isArray(body.input) ? body.input : []) if (item?.type === 'function_call_output') texts.push(text(item.output));
  for (const message of Array.isArray(body.messages) ? body.messages : []) if (message?.role === 'tool') texts.push(text(message.content));
  return texts;
}

function fill(value, found) {
  if (typeof value === 'string') return value.replace(/\{\{(run_id|skill_sha256)\}\}/g, (all, name) => found[name] ?? all);
  if (Array.isArray(value)) return value.map(item => fill(item, found));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, fill(item, found)]));
  return value;
}

// The answer of one request: {tool, args} or {text}.
function answerOf(body) {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return { text: 'Scripted session' };
  const results = toolResults(body);
  const found = {};
  for (const name of ['run_id', 'skill_sha256']) {
    for (const result of results) {
      const match = new RegExp(`"${name}":\\s*"([A-Za-z0-9._-]+)"`).exec(result);
      if (match) found[name] = match[1];
    }
  }
  const turn = turns[results.length] ?? { text: 'The review is written.' };
  return turn.tool ? { tool: turn.tool, args: fill(turn.args ?? {}, found), n: results.length } : { text: turn.text };
}

const sse = (res, event) => res.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`);

function responses(res, body, answer, stream) {
  const id = `resp_${count}`;
  const model = body.model ?? 'stub-model';
  const created = Math.floor(Date.now() / 1000);
  const item = answer.tool
    ? { type: 'function_call', id: `fc_${count}`, call_id: `call_${count}`, name: answer.tool, arguments: JSON.stringify(answer.args), status: 'completed' }
    : { type: 'message', id: `msg_${count}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer.text, annotations: [] }] };
  const full = { id, object: 'response', created_at: created, model, status: 'completed', incomplete_details: null, output: [item], usage };
  if (!stream) return json(res, full);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let sequence = 0;
  const send = event => sse(res, { ...event, sequence_number: sequence++ });
  send({ type: 'response.created', response: { id, object: 'response', created_at: created, model, status: 'in_progress', output: [] } });
  if (answer.tool) {
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } });
    send({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments });
    send({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments });
  } else {
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } });
    send({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: answer.text, logprobs: [] });
    send({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: answer.text, logprobs: [] });
    send({ type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
  }
  send({ type: 'response.output_item.done', output_index: 0, item });
  const last = () => { if (!res.destroyed) { send({ type: 'response.completed', response: full }); res.end(); } };
  if (usageDelay > 0) return void setTimeout(last, usageDelay);
  return last();
}

function chat(res, body, answer, stream) {
  const id = `chatcmpl_${count}`;
  const model = body.model ?? 'stub-model';
  const created = Math.floor(Date.now() / 1000);
  const chatUsage = { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.input_tokens + usage.output_tokens };
  const call = answer.tool ? { index: 0, id: `call_${count}`, type: 'function', function: { name: answer.tool, arguments: JSON.stringify(answer.args) } } : null;
  const finish = call ? 'tool_calls' : 'stop';
  if (!stream) {
    const message = call ? { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: call.function }] } : { role: 'assistant', content: answer.text };
    return json(res, { id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: finish }], usage: chatUsage });
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finishReason = null, extra = {}) => sse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra });
  chunk(call ? { role: 'assistant', content: null, tool_calls: [call] } : { role: 'assistant', content: answer.text });
  chunk({}, finish);
  const last = () => { if (!res.destroyed) { sse(res, { id, object: 'chat.completion.chunk', created, model, choices: [], usage: chatUsage }); sse(res, '[DONE]'); res.end(); } };
  if (usageDelay > 0) return void setTimeout(last, usageDelay);
  return last();
}

const server = https.createServer({ key: fs.readFileSync('/srv/key.pem'), cert: fs.readFileSync('/srv/cert.pem') }, (req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    count += 1;
    const n = count;
    const text = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = JSON.parse(text); } catch { /* recorded as text */ }
    const failing = Number.isSafeInteger(plan.fail_after) && n > plan.fail_after;
    const answer = failing ? null : answerOf(body);
    fs.appendFileSync('/out/requests.jsonl', `${JSON.stringify({ n, mode: failing ? plan.after ?? 'fail' : 'script', url: req.url, rawHeaders: req.rawHeaders })}\n`);
    fs.appendFileSync('/out/bodies.jsonl', `${JSON.stringify({ n, url: req.url, body: text, answer, usage: failing ? null : usage })}\n`);
    fs.writeFileSync('/out/count', String(n));
    open += 1;
    fs.writeFileSync('/out/open', String(open));
    res.on('close', () => { open -= 1; fs.writeFileSync('/out/open', String(open)); });
    if (failing) {
      if (plan.after === 'close') return req.socket.destroy();
      return json(res, { error: { message: 'stub failure', type: 'server_error' } }, 500);
    }
    const stream = body.stream === true;
    if (req.method === 'POST' && req.url.endsWith('/responses')) return responses(res, body, answer, stream);
    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) return chat(res, body, answer, stream);
    return json(res, { error: { message: 'not a scripted request kind' } }, 404);
  });
});
server.listen(443, '0.0.0.0', () => fs.writeFileSync('/out/ready', 'ready'));
