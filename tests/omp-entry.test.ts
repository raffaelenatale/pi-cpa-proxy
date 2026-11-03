import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import ompEntry from '../src/omp-entry.ts';

type Registration = [string, Record<string, unknown>];

async function startGateway(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    // Chat Completions (search tools) answer with a cited text; every other request is the model listing.
    if (request.method === 'POST') response.end(JSON.stringify({ model: 'grounded-model', choices: [{ message: { content: 'Bun is at 1.4.4. Sources: [Bun blog](https://bun.example/blog)' } }] }));
    else response.end(JSON.stringify({ data: [{ id: 'primary' }, { id: 'unconfigured' }] }));
  });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  return { server, port: (server.address() as AddressInfo).port };
}

type Registered = { providers: Registration[]; tools: Record<string, unknown>[] };

async function withConfiguration<T>(port: number, extra: string, body: (directory: string, register: () => Promise<Registered>) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'omp-entry-'));
  const config = join(directory, 'config.yaml');
  await writeFile(config, `schemaVersion: 1
connections:
  test-proxy:
    endpoint: http://127.0.0.1:${port}
    allowInsecureHttp: true
    credential: { kind: env, name: CPA_TEST_KEY }
    builtinCatalog: false
    models:
      primary: { contextWindow: 200000, maxTokens: 64000, input: [text], reasoning: true, cost: { input: 1, output: 4, cacheRead: 0.3, cacheWrite: 0 } }
${extra}`);
  const saved = { config: process.env.CPA_PROXY_CONFIG, agent: process.env.OMP_AGENT_DIR, key: process.env.CPA_TEST_KEY };
  Object.assign(process.env, { CPA_PROXY_CONFIG: config, OMP_AGENT_DIR: directory, CPA_TEST_KEY: 'sk-test' });
  try {
    return await body(directory, async () => {
      const registered: Registered = { providers: [], tools: [] };
      await ompEntry({ registerProvider: (name, provider) => { registered.providers.push([name, provider]); }, registerTool: (tool) => { registered.tools.push(tool); } });
      return registered;
    });
  } finally {
    for (const [name, value] of [['CPA_PROXY_CONFIG', saved.config], ['OMP_AGENT_DIR', saved.agent], ['CPA_TEST_KEY', saved.key]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

test('registers the configured connection with enriched models; ids without metadata are left out; the key stays a reference', async () => {
  const { server, port } = await startGateway();
  try {
    await withConfiguration(port, '', async (_directory, register) => {
      const { providers: [[name, provider]], tools } = await register();
      assert.equal(name, 'test-proxy');
      assert.equal(provider.baseUrl, `http://127.0.0.1:${port}`);
      assert.equal(provider.apiKey, 'CPA_TEST_KEY');
      const models = provider.models as { id: string; contextWindow: number; maxTokens: number }[];
      assert.deepEqual(models.map((model) => [model.id, model.contextWindow, model.maxTokens]), [['primary', 200000, 64000]]);
      assert.deepEqual(tools.map((tool) => tool.name), ['cpa_profile_map']);
    });
  } finally { server.close(); }
});

test('a gateway that is down falls back to the listing cached by the last live run', async () => {
  const { server, port } = await startGateway();
  await withConfiguration(port, '', async (directory, register) => {
    assert.equal((await register()).providers.length, 1);
    assert.equal((await readdir(join(directory, 'pi-cpa-proxy', 'cache'))).length, 1);
    server.close();
    const { providers: [[, provider]] } = await register();
    assert.deepEqual((provider.models as { id: string }[]).map((model) => model.id), ['primary']);
  });
});

test('a gateway that is down with no cache registers nothing and does not throw', async () => {
  const { server, port } = await startGateway();
  server.close();
  await withConfiguration(port, '', async (_directory, register) => {
    assert.deepEqual((await register()).providers, []);
  });
});

const webIntegrations = (searchModel: string) => `integrations:
  piWebAccess: { connection: test-proxy, searchModel: ${searchModel} }
  searchTools:
    grounded_search: { connection: test-proxy, model: grounded-model, timeoutMs: 5000 }
`;

test('piWebAccess adds a google-generative-ai provider under /v1beta for omp\'s web role', async () => {
  const { server, port } = await startGateway();
  try {
    await withConfiguration(port, webIntegrations('primary'), async (_directory, register) => {
      const { providers } = await register();
      assert.deepEqual(providers.map(([name]) => name), ['test-proxy', 'test-proxy-gemini']);
      const search = providers[1][1];
      assert.equal(search.api, 'google-generative-ai');
      assert.equal(search.baseUrl, `http://127.0.0.1:${port}/v1beta`);
      assert.equal(search.apiKey, 'CPA_TEST_KEY');
      const [model] = search.models as { id: string; api: string; baseUrl: string }[];
      assert.deepEqual([model.id, model.api, model.baseUrl], ['primary', 'google-generative-ai', `http://127.0.0.1:${port}/v1beta`]);
    });
  } finally { server.close(); }
});

test('a search model missing from the catalogue registers no grounding provider and keeps the rest', async (t) => {
  const { server, port } = await startGateway();
  const errors = t.mock.method(console, 'error', () => {});
  try {
    await withConfiguration(port, webIntegrations('unconfigured'), async (_directory, register) => {
      const { providers, tools } = await register();
      assert.deepEqual(providers.map(([name]) => name), ['test-proxy']);
      assert.deepEqual(tools.map((tool) => tool.name), ['cpa_profile_map', 'grounded_search']);
      assert.match(String(errors.mock.calls[0].arguments[0]), /unconfigured is not in the test-proxy catalogue/);
    });
  } finally { server.close(); }
});

test('searchTools are registered read-only and answer through the connection with the sources extracted', async () => {
  const { server, port } = await startGateway();
  try {
    await withConfiguration(port, webIntegrations('primary'), async (_directory, register) => {
      const tool = (await register()).tools.find((candidate) => candidate.name === 'grounded_search')!;
      assert.equal(tool.name, 'grounded_search');
      assert.equal(tool.approval, 'read');
      const execute = tool.execute as (id: string, params: { query: string }, signal: undefined, onUpdate: undefined) => Promise<{ content: { text: string }[]; details: { sources?: { url: string }[]; error?: string } }>;
      const result = await execute('call-1', { query: 'bun version' }, undefined, undefined);
      assert.equal(result.details.error, undefined);
      assert.match(result.content[0].text, /Bun is at 1\.4\.4/);
      assert.deepEqual(result.details.sources?.map((source) => source.url), ['https://bun.example/blog']);
    });
  } finally { server.close(); }
});

test('cpa_profile_map is a read-only tool that lists the configured profiles, even when the gateway is down', async () => {
  const { server, port } = await startGateway();
  server.close();
  const profiles = `    profiles:
      profile-a: { members: [primary], description: Main work }
`;
  await withConfiguration(port, profiles, async (_directory, register) => {
    const { providers, tools: [tool] } = await register();
    assert.deepEqual(providers, []);
    assert.equal(tool.name, 'cpa_profile_map');
    assert.equal(tool.approval, 'read');
    const result = await (tool.execute as () => Promise<{ content: { text: string }[]; details: { connections?: { id: string }[]; error?: string } }>)();
    assert.equal(result.details.error, undefined);
    assert.deepEqual(result.details.connections?.map(({ id }) => id), ['test-proxy']);
    assert.match(result.content[0].text, /`test-proxy\/profile-a`[\s\S]*\| profile-a \| primary \| nessuno \| 200\.000 \|.*\| Main work \|/);
  });
});
