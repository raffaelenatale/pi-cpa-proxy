import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { command, isolatedEnvironment, recordEvidence } from './process.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const sandbox = await mkdtemp(join(tmpdir(), 'pi-cpa-probe-'));
let adminRequests = 0;
const server = createServer((req, res) => {
  if (req.url?.startsWith('/v0/management') || req.url?.startsWith('/v8/management')) { adminRequests++; res.writeHead(500); res.end(); return; }
  assert.equal(req.headers.authorization, 'Bearer SYNTHETIC_PROBE');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ data: [{ id: 'sample-alias' }] }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
try {
  const env = isolatedEnvironment(join(sandbox, 'home'), { CPA_TEST_KEY: 'SYNTHETIC_PROBE' });
  const directory = join(env.PI_CODING_AGENT_DIR!, 'pi-cpa-proxy');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'config.yaml');
  const config = stringify({ schemaVersion: 1, connections: { 'synthetic-cpa': {
    endpoint, allowInsecureHttp: true, builtinCatalog: false, credential: { kind: 'env', name: 'CPA_TEST_KEY' },
    admin: { kind: 'manager-plus', endpoint, allowInsecureHttp: true, credential: { kind: 'env', name: 'NOT_SET_SYNTHETIC_ADMIN' } },
    serverAdmin: { kind: 'cli-proxy-api-v8', endpoint, allowInsecureHttp: true, credential: { kind: 'env', name: 'NOT_SET_SYNTHETIC_SERVER_ADMIN' } },
    models: { 'sample-alias': { contextWindow: 1000000, maxTokens: 65536, reasoning: true, input: ['text'],
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, compat: { supportsDeveloperRole: false } } },
  } } });
  await writeFile(path, config, { mode: 0o600 });
  const packedName = (await command('npm', ['pack', '--pack-destination', sandbox], { cwd: root })).trim().split('\n').at(-1)!;
  const archive = join(sandbox, packedName);
  const inventory = await command('tar', ['-tzf', archive], { cwd: sandbox });
  assert.doesNotMatch(inventory, /package\/(?:tests|scripts|node_modules|config\.yaml|\.artifacts)/);
  await command('tar', ['-xzf', archive], { cwd: sandbox });
  const packaged = join(sandbox, 'package');
  await command('npm', ['install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], { cwd: packaged, env, timeoutMs: 120000 });
  const args = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '-e', packaged, '--list-models', 'synthetic-cpa'];
  const output = await command('pi', args, { cwd: sandbox, env });
  assert.match(output, /sample-alias/); assert.match(output, /1M/); assert.doesNotMatch(output, /128K/);
  assert.equal(await readFile(path, 'utf8'), config);
  const offline = await command('pi', [...args, '--offline'], { cwd: sandbox, env });
  assert.match(offline, /sample-alias/);
  const emptyEnv = isolatedEnvironment(join(sandbox, 'empty-home'));
  const noConfig = await command('pi', [...args.slice(0, -2), '--list-models', 'synthetic-cpa'], { cwd: sandbox, env: emptyEnv });
  assert.doesNotMatch(noConfig, /sample-alias/);
  assert.equal(adminRequests, 0);
  const evidence = await recordEvidence(root, 'pi-probe', { status: 'passed', sandbox, checks: ['public tarball allowlist', 'CLI loads packed native provider', '1M alias metadata', 'offline raw cache', 'config unchanged', 'missing config nonblocking', 'configured admin not contacted at startup'], inventory, output });
  console.log(`PI_PROBE OK evidence=${evidence}`);
} catch (error) {
  const evidence = await recordEvidence(root, 'pi-probe', { status: 'failed', sandbox, error: String(error) });
  console.error(`PI_PROBE ERROR origin=scripts/probe-pi.ts recovery=inspect_synthetic_evidence diagnostic=${evidence}`);
  process.exitCode = 1;
} finally {
  server.closeAllConnections(); server.close();
}
