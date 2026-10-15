import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { validateConfiguration } from '../src/configuration.ts';
import { extractSources, rawPrompt, runSearch, searchPrompt } from '../src/search-tools.ts';
import { makeGateway } from './fixtures.ts';

const withTools = (tools: unknown) => ({ schemaVersion: 1, connections: { 'test-proxy': makeGateway() }, integrations: { searchTools: tools } });
const tool = { connection: 'test-proxy', model: 'grounded-model', timeoutMs: 5000, stream: false, prompt: 'search' as const };

test('schema accepts a search tool and applies the default timeout', () => {
  const parsed = validateConfiguration(withTools({ argon_search: { connection: 'test-proxy', model: 'grounded-model' } }));
  assert.deepEqual(parsed.integrations?.searchTools?.argon_search, { connection: 'test-proxy', model: 'grounded-model', timeoutMs: 180000, stream: false, prompt: 'search' });
});
test('schema rejects unknown connection, reserved or malformed names and extra keys', () => {
  assert.throws(() => validateConfiguration(withTools({ argon_search: { connection: 'missing', model: 'm' } })));
  assert.throws(() => validateConfiguration(withTools({ web_search: { connection: 'test-proxy', model: 'm' } })));
  assert.throws(() => validateConfiguration(withTools({ 'Bad-Name': { connection: 'test-proxy', model: 'm' } })));
  assert.throws(() => validateConfiguration(withTools({ argon_search: { connection: 'test-proxy', model: 'm', endpoint: 'http://x' } })));
});

test('prompt asks for sources and honours the language', () => {
  assert.match(searchPrompt('q?'), /Sources/);
  assert.match(searchPrompt('q?', 'Italian'), /Answer in Italian\./);
});
test('sources: markdown links and bare URLs, deduplicated, http(s) only', () => {
  const text = 'A [Doc](https://a.example/x). See https://b.example/y, and [Doc again](https://a.example/x) [bad](javascript:alert(1)) ftp://c.example';
  assert.deepEqual(extractSources(text), [
    { title: 'Doc', url: 'https://a.example/x' },
    { title: 'https://b.example/y', url: 'https://b.example/y' },
  ]);
});

async function serve(handler: (body: string, headers: Record<string, string | string[] | undefined>) => { status: number; body: string; delayMs?: number; type?: string }) {
  const seen: { body: string; auth?: string; url?: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ body, auth: req.headers.authorization, url: req.url });
      const out = handler(body, req.headers);
      setTimeout(() => { res.writeHead(out.status, { 'content-type': out.type ?? 'application/json' }); res.end(out.body); }, out.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { seen, gateway: makeGateway({ endpoint: `http://127.0.0.1:${port}` }), close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

test('runSearch posts one non-streaming completion with the configured model and key', async () => {
  process.env.CPA_TEST_KEY = 'K-123';
  const answer = 'Answer.\n\nSources: [Site](https://site.example/p)';
  const srv = await serve(() => ({ status: 200, body: JSON.stringify({ model: 'upstream-x', choices: [{ message: { content: answer } }] }) }));
  try {
    const result = await runSearch(tool, srv.gateway, '  what is new?  ', { language: 'Italian' });
    assert.equal(result.text, answer);
    assert.equal(result.model, 'upstream-x');
    assert.deepEqual(result.sources, [{ title: 'Site', url: 'https://site.example/p' }]);
    assert.equal(srv.seen[0].url, '/v1/chat/completions');
    assert.equal(srv.seen[0].auth, 'Bearer K-123');
    const sent = JSON.parse(srv.seen[0].body);
    assert.equal(sent.model, 'grounded-model');
    assert.equal(sent.stream, false);
    assert.match(sent.messages[0].content, /Question: what is new\?$/);
  } finally { await srv.close(); }
});

test('runSearch returns fixed codes and never upstream text', async () => {
  process.env.CPA_TEST_KEY = 'K-123';
  const srv = await serve((body) => body.includes('fail') ? { status: 502, body: '{"error":"secret upstream detail"}' } : { status: 200, body: '{"choices":[{"message":{"content":""}}]}' });
  try {
    await assert.rejects(() => runSearch(tool, srv.gateway, 'fail please'), (e: Error) => e.message === 'search_http_502');
    await assert.rejects(() => runSearch(tool, srv.gateway, 'empty'), /search_response_empty/);
    await assert.rejects(() => runSearch(tool, srv.gateway, '   '), /search_query_empty/);
  } finally { await srv.close(); }
});

test('runSearch times out and reports a missing credential', async () => {
  process.env.CPA_TEST_KEY = 'K-123';
  const srv = await serve(() => ({ status: 200, body: '{}', delayMs: 3000 }));
  try {
    await assert.rejects(() => runSearch({ ...tool, timeoutMs: 1000 }, srv.gateway, 'slow'), /search_timeout/);
    delete process.env.CPA_TEST_KEY;
    await assert.rejects(() => runSearch(tool, srv.gateway, 'q'), /credential_missing/);
  } finally { await srv.close(); }
});

const sse = (...events: unknown[]) => events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');

test('stream: content is accumulated, reasoning is reported as progress, raw prompt is sent as is', async () => {
  process.env.CPA_TEST_KEY = 'K-123';
  const body = sse(
    { model: 'deep-x', choices: [{ delta: { role: 'assistant' } }] },
    { choices: [{ delta: { reasoning_content: 'Plan: a, b\n' } }] },
    { choices: [{ delta: { reasoning_content: 'Researching... 1 min\n' } }] },
    { choices: [{ delta: { content: '# Report\nSee [S](https://s.example/1)' } }] },
    { choices: [{ delta: { content: ' end.' } }] },
    '[DONE]');
  const srv = await serve(() => ({ status: 200, body, type: 'text/event-stream' }));
  const progress: string[] = [];
  try {
    const result = await runSearch({ ...tool, stream: true, prompt: 'raw' }, srv.gateway, 'deep topic', { language: 'Italian', onProgress: (t) => progress.push(t) });
    assert.equal(result.text, '# Report\nSee [S](https://s.example/1) end.');
    assert.equal(result.model, 'deep-x');
    assert.deepEqual(progress, ['Plan: a, b\n', 'Researching... 1 min\n']);
    const sent = JSON.parse(srv.seen[0].body);
    assert.equal(sent.stream, true);
    assert.equal(sent.messages[0].content, rawPrompt('deep topic', 'Italian'));
  } finally { await srv.close(); }
});

test('stream: an error event becomes a fixed code', async () => {
  process.env.CPA_TEST_KEY = 'K-123';
  const srv = await serve(() => ({ status: 200, type: 'text/event-stream', body: sse({ error: { message: 'secret', type: 'deep_research_busy' } }, '[DONE]') }));
  const srv2 = await serve(() => ({ status: 200, type: 'text/event-stream', body: sse({ error: { type: 'Bad Type!' } }) }));
  try {
    await assert.rejects(() => runSearch({ ...tool, stream: true }, srv.gateway, 'q'), (e: Error) => e.message === 'search_stream_deep_research_busy');
    await assert.rejects(() => runSearch({ ...tool, stream: true }, srv2.gateway, 'q'), (e: Error) => e.message === 'search_stream_upstream_error');
  } finally { await srv.close(); await srv2.close(); }
});
