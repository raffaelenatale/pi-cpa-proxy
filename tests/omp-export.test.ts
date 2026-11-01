import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { deriveCatalogue } from '../src/catalogue.ts';
import { ompModelsYml } from '../src/omp-export.ts';
import { parseArguments, run } from '../src/omp-cli.ts';
import { makeGateway } from './fixtures.ts';

test('models.yml references the credential and materialises per-model limits', () => {
  const gateway = makeGateway({ credential: { kind: 'file', path: '/home/u/.config/pi-cpa/api-key' } });
  const models = deriveCatalogue('test-proxy', gateway, [{ id: 'primary' }, { id: 'role' }]).models;
  const yaml = ompModelsYml('test-proxy', gateway, models);
  assert.match(yaml, /^# managed-by: pi-cpa-proxy connection test-proxy\./);
  assert.match(yaml, /apiKey: "!cat \/home\/u\/\.config\/pi-cpa\/api-key"/);
  assert.match(yaml, /contextWindow: 200000/);
  assert.match(yaml, /maxTokens: 64000/);
  assert.ok(yaml.includes('id: role'));
});

test('an environment credential is exported as the variable name, never a value', () => {
  process.env.CPA_TEST_KEY = 'sk-secret-value';
  const gateway = makeGateway();
  const yaml = ompModelsYml('test-proxy', gateway, deriveCatalogue('test-proxy', gateway, [{ id: 'primary' }]).models);
  assert.match(yaml, /apiKey: CPA_TEST_KEY/);
  assert.ok(!yaml.includes('sk-secret-value'));
});

test('unknown arguments and missing values are refused', () => {
  assert.throws(() => parseArguments(['--bogus']), /omp_cli_unknown_argument/);
  assert.throws(() => parseArguments(['--connection']), /omp_cli_missing_value/);
  assert.equal(parseArguments(['--write', '--force']).write, true);
});

test('CLI previews, writes a managed file, refuses an unmanaged one unless forced', async () => {
  process.env.CPA_TEST_KEY = 'sk-test';
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'primary' }, { id: 'backup' }] }));
  });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  try {
    const port = (server.address() as AddressInfo).port;
    const directory = await mkdtemp(join(tmpdir(), 'omp-cli-'));
    const bundled = join(directory, 'config.yaml');
    await writeFile(bundled, `schemaVersion: 1
connections:
  test-proxy:
    endpoint: http://127.0.0.1:${port}
    allowInsecureHttp: true
    credential: { kind: env, name: CPA_TEST_KEY }
    builtinCatalog: false
    models:
      primary: { contextWindow: 200000, maxTokens: 64000, input: [text], reasoning: true, cost: { input: 1, output: 4, cacheRead: 0.3, cacheWrite: 0 } }
      backup: { contextWindow: 100000, maxTokens: 32000, input: [text], reasoning: false, cost: { input: 1, output: 4, cacheRead: 0.3, cacheWrite: 0 } }
`);
    const base = ['--bundled', bundled, '--local', join(directory, 'none.yaml'), '--agent-dir', directory];
    let printed = '';
    await run(base, (text) => { printed += text; });
    assert.ok(printed.includes('id: primary') && printed.includes('id: backup'));
    assert.deepEqual((await readdir(directory)).includes('models.yml'), false);

    await run([...base, '--write'], () => {});
    assert.match(await readFile(join(directory, 'models.yml'), 'utf8'), /managed-by: pi-cpa-proxy/);

    await writeFile(join(directory, 'models.yml'), 'providers: {}\n');
    await assert.rejects(run([...base, '--write'], () => {}), /omp_target_not_managed/);
    assert.equal(await readFile(join(directory, 'models.yml'), 'utf8'), 'providers: {}\n');
    await run([...base, '--write', '--force'], () => {});
    assert.match(await readFile(join(directory, 'models.yml'), 'utf8'), /managed-by: pi-cpa-proxy/);
  } finally { server.close(); }
});
