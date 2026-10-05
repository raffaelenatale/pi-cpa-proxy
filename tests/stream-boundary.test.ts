import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantMessageEventStream, type AssistantMessage, type ProviderStreams, type TranscriptContext } from '@earendil-works/pi-ai';
import { guardedStreams } from '../src/stream-boundary.ts';
import { protectedFetch } from '../src/transport-fetch.ts';
import { deriveCatalogue } from '../src/catalogue.ts';
import { makeGateway } from './fixtures.ts';
const model = deriveCatalogue('test', makeGateway(), [{ id: 'primary' }]).models[0];
const message = (errorMessage: string): AssistantMessage => ({
  role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: 1, content: [], stopReason: 'error', errorMessage,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
test('boundary normalizes error events and result, including synchronous native throws', async () => {
  const native: ProviderStreams = {
    stream() { throw new Error('private_key_echo'); },
    streamSimple() {
      const stream = createAssistantMessageEventStream(), error = message('private_key_echo');
      stream.push({ type: 'error', reason: 'error', error }); stream.end(error); return stream;
    },
  };
  for (const method of ['stream', 'streamSimple'] as const) {
    const stream = guardedStreams(native)[method](model, { messages: [] } as unknown as TranscriptContext);
    for await (const event of stream) assert.doesNotMatch(JSON.stringify(event), /private_key_echo/);
    assert.equal((await stream.result()).errorMessage, 'cpa_stream_failed');
  }
});
test('body filter preserves fragmented UTF-8 SSE and multiline data; rejects partial frame', async () => {
  const original = 'event: fixture\r\ndata: {"text":\r\ndata: "è"}\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(original);
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const filtered = await protectedFetch(async () => response)('http://example.invalid');
  assert.equal(await filtered.text(), 'event: fixture\r\ndata: {"text":\r\ndata: "è"}\n\ndata: [DONE]\n\n');
  const partial = await protectedFetch(async () => new Response('data: {"private":"echo"}', { headers: { 'Content-Type': 'text/event-stream' } }))('http://example.invalid');
  await assert.rejects(() => partial.text(), /cpa_stream_frame_truncated/);
});
test('malformed frame and oversized frame do not expose arbitrary bytes to SDK', async () => {
  for (const [payload, code] of [['data: INVALID_PRIVATE_ECHO\n\n', 'cpa_stream_frame_invalid'], ['x'.repeat(2000001), 'cpa_stream_frame_too_large']]) {
    const response = await protectedFetch(async () => new Response(payload, { headers: { 'Content-Type': 'text/event-stream' } }))('http://example.invalid');
    await assert.rejects(() => response.text(), (error: Error) => error.message === code);
  }
});
test('HTTP filter retains status/retry header but no body secret and no rate-limit overflow confusion', async () => {
  const filtered = await protectedFetch(async () => new Response('rate limit: too many tokens PRIVATE_KEY', { status: 429, headers: { 'Retry-After': '1' } }))('http://example.invalid');
  assert.equal(filtered.status, 429); assert.equal(filtered.headers.get('retry-after'), '1');
  const text = await filtered.text(); assert.doesNotMatch(text, /PRIVATE_KEY|context_length_exceeded/); assert.match(text, /cpa_http_failed/);
});
test('transport fetch explicitly refuses redirect following', async () => {
  let policy: string | undefined;
  const request = protectedFetch(async (_input, init) => { policy = init?.redirect; return new Response('ok'); });
  assert.equal(await (await request('http://example.invalid', { redirect: 'follow' })).text(), 'ok');
  assert.equal(policy, 'error');
});
