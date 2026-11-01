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
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'primary' }, { id: 'unconfigured' }] }));
  });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  return { server, port: (server.address() as AddressInfo).port };
}

async function withConfiguration<T>(port: number, body: (directory: string, register: () => Promise<Registration[]>) => Promise<T>): Promise<T> {
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
`);
  const saved = { config: process.env.CPA_PROXY_CONFIG, agent: process.env.OMP_AGENT_DIR, key: process.env.CPA_TEST_KEY };
  Object.assign(process.env, { CPA_PROXY_CONFIG: config, OMP_AGENT_DIR: directory, CPA_TEST_KEY: 'sk-test' });
  try {
    return await body(directory, async () => {
      const registered: Registration[] = [];
      await ompEntry({ registerProvider: (name, provider) => { registered.push([name, provider]); } });
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
    await withConfiguration(port, async (_directory, register) => {
      const [[name, provider]] = await register();
      assert.equal(name, 'test-proxy');
      assert.equal(provider.baseUrl, `http://127.0.0.1:${port}`);
      assert.equal(provider.apiKey, 'CPA_TEST_KEY');
      const models = provider.models as { id: string; contextWindow: number; maxTokens: number }[];
      assert.deepEqual(models.map((model) => [model.id, model.contextWindow, model.maxTokens]), [['primary', 200000, 64000]]);
    });
  } finally { server.close(); }
});

test('a gateway that is down falls back to the listing cached by the last live run', async () => {
  const { server, port } = await startGateway();
  await withConfiguration(port, async (directory, register) => {
    assert.equal((await register()).length, 1);
    assert.equal((await readdir(join(directory, 'pi-cpa-proxy', 'cache'))).length, 1);
    server.close();
    const [[, provider]] = await register();
    assert.deepEqual((provider.models as { id: string }[]).map((model) => model.id), ['primary']);
  });
});

test('a gateway that is down with no cache registers nothing and does not throw', async () => {
  const { server, port } = await startGateway();
  server.close();
  await withConfiguration(port, async (_directory, register) => {
    assert.deepEqual(await register(), []);
  });
});
