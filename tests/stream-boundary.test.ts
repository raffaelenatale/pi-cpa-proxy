import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantMessageEventStream, isRetryableAssistantError, type AssistantMessage, type ProviderStreams, type TranscriptContext } from '@earendil-works/pi-ai';
import { guardedStreams } from '../src/stream-boundary.ts';
import { protectedFetch } from '../src/transport-fetch.ts';
import { deriveCatalogue } from '../src/catalogue.ts';
import { makeGateway } from './fixtures.ts';
const model = deriveCatalogue('test', makeGateway(), [{ id: 'primary' }]).models[0];
const message = (errorMessage: string): AssistantMessage => ({
  role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: 1, content: [], stopReason: 'error', errorMessage,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
/** Runs one failed native call through the boundary and returns the final message Pi would see. */
async function failedThrough(raw: string, stopReason: 'error' | 'aborted' = 'error'): Promise<AssistantMessage> {
  const native: ProviderStreams = {
    stream() { throw new Error('unused'); },
    streamSimple() {
      const stream = createAssistantMessageEventStream(), error = { ...message(raw), stopReason };
      stream.push({ type: 'error', reason: stopReason, error }); stream.end(error); return stream;
    },
  };
  const stream = guardedStreams(native).streamSimple(model, { messages: [] } as unknown as TranscriptContext);
  for await (const _event of stream) { /* drain */ }
  return stream.result();
}
// Raw texts as pi-ai/SDKs produce them: in-stream SSE error JSON, and sanitized HTTP bodies ("<status> {...}").
const httpBody = (status: number, type: string) => `${status} ${JSON.stringify({ error: { message: 'cpa_http_failed', type, code: `http_${status}` } })}`;
const sseOverloaded = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
const retryable = [
  { name: 'SSE overloaded_error (200, first event)', raw: sseOverloaded, label: 'cpa_stream_failed: overloaded' },
  { name: 'bare overloaded text', raw: 'Overloaded', label: 'cpa_stream_failed: overloaded' },
  { name: 'HTTP 529 overloaded', raw: httpBody(529, 'overloaded_error'), label: 'cpa_stream_failed: overloaded' },
  { name: 'HTTP 503 overloaded', raw: httpBody(503, 'overloaded_error'), label: 'cpa_stream_failed: overloaded' },
  { name: 'HTTP 429 rate limit', raw: httpBody(429, 'rate_limit_error'), label: 'cpa_stream_failed: rate limit' },
  { name: 'SSE rate_limit_error', raw: '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}', label: 'cpa_stream_failed: rate limit' },
  { name: 'HTTP 500 api_error', raw: httpBody(500, 'api_error'), label: 'cpa_stream_failed: server error' },
  { name: 'HTTP 502 api_error', raw: httpBody(502, 'api_error'), label: 'cpa_stream_failed: server error' },
  { name: 'HTTP 504 api_error', raw: httpBody(504, 'api_error'), label: 'cpa_stream_failed: server error' },
];
for (const { name, raw, label } of retryable) {
  test(`transient failure is retryable by Pi without provider text: ${name}`, async () => {
    const final = await failedThrough(raw);
    assert.equal(final.errorMessage, label);
    assert.equal(isRetryableAssistantError(final), true);
    assert.doesNotMatch(JSON.stringify(final), /Overloaded|slow down|cpa_http_failed/);
  });
}
const neutral = [
  { name: 'HTTP 400 third-party extra usage (sanitized body)', raw: httpBody(400, 'cpa_http_failed') },
  { name: 'SSE invalid_request_error', raw: '{"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage"}}' },
  { name: 'HTTP 429 quota exhaustion (original text)', raw: '429 insufficient_quota: You exceeded your current quota, billing details' },
  { name: 'HTTP 401 unauthorized (sanitized)', raw: httpBody(401, 'cpa_http_failed') },
];
for (const { name, raw } of neutral) {
  test(`non-transient failure stays non-retryable and neutral: ${name}`, async () => {
    const final = await failedThrough(raw);
    assert.equal(final.errorMessage, 'cpa_stream_failed');
    assert.equal(isRetryableAssistantError(final), false);
    assert.doesNotMatch(JSON.stringify(final), /Third-party|invalid_request|quota|billing|unauthorized/);
  });
}
test('aborted and context overflow keep their labels', async () => {
  assert.equal((await failedThrough('Request was aborted', 'aborted')).errorMessage, 'cpa_request_aborted');
  const overflow = await failedThrough('prompt is too long: 213462 tokens > 200000 maximum');
  assert.equal(overflow.errorMessage, 'cpa_context_length_exceeded');
  assert.equal(isRetryableAssistantError(overflow), false);
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
test('a label survives repeated passes over the same failed message (partial, error, done, result)', async () => {
  const native: ProviderStreams = {
    stream() { throw new Error('unused'); },
    streamSimple() {
      const stream = createAssistantMessageEventStream(), error = message(sseOverloaded);
      stream.push({ type: 'start', partial: error } as never);
      stream.push({ type: 'error', reason: 'error', error }); stream.end(error); return stream;
    },
  };
  const stream = guardedStreams(native).streamSimple(model, { messages: [] } as unknown as TranscriptContext);
  for await (const _event of stream) { /* drain */ }
  const final = await stream.result();
  assert.equal(final.errorMessage, 'cpa_stream_failed: overloaded');
  assert.equal(isRetryableAssistantError(final), true);
});
test('thrown transient SDK error is classified, not reduced to the neutral label', async () => {
  // The native source throws while iterating (no error event): the boundary's catch branch handles it.
  const native: ProviderStreams = {
    stream() { throw new Error('unused'); },
    streamSimple() {
      async function* failing() { throw new Error(sseOverloaded); }
      return Object.assign(failing(), { result: async () => { throw new Error(sseOverloaded); } }) as never;
    },
  };
  const final = await guardedStreams(native).streamSimple(model, { messages: [] } as unknown as TranscriptContext).result();
  assert.equal(final.errorMessage, 'cpa_stream_failed: overloaded');
  assert.equal(isRetryableAssistantError(final), true);
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
test('HTTP filter retains status/retry header, fixed type from status, and no body secret', async () => {
  const filtered = await protectedFetch(async () => new Response('rate limit: too many tokens PRIVATE_KEY', { status: 429, headers: { 'Retry-After': '1' } }))('http://example.invalid');
  assert.equal(filtered.status, 429); assert.equal(filtered.headers.get('retry-after'), '1');
  const text = await filtered.text(); assert.doesNotMatch(text, /PRIVATE_KEY|context_length_exceeded/); assert.match(text, /cpa_http_failed/);
  assert.match(text, /"type":"rate_limit_error"/); assert.match(text, /"code":"http_429"/);
});
test('HTTP filter maps status to fixed types and keeps quota exhaustion non-transient', async () => {
  const typeFor = async (status: number, body = 'PRIVATE') => {
    const response = await protectedFetch(async () => new Response(body, { status }))('http://example.invalid');
    return JSON.parse(await response.text()).error.type;
  };
  assert.equal(await typeFor(529), 'overloaded_error'); assert.equal(await typeFor(503), 'overloaded_error');
  assert.equal(await typeFor(429), 'rate_limit_error'); assert.equal(await typeFor(500), 'api_error');
  assert.equal(await typeFor(502), 'api_error'); assert.equal(await typeFor(504), 'api_error');
  assert.equal(await typeFor(400), 'cpa_http_failed'); assert.equal(await typeFor(401), 'cpa_http_failed');
  assert.equal(await typeFor(429, 'insufficient_quota'), 'cpa_http_failed');
});
test('transport fetch explicitly refuses redirect following', async () => {
  let policy: string | undefined;
  const request = protectedFetch(async (_input, init) => { policy = init?.redirect; return new Response('ok'); });
  assert.equal(await (await request('http://example.invalid', { redirect: 'follow' })).text(), 'ok');
  assert.equal(policy, 'error');
});
