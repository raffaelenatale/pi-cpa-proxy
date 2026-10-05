import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, Type, isContextOverflow } from '@earendil-works/pi-ai';
import { makeGateway, member } from './fixtures.ts';
import { openGateway } from '../src/gateway.ts';
import type { WireApi } from '../src/schema.ts';

const apis = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'] as const;
function sse(res: ServerResponse, data: Record<string, unknown>, name?: string) {
  res.write(`${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
}
function responseEvents(res: ServerResponse, model: string, tool: boolean, truncated: boolean) {
  const item = tool ? { type: 'function_call', id: 'fc_native', call_id: 'call_native', name: 'fixture_lookup', arguments: '{"key":"value"}', status: 'completed' }
    : { type: 'message', id: 'msg_native', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
  sse(res, { type: 'response.created', response: { id: 'resp_native', status: 'in_progress' } });
  sse(res, { type: 'response.output_item.added', output_index: 0, item: { ...item, ...(tool ? { arguments: '' } : { content: [] }) } });
  if (tool) {
    sse(res, { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"key":' });
    sse(res, { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"value"}' });
  } else {
    sse(res, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'O' });
    sse(res, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'K' });
  }
  if (truncated) { res.end(); return; }
  sse(res, { type: 'response.output_item.done', output_index: 0, item });
  sse(res, { type: 'response.completed', response: { id: 'resp_native', status: 'completed', model, output: [item],
    usage: { input_tokens: 15, output_tokens: 2, total_tokens: 17, input_tokens_details: { cached_tokens: 3 } } } }); res.end();
}
function anthropicEvents(res: ServerResponse, model: string, tool: boolean, truncated: boolean) {
  const emit = (data: Record<string, unknown>) => sse(res, data, data.type as string);
  emit({ type: 'message_start', message: { id: 'msg_native', type: 'message', role: 'assistant', model, content: [], stop_reason: null,
    usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 3 } } });
  emit({ type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'call_native', name: 'fixture_lookup', input: {} } : { type: 'text', text: '' } });
  if (tool) {
    emit({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"key":' } });
    emit({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"value"}' } });
  } else {
    emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'O' } });
    emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'K' } });
  }
  if (truncated) { res.end(); return; }
  emit({ type: 'content_block_stop', index: 0 });
  emit({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 2 } });
  emit({ type: 'message_stop' }); res.end();
}
function googleEvents(res: ServerResponse, tool: boolean, truncated: boolean) {
  sse(res, { candidates: [{ content: { role: 'model', parts: tool ? [{ functionCall: { id: 'call_native', name: 'fixture_lookup', args: { key: 'value' } } }] : [{ text: 'O' }] } }] });
  if (truncated) { res.end(); return; }
  sse(res, { candidates: [{ content: { role: 'model', parts: tool ? [] : [{ text: 'K' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 15, cachedContentTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 17 } }); res.end();
}
async function fixture(api: WireApi) {
  let mode = 'normal', closed = 0, redirectTarget = '';
  const payloads: Record<string, any>[] = [], paths: string[] = [], headers: Record<string, unknown>[] = [];
  let started!: () => void; const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const server = createServer(async (req, res) => {
    paths.push(req.url!); headers.push(req.headers);
    if (req.url === '/v1/models') {
      assert.equal(req.headers.authorization, 'Bearer TRANSPORT_SYNTHETIC');
      res.end(JSON.stringify({ data: [{ id: 'transport-model' }] })); return;
    }
    req.on('close', () => { closed++; });
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw); payloads.push(data);
    started();
    if (mode === 'redirect') { res.writeHead(307, { Location: redirectTarget }); res.end(); return; }
    if (mode === 'http-error' || mode === 'overflow') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: mode === 'overflow' ? 'prompt is too long TRANSPORT_SYNTHETIC' : 'synthetic upstream rejection TRANSPORT_SYNTHETIC', type: 'invalid_request_error', code: 'invalid' } })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders();
    if (mode === 'hang') return;
    if (mode === 'malformed') { res.end('data: {not-json TRANSPORT_SYNTHETIC}\n\n'); return; }
    const serialized = JSON.stringify(data);
    const tool = !!data.tools?.length && !serialized.includes('function_call_output') && !serialized.includes('tool_result') && !serialized.includes('functionResponse') && !data.messages?.some((message: { role: string }) => message.role === 'tool');
    if (api === 'openai-completions') {
      const delta = tool ? { tool_calls: [{ index: 0, id: 'call_native', type: 'function', function: { name: 'fixture_lookup', arguments: '{"key":"value"}' } }] } : { content: 'OK' };
      sse(res, { id: 'chat_native', object: 'chat.completion.chunk', created: 1, model: data.model, choices: [{ index: 0, delta, finish_reason: null }] });
      if (mode === 'truncated') { res.end(); return; }
      sse(res, { id: 'chat_native', object: 'chat.completion.chunk', created: 1, model: data.model, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 15, completion_tokens: 2, total_tokens: 17, prompt_tokens_details: { cached_tokens: 3 } } });
      res.end('data: [DONE]\n\n');
    } else if (api === 'openai-responses') responseEvents(res, data.model, tool, mode === 'truncated');
    else if (api === 'anthropic-messages') anthropicEvents(res, data.model, tool, mode === 'truncated');
    else googleEvents(res, tool, mode === 'truncated');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env = `TRANSPORT_TEST_${api.replaceAll('-', '_').toUpperCase()}`;
  const prior = process.env[env]; process.env[env] = 'TRANSPORT_SYNTHETIC';
  const gateway = makeGateway({ endpoint, api, credential: { kind: 'env', name: env }, profiles: {},
    models: { 'transport-model': { ...member, input: ['text', 'image'], reasoning: false, maxTokens: 1000 } } });
  const opened = await openGateway('test-transport', gateway, await mkdtemp(join(tmpdir(), 'cpa-transport-')));
  const registry = createModels(); registry.setProvider(opened.provider);
  const outcome = await registry.refresh({ force: true }); assert.equal(outcome.errors.size, 0);
  const model = registry.getModel('test-transport', 'transport-model')!;
  return { registry, model, payloads, headers, paths, started: requestStarted, closed: () => closed,
    setMode: (value: string) => { mode = value; }, setRedirect: (target: string) => { redirectTarget = target; mode = 'redirect'; },
    close: async () => { if (prior === undefined) delete process.env[env]; else process.env[env] = prior; server.closeAllConnections(); server.close(); await once(server, 'close'); } };
}
const user = { role: 'user' as const, content: 'call fixture', timestamp: 1 };
const tools = [{ name: 'fixture_lookup', description: 'Synthetic fixture', parameters: Type.Object({ key: Type.String() }) }];
for (const api of apis) {
  test(`${api}: native stream/tool call/result, auth and endpoint`, async () => {
    const f = await fixture(api);
    try {
      const first = await f.registry.completeSimple(f.model, { systemPrompt: 'fixture system', messages: [user], tools }, { maxRetries: 0 });
      assert.equal(first.stopReason, 'toolUse', first.errorMessage);
      const call = first.content.find((block) => block.type === 'toolCall'); assert.ok(call && call.type === 'toolCall');
      assert.deepEqual(call.arguments, { key: 'value' });
      const second = await f.registry.completeSimple(f.model, { systemPrompt: 'fixture system', tools, messages: [user, first,
        { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'fixture output' }], isError: false, timestamp: 2 }] }, { maxRetries: 0 });
      assert.equal(second.stopReason, 'stop', second.errorMessage);
      assert.equal(second.content.find((block) => block.type === 'text')?.text, 'OK');
      assert.equal(second.usage.input, 12); assert.equal(second.usage.cacheRead, 3); assert.equal(second.usage.output, 2);
      const request = JSON.stringify(f.payloads[1]); assert.match(request, /fixture output/);
      assert.match(request, api === 'openai-completions' ? /"role":"tool"/ : api === 'openai-responses' ? /function_call_output/ : api === 'anthropic-messages' ? /tool_result/ : /functionResponse/);
      const target = new URL(f.paths[1], 'http://fixture.invalid');
      assert.equal(target.pathname, api === 'openai-completions' ? '/v1/chat/completions' : api === 'openai-responses' ? '/v1/responses' : api === 'anthropic-messages' ? '/v1/messages' : '/v1beta/models/transport-model:streamGenerateContent');
      if (api === 'openai-responses' || api === 'openai-completions') assert.equal(f.headers[1].authorization, 'Bearer TRANSPORT_SYNTHETIC');
      else assert.equal(f.headers[1][api === 'anthropic-messages' ? 'x-api-key' : 'x-goog-api-key'], 'TRANSPORT_SYNTHETIC');
    } finally { await f.close(); }
  });
  test(`${api}: image input reaches native wire payload`, async () => {
    const f = await fixture(api);
    try {
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1kAAAAASUVORK5CYII=';
      const message = await f.registry.completeSimple(f.model, { messages: [{ role: 'user', timestamp: 1,
        content: [{ type: 'text', text: 'synthetic image' }, { type: 'image', data: png, mimeType: 'image/png' }] }] }, { maxRetries: 0 });
      assert.equal(message.stopReason, 'stop', message.errorMessage);
      const serialized = JSON.stringify(f.payloads[0]); assert.match(serialized, /image\/png/); assert.ok(serialized.includes(png));
    } finally { await f.close(); }
  });
  for (const mode of ['http-error', 'malformed', 'truncated']) test(`${api}: ${mode} never succeeds silently`, async () => {
    const f = await fixture(api);
    try {
      f.setMode(mode);
      const message = await f.registry.completeSimple(f.model, { messages: [user] }, { maxRetries: 0 });
      assert.equal(message.stopReason, 'error'); assert.ok(message.errorMessage);
      assert.doesNotMatch(message.errorMessage, /TRANSPORT_SYNTHETIC/);
    } finally { await f.close(); }
  });
  if (api !== 'google-generative-ai') test(`${api}: redirects refused without contacting another origin`, async () => {
    let hits = 0;
    const target = createServer((_req, res) => { hits++; res.end(); });
    target.listen(0, '127.0.0.1'); await once(target, 'listening');
    const f = await fixture(api);
    try {
      f.setRedirect(`http://127.0.0.1:${(target.address() as { port: number }).port}/capture`);
      const message = await f.registry.completeSimple(f.model, { messages: [user] }, { maxRetries: 0 });
      assert.equal(message.stopReason, 'error'); assert.equal(hits, 0);
      assert.equal(message.errorMessage, 'cpa_stream_failed');
    } finally { await f.close(); target.closeAllConnections(); target.close(); await once(target, 'close'); }
  });
  test(`${api}: redacted overflow retains Pi compaction detection`, async () => {
    const f = await fixture(api);
    try {
      f.setMode('overflow'); const message = await f.registry.completeSimple(f.model, { messages: [user] }, { maxRetries: 0 });
      assert.equal(message.errorMessage, 'cpa_context_length_exceeded'); assert.equal(isContextOverflow(message, f.model.contextWindow), true);
    } finally { await f.close(); }
  });
  test(`${api}: cancellation interrupts a pending stream`, async () => {
    const f = await fixture(api);
    try {
      f.setMode('hang'); const controller = new AbortController();
      const pending = f.registry.completeSimple(f.model, { messages: [user] }, { signal: controller.signal, maxRetries: 0 });
      await f.started; controller.abort();
      const message = await pending; assert.equal(message.stopReason, 'aborted');
    } finally { await f.close(); }
  });
  test(`${api}: stream accumulates tokens and completes reliably`, async () => {
    const f = await fixture(api);
    try {
      const stream = await f.registry.streamSimple(f.model, { messages: [user] }, { maxRetries: 0 });
      const events: any[] = [];
      for await (const event of stream) {
        events.push(event);
      }
      const message = await stream.result();
      assert.equal(message.stopReason, 'stop', message.errorMessage);
      const textBlock = message.content.find((b) => b.type === 'text');
      assert.ok(textBlock && textBlock.type === 'text');
      assert.equal(textBlock.text, 'OK');
      assert.ok(events.length >= 1, 'Stream events must be produced');
    } finally { await f.close(); }
  });
}
