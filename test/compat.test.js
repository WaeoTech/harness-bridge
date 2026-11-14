import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { toOpenAI, toAnthropic, startProxy, encodeTextTools, decodeTextTools } from '../examples/openai-messages-proxy.mjs';

const request = {
  model: 'ignored-client-model', max_tokens: 1024, system: [{ type: 'text', text: 'scope' }],
  tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
  tool_choice: { type: 'tool', name: 'Read' },
  messages: [
    { role: 'user', content: 'read probe.txt' },
    { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'probe.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'random proof' }] }] },
  ],
};
const upstreamReply = {
  choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'Read', arguments: '{"file_path":"probe.txt"}' } }] } }],
  usage: { prompt_tokens: 20, completion_tokens: 7 },
};

test('compatibility translation preserves tool schema, arguments, IDs and results', () => {
  const out = toOpenAI(request, 'grok-chat-expert');
  assert.equal(out.model, 'grok-chat-expert');
  assert.deepEqual(out.tools[0].function.parameters, request.tools[0].input_schema);
  assert.deepEqual(out.tool_choice, { type: 'function', function: { name: 'Read' } });
  assert.deepEqual(out.messages.at(-1), { role: 'tool', tool_call_id: 'call_1', content: 'random proof' });
  assert.equal(out.messages.at(-2).tool_calls[0].function.arguments, '{"file_path":"probe.txt"}');
  const result = toAnthropic(upstreamReply, 'grok-chat-expert');
  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.content[0], { type: 'tool_use', id: 'call_2', name: 'Read', input: { file_path: 'probe.txt' } });
  assert.deepEqual(result.usage, { input_tokens: 20, output_tokens: 7 });
  const extended = toOpenAI({ ...request, messages: [...request.messages, { role: 'system', content: [{ type: 'text', text: 'runtime context' }] }], tools: request.tools.map(tool => ({ ...tool, type: 'custom' })) }, 'grok');
  assert.deepEqual(extended.messages.at(-1), { role: 'system', content: 'runtime context' });
  assert.equal(extended.tools[0].function.name, 'Read');
});

test('unsupported multimodal content, invalid tool JSON and filtered output fail closed', () => {
  assert.throws(() => toOpenAI({ messages: [{ role: 'user', content: [{ type: 'image' }] }] }, 'grok'));
  assert.throws(() => toAnthropic({ choices: [{ finish_reason: 'content_filter', message: { content: 'blocked' } }] }, 'grok'));
  assert.throws(() => toAnthropic({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [] } }] }, 'grok'));
  const invalid = structuredClone(upstreamReply); invalid.choices[0].message.tool_calls[0].function.arguments = 'broken';
  assert.throws(() => toAnthropic(invalid, 'grok'));
  const limited = toAnthropic({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }, 'grok');
  assert.equal(limited.stop_reason, 'max_tokens');
});

test('explicit text-tool mode strictly validates envelopes and allowed tool names', () => {
  const payload = toOpenAI(request, 'grok');
  const encoded = encodeTextTools(payload);
  assert.equal(encoded.tools, undefined);
  assert.match(encoded.messages.at(-1).content, /Available tools/);
  assert.match(encoded.messages.at(-1).content, /file_path/);
  assert.match(encoded.messages.at(-2).content, /random proof/);
  const response = value => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });
  const decoded = decodeTextTools(response({ tool_calls: [{ name: 'Read', arguments: { file_path: 'probe.txt' } }] }), payload);
  assert.equal(toAnthropic(decoded, 'grok').content[0].name, 'Read');
  assert.throws(() => decodeTextTools(response({ tool_calls: [{ name: 'Bash', arguments: { command: 'bad' } }] }), payload));
  assert.throws(() => decodeTextTools(response({ text: 'guessed' }), payload));
  assert.throws(() => decodeTextTools(response({ tool_calls: [{ name: 'Read', arguments: [] }] }), payload));
  assert.throws(() => decodeTextTools(response({ text: 'answer', extra: true }), payload));
  assert.throws(() => decodeTextTools({ choices: [{ finish_reason: 'stop', message: { content: 'arbitrary prose' } }] }, payload));
  const final = decodeTextTools(response({ text: 'verified answer' }), { ...payload, tool_choice: 'auto' });
  assert.equal(toAnthropic(final, 'grok').content[0].text, 'verified answer');
});

async function fixture(t, responseHandler) {
  const upstream = createServer(responseHandler);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const proxy = await startProxy({ baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'real-secret-test-key', model: 'grok-chat-expert', token: 'local-only-token', timeoutMs: 500 });
  t.after(() => proxy.close());
  return proxy;
}
const headers = { 'content-type': 'application/json', 'x-api-key': 'local-only-token' };

test('loopback HTTP proxy emits genuine tool-use SSE blocks and forwards only upstream key', async t => {
  let captured;
  const proxy = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer real-secret-test-key');
    let raw = ''; for await (const chunk of req) raw += chunk;
    captured = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(upstreamReply));
  });
  const response = await fetch(`${proxy.url}/v1/messages?beta=true`, { method: 'POST', headers, body: JSON.stringify({ ...request, stream: true }) });
  assert.equal(response.status, 200);
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.equal(events[0].type, 'message_start');
  assert.equal(events[1].content_block.type, 'tool_use');
  assert.deepEqual(JSON.parse(events[2].delta.partial_json), { file_path: 'probe.txt' });
  assert.equal(events.at(-2).delta.stop_reason, 'tool_use');
  assert.equal(events.at(-1).type, 'message_stop');
  assert.equal(captured.messages.at(-1).tool_call_id, 'call_1');
});

test('proxy rejects missing authentication and does not reflect upstream error bodies', async t => {
  let calls = 0;
  const proxy = await fixture(t, (_req, res) => { calls++; res.writeHead(401); res.end('real-secret-test-key confidential upstream text'); });
  const denied = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' });
  assert.equal(denied.status, 401); await denied.text(); assert.equal(calls, 0);
  const response = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(request) });
  assert.equal(response.status, 401);
  const body = await response.text(); assert.doesNotMatch(body, /real-secret|confidential/); assert.match(body, /HTTP 401/);
  assert.equal(calls, 1);
});

test('proxy bounds malformed input, unsupported endpoints and invalid upstream envelopes', async t => {
  const proxy = await fixture(t, (_req, res) => { res.writeHead(200); res.end('{"choices":[]}'); });
  const invalid = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', headers, body: 'bad' });
  assert.equal(invalid.status, 400); await invalid.text();
  const unknown = await fetch(`${proxy.url}/v1/messages/count_tokens`, { method: 'POST', headers, body: '{}' });
  assert.equal(unknown.status, 404); await unknown.text();
  const upstream = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(request) });
  assert.equal(upstream.status, 502); await upstream.text();
});
