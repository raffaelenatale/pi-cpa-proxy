import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { makeGateway } from './fixtures.ts';
import { checkSetupConnection, setupCheckSummary } from '../src/setup-check.ts';
import { runSetup } from '../src/setup.ts';
import { readLayers, writePrivateFile } from '../src/configuration.ts';

const keyName = 'CPA_SETUP_CHECK_TEST_KEY';
const key = 'SYNTHETIC_SETUP_SECRET';
async function fixture() {
  const paths: string[] = [];
  let mode = 'normal';
  const server = createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    assert.equal(req.url, '/v1/models'); assert.equal(req.method, 'GET');
    if (mode === 'hang') return;
    if (mode === 'auth') { res.writeHead(401); res.end(key); return; }
    if (mode === 'malformed') { res.end(key); return; }
    if (mode === 'redirect') { res.writeHead(302, { Location: '/forbidden' }); res.end(); return; }
    res.end(JSON.stringify({ data: [{ id: 'primary' }, { id: 'primary' }, { id: 'unknown' }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const previous = process.env[keyName]; process.env[keyName] = key;
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { paths, endpoint, setMode: (value: string) => { mode = value; },
    connection: makeGateway({ endpoint, credential: { kind: 'env', name: keyName }, timeoutMs: 100 }),
    async close() {
      if (previous === undefined) delete process.env[keyName]; else process.env[keyName] = previous;
      server.closeAllConnections(); server.close(); await once(server, 'close');
    } };
}
const signal = () => AbortSignal.timeout(10000);

test('setup check reports unique listed/usable/omitted counts with no IDs or secret output', async () => {
  const f = await fixture();
  try {
    const result = await checkSetupConnection('test-proxy', f.connection, signal());
    assert.deepEqual(result, { ok: true, listed: 2, usable: 1, omitted: 1, missingProfiles: 1 });
    assert.deepEqual(f.paths, ['GET /v1/models']);
    assert.doesNotMatch(JSON.stringify(result) + setupCheckSummary(result), /SYNTHETIC_SETUP_SECRET|primary/);
  } finally { await f.close(); }
});
test('missing credential and cancelled setup checks send no requests', async () => {
  const f = await fixture();
  try {
    delete process.env[keyName];
    assert.deepEqual(await checkSetupConnection('test-proxy', f.connection, signal()), { ok: false, code: 'credential_missing' });
    const controller = new AbortController(); controller.abort();
    assert.deepEqual(await checkSetupConnection('test-proxy', f.connection, controller.signal), { ok: false, code: 'setup_check_aborted' });
    assert.deepEqual(f.paths, []);
  } finally { await f.close(); }
});
for (const [mode, code] of [['auth', 'catalogue_http_401'], ['malformed', 'catalogue_body_invalid'],
  ['redirect', 'catalogue_network_failed'], ['hang', 'catalogue_network_failed']] as const) {
  test(`setup discovery ${mode} fails redacted and never contacts redirected/admin endpoints`, async () => {
    const f = await fixture();
    try {
      f.setMode(mode);
      const result = await checkSetupConnection('test-proxy', f.connection, signal());
      assert.deepEqual(result, { ok: false, code });
      assert.doesNotMatch(setupCheckSummary(result), new RegExp(key));
      assert.deepEqual(f.paths, ['GET /v1/models']);
    } finally { await f.close(); }
  });
}

test('setup wizard saves selected protocol only after explicit discovery and save approval', async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'cpa-setup-check-'));
  const local = join(directory, 'config.yaml');
  const bundled = join(directory, 'absent');
  try {
    // Existing models, profile and unavailable admin references must survive editing without admin requests.
    const config = { schemaVersion: 1, connections: { 'test-proxy': { ...f.connection,
      serverAdmin: { kind: 'cli-proxy-api-v8', endpoint: f.endpoint, allowInsecureHttp: true,
        credential: { kind: 'env', name: 'UNAVAILABLE_SETUP_ADMIN' } } } } };
    await writePrivateFile(local, stringify(config));
    const inputs = ['test-proxy', f.endpoint, keyName];
    const choices = ['Connection wizard', 'openai-responses', 'Environment variable', 'Check connection before saving'];
    const notices: string[] = [];
    const confirmations = [true, true];
    const before = await readFile(local, 'utf8');
    const ctx = { hasUI: true, waitForIdle: async () => {}, ui: {
      input: async () => inputs.shift(), select: async () => choices.shift(),
      notify: (text: string) => { notices.push(text); },
      confirm: async (title: string) => {
        if (title === 'Save CPA configuration?') {
          assert.deepEqual(f.paths, ['GET /v1/models']);
          assert.equal(await readFile(local, 'utf8'), before);
        }
        return confirmations.shift() ?? false;
      },
    } } as unknown as ExtensionCommandContext;
    assert.equal(await runSetup(ctx, bundled, local), true);
    const saved = (await readLayers(bundled, local)).config!.connections['test-proxy'];
    assert.equal(saved.api, 'openai-responses'); assert.deepEqual(saved.models, f.connection.models);
    assert.equal(saved.serverAdmin!.credential.kind, 'env');
    assert.match(notices.join('\n'), /listed=2; usable=1; omitted=1/);
    assert.doesNotMatch(notices.join('\n') + await readFile(local, 'utf8'), new RegExp(key));
    assert.ok((await readdir(directory)).every((file) => !file.includes('cache') && !file.includes('state')));
  } finally { await f.close(); }
});
test('failed setup check does not save when final confirmation is declined', async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'cpa-setup-check-'));
  const local = join(directory, 'config.yaml');
  try {
    f.setMode('auth');
    const original = stringify({ schemaVersion: 1, connections: { 'test-proxy': f.connection } });
    await writePrivateFile(local, original);
    const choices = ['Advanced YAML override editor', 'Check connection before saving'];
    const notices: string[] = [];
    const ctx = { hasUI: true, waitForIdle: async () => {}, ui: {
      select: async () => choices.shift(), editor: async () => original, confirm: async () => false,
      notify: (text: string) => { notices.push(text); },
    } } as unknown as ExtensionCommandContext;
    assert.equal(await runSetup(ctx, join(directory, 'absent'), local), false);
    assert.equal(await readFile(local, 'utf8'), original);
    assert.match(notices.join('\n'), /catalogue_http_401/); assert.doesNotMatch(notices.join('\n'), new RegExp(key));
  } finally { await f.close(); }
});
test('skipping or cancelling discovery check sends zero requests', async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'cpa-setup-check-'));
  const local = join(directory, 'config.yaml');
  try {
    const text = stringify({ schemaVersion: 1, connections: { 'test-proxy': f.connection } });
    for (const mode of [undefined, 'Save without connection check']) {
      const choices = ['Advanced YAML override editor', mode];
      const ctx = { hasUI: true, waitForIdle: async () => {}, ui: {
        select: async () => choices.shift(), editor: async () => text, confirm: async () => true,
      } } as unknown as ExtensionCommandContext;
      assert.equal(await runSetup(ctx, join(directory, 'absent'), local), mode !== undefined);
      assert.deepEqual(f.paths, []);
    }
  } finally { await f.close(); }
});
