import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfiguration } from '../src/configuration.ts';
import { desiredWebSearchSettings, syncPiWebAccess, webAccessCredentialSource, webSearchConfigPath } from '../src/integrations.ts';
import { makeGateway } from './fixtures.ts';

const settings = { connection: 'test-proxy', searchModel: 'gemini-3.8-flash-high', defaultProvider: true };
const temp = () => mkdtemp(join(tmpdir(), 'cpa-websearch-'));
const withIntegration = (block: unknown) => ({ schemaVersion: 1, connections: { 'test-proxy': makeGateway() }, integrations: { piWebAccess: block } });

test('schema accepts the integration and defaults defaultProvider to false', () => {
  const parsed = validateConfiguration(withIntegration({ connection: 'test-proxy', searchModel: 'gemini-3.8-flash-high' }));
  assert.deepEqual(parsed.integrations?.piWebAccess, { connection: 'test-proxy', searchModel: 'gemini-3.8-flash-high', defaultProvider: false });
  assert.equal(validateConfiguration({ schemaVersion: 1, connections: { 'test-proxy': makeGateway() } }).integrations, undefined);
});
test('schema rejects unknown connection, extra keys and unsafe model ids', () => {
  assert.throws(() => validateConfiguration(withIntegration({ connection: 'missing', searchModel: 'm' })), /config_schema_invalid|unknown_connection/);
  assert.throws(() => validateConfiguration(withIntegration({ connection: 'test-proxy', searchModel: 'm', apiKey: 'NEVER' })));
  assert.throws(() => validateConfiguration(withIntegration({ connection: 'test-proxy', searchModel: 'bad model;rm' })));
});

test('credential references map to pi-web-access sources', () => {
  assert.equal(webAccessCredentialSource({ kind: 'env', name: 'CPA_TEST_KEY' }), '$CPA_TEST_KEY');
  assert.equal(webAccessCredentialSource({ kind: 'file', path: '/keys/api-key' }), "!cat -- '/keys/api-key'");
  if (process.platform === 'darwin') {
    assert.equal(webAccessCredentialSource({ kind: 'keychain', service: 'svc', account: 'acc' }), "!security find-generic-password -a 'acc' -s 'svc' -w");
  } else assert.throws(() => webAccessCredentialSource({ kind: 'keychain', service: 'svc', account: 'acc' }), /keychain_platform_unsupported/);
});
test('the generated file command really yields the key, even for awkward paths', async () => {
  const dir = await temp(), folder = join(dir, "it's a dir");
  await mkdir(folder);
  await writeFile(join(folder, 'api-key'), 'SECRET-VALUE\n', { mode: 0o600 });
  const command = webAccessCredentialSource({ kind: 'file', path: join(folder, 'api-key') });
  assert.ok(command.startsWith('!'));
  assert.equal(execSync(command.slice(1), { encoding: 'utf8' }).trim(), 'SECRET-VALUE');
});
test('shell metacharacters in a path stay literal', async () => {
  const dir = await temp(), name = 'a;$(touch pwned)`b';
  await mkdir(join(dir, name));
  await writeFile(join(dir, name, 'k'), 'K1');
  const command = webAccessCredentialSource({ kind: 'file', path: join(dir, name, 'k') });
  assert.equal(execSync(command.slice(1), { encoding: 'utf8', cwd: dir }), 'K1');
  await assert.rejects(() => stat(join(dir, 'pwned')));
});
test('control characters in a reference are refused', () => {
  assert.throws(() => webAccessCredentialSource({ kind: 'file', path: '/tmp/a\nb' }), /web_search_reference_invalid/);
});

test('config path mirrors pi-web-access lookup', async () => {
  const home = await temp(), none = () => false;
  assert.equal(webSearchConfigPath({ PI_CODING_AGENT_DIR: '/x' }, home, none), '/x/web-search.json');
  assert.equal(webSearchConfigPath({}, home, none), join(home, '.pi', 'agent', 'web-search.json'));
  assert.equal(webSearchConfigPath({}, home, (p) => p === join(home, '.pi', 'web-search.json')), join(home, '.pi', 'web-search.json'));
  assert.equal(webSearchConfigPath({ XDG_CONFIG_HOME: '/xdg' }, home, none), '/xdg/pi/web-search.json');
  assert.equal(webSearchConfigPath({ XDG_CONFIG_HOME: '/xdg' }, home, (p) => p === '/xdg/pi/web-search.json'), '/xdg/pi/web-search.json');
});

const gateway = (path: string) => makeGateway({ endpoint: 'http://127.0.0.1:8317/', credential: { kind: 'file', path } });
test('desired settings use the endpoint origin and never contain the key', () => {
  const desired = desiredWebSearchSettings(settings, gateway('/keys/api-key'));
  assert.deepEqual(desired, { geminiBaseUrl: 'http://127.0.0.1:8317', geminiApiKey: "!cat -- '/keys/api-key'", searchModel: 'gemini-3.8-flash-high', provider: 'gemini' });
  assert.equal('provider' in desiredWebSearchSettings({ ...settings, defaultProvider: false }, gateway('/k')), false);
});

test('creates the file, preserves other keys, is idempotent and leaves no backups when unchanged', async () => {
  const dir = await temp(), path = join(dir, 'web-search.json'), key = join(dir, 'api-key');
  await writeFile(key, 'TOP-SECRET', { mode: 0o600 });
  const g = gateway(key);
  assert.equal((await syncPiWebAccess(settings, g, path)).status, 'created');
  assert.equal((await stat(path)).mode & 0o077, 0);
  const written = await readFile(path, 'utf8');
  assert.ok(!written.includes('TOP-SECRET'));
  assert.equal(JSON.parse(written).provider, 'gemini');
  await writeFile(path, JSON.stringify({ ...JSON.parse(written), provider: 'all', exaApiKey: 'keep-me', searchRouting: { providers: ['exa'] } }, null, 2));
  assert.equal((await syncPiWebAccess(settings, g, path)).status, 'updated');
  const merged = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(merged.provider, 'gemini');
  assert.equal(merged.exaApiKey, 'keep-me');
  assert.deepEqual(merged.searchRouting, { providers: ['exa'] });
  const before = await readdir(dir);
  assert.equal((await syncPiWebAccess(settings, g, path)).status, 'unchanged');
  assert.deepEqual(await readdir(dir), before);
});
test('without defaultProvider an existing provider choice is preserved', async () => {
  const dir = await temp(), path = join(dir, 'web-search.json');
  await writeFile(path, JSON.stringify({ provider: 'brave' }));
  await syncPiWebAccess({ ...settings, defaultProvider: false }, gateway(join(dir, 'k')), path);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).provider, 'brave');
});
test('a file that is not a strict JSON object is never modified', async () => {
  const dir = await temp(), path = join(dir, 'web-search.json');
  for (const content of ['{ "provider": "all", // comment\n}', '[1,2]', '', 'null']) {
    await writeFile(path, content);
    await assert.rejects(() => syncPiWebAccess(settings, gateway('/k'), path), /web_search_config_invalid/);
    assert.equal(await readFile(path, 'utf8'), content);
  }
});
test('an unreadable path is reported with a fixed code', async () => {
  const dir = await temp();
  await assert.rejects(() => syncPiWebAccess(settings, gateway('/k'), dir), /web_search_config_unreadable/);
});
