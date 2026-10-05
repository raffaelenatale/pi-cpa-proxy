import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, Type } from '@earendil-works/pi-ai';
import { makeGateway } from './fixtures.ts';
import { openGateway, requestListing } from '../src/gateway.ts';

async function mockGateway() {
  let fail = 0, requests = 0;
  const payloads: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    requests++;
    assert.equal(req.headers.authorization, 'Bearer SYNTHETIC_KEY');
    if (req.url === '/v1/models') {
      if (fail) { res.writeHead(fail); res.end('PRIVATE_BODY_NEVER_PRINT'); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'primary', owned_by: 'arbitrary' }, { id: 'role' }, { id: 'unknown' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      let body = ''; for await (const chunk of req) body += chunk;
      const data = JSON.parse(body); payloads.push(data);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const toolRound = data.messages.some((m: { role: string }) => m.role === 'tool');
      const tool = data.tools?.length && !toolRound;
      const delta = tool ? { tool_calls: [{ index: 0, id: 'call-synthetic', type: 'function', function: { name: 'read_fixture', arguments: '{}' } }] } : { content: 'OK' };
      res.write(`data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: data.model, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: data.model, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } })}\n\n`);
      res.end('data: [DONE]\n\n'); return;
    }
    res.writeHead(404); res.end();
  });
  server.keepAliveTimeout = 1;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return { endpoint: `http://127.0.0.1:${port}`, payloads, setFail: (code: number) => { fail = code; }, count: () => requests,
    close: async () => { server.closeAllConnections(); server.close(); await once(server, 'close'); } };
}

test('native provider discovery, stream, system-role and real tool round-trip', async () => {
  const gateway = await mockGateway();
  const prior = process.env.CPA_TEST_KEY; process.env.CPA_TEST_KEY = 'SYNTHETIC_KEY';
  try {
    const opened = await openGateway('test-proxy', makeGateway({ endpoint: gateway.endpoint }), await mkdtemp(join(tmpdir(), 'cpa-cache-')));
    const registry = createModels(); registry.setProvider(opened.provider);
    const refreshed = await registry.refresh({ force: true });
    assert.equal(refreshed.errors.size, 0);
    assert.equal(registry.getAllModels('test-proxy').length, 2);
    const model = registry.getModel('test-proxy', 'role')!;
    assert.ok(model);
    assert.equal(opened.health.omitted, 1);
    const user = { role: 'user' as const, content: 'use the fixture tool', timestamp: 1 };
    const tools = [{ name: 'read_fixture', description: 'Read a synthetic fixture', parameters: Type.Object({}) }];
    const first = await registry.completeSimple(model, { systemPrompt: 'test instructions', messages: [user], tools });
    assert.equal(first.stopReason, 'toolUse');
    const call = first.content.find((block) => block.type === 'toolCall');
    assert.ok(call && call.type === 'toolCall');
    const second = await registry.completeSimple(model, { systemPrompt: 'test instructions', tools, messages: [user, first, {
      role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'fixture contents' }], isError: false, timestamp: 2,
    }] });
    assert.equal(second.stopReason, 'stop');
    assert.equal(second.content[0].type, 'text');
    assert.equal(second.usage.input, 12);
    assert.equal((gateway.payloads[0].messages as { role: string }[])[0].role, 'system');
    assert.ok((gateway.payloads[1].messages as { role: string }[]).some((message) => message.role === 'tool'));
  } finally {
    if (prior === undefined) delete process.env.CPA_TEST_KEY; else process.env.CPA_TEST_KEY = prior;
    await gateway.close();
  }
});
test('offline raw cache re-derives metadata; failed refresh retains previous snapshot', async () => {
  const gateway = await mockGateway();
  const prior = process.env.CPA_TEST_KEY; process.env.CPA_TEST_KEY = 'SYNTHETIC_KEY';
  try {
    const config = makeGateway({ endpoint: gateway.endpoint });
    const dir = await mkdtemp(join(tmpdir(), 'cpa-cache-'));
    const first = await openGateway('test-proxy', config, dir);
    const registry = createModels(); registry.setProvider(first.provider);
    await registry.refresh({ force: true });
    const offline = await openGateway('test-proxy', config, dir);
    const secondRegistry = createModels(); secondRegistry.setProvider(offline.provider);
    const count = gateway.count();
    await secondRegistry.refresh({ allowNetwork: false });
    assert.equal(gateway.count(), count);
    assert.equal(offline.health.source, 'cache');
    assert.equal(secondRegistry.getModels('test-proxy').length, 2);
    gateway.setFail(401);
    const failed = await registry.refresh({ force: true });
    assert.equal(failed.errors.size, 1);
    assert.equal(first.health.error, 'catalogue_http_401');
    assert.equal(registry.getModels('test-proxy').length, 2);
    assert.ok(![...failed.errors.values()].some((error) => error.message.includes('PRIVATE_BODY')));
  } finally {
    if (prior === undefined) delete process.env.CPA_TEST_KEY; else process.env.CPA_TEST_KEY = prior;
    await gateway.close();
  }
});
test('catalogue redirects are blocked without forwarding credentials', async () => {
  let targetHit = false;
  const target = createServer((_req, res) => { targetHit = true; res.end(); }); target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const redirect = createServer((_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${(target.address() as { port: number }).port}/` }); res.end(); });
  redirect.listen(0, '127.0.0.1'); await once(redirect, 'listening');
  try {
    const endpoint = `http://127.0.0.1:${(redirect.address() as { port: number }).port}`;
    await assert.rejects(() => requestListing(makeGateway({ endpoint }), 'SYNTHETIC_KEY', new AbortController().signal), /catalogue_network_failed/);
    assert.equal(targetHit, false);
  } finally {
    target.closeAllConnections(); redirect.closeAllConnections(); target.close(); redirect.close();
  }
});
