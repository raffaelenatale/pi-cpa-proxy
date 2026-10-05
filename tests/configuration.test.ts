import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, symlink, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { decodeYaml, overlay, readLayers, saveLocalLayer, validateConfiguration, writePrivateFile, safeFailure, expandUserPath } from '../src/configuration.ts';
import { resolveSecret } from '../src/credentials.ts';
import { makeGateway } from './fixtures.ts';

const cfg = () => ({ schemaVersion: 1, connections: { 'test-proxy': makeGateway() } });
test('valid YAML and JSON use the same schema', () => {
  assert.deepEqual(validateConfiguration(decodeYaml(stringify(cfg()))), validateConfiguration(decodeYaml(JSON.stringify(cfg()))));
});
for (const [name, yaml] of [
  ['duplicate', 'schemaVersion: 1\nschemaVersion: 1'],
  ['custom-tag', 'key: !execute command'],
  ['aliases', 'a: &a {x: 1}\nb: *a'],
  ['prototype', '__proto__: {x: 1}'],
  ['list-root', '[1, 2]'],
  ['large', 'x'.repeat(262145)],
] as const) test(`reject YAML ${name}`, () => assert.throws(() => decodeYaml(yaml)));

test('strict schema rejects typo, future version and inline secret', () => {
  assert.throws(() => validateConfiguration({ ...cfg(), schemaVersion: 2 }));
  assert.throws(() => validateConfiguration({ ...cfg(), apiKey: 'DO_NOT_LOG' }));
  assert.throws(() => makeGateway({ credential: { kind: 'env', name: 'KEY', value: 'DO_NOT_LOG' } }));
});
for (const endpoint of ['http://127.0.0.1:8317', 'https://user:password@example.test', 'https://example.test/v1', 'file:///tmp/config', 'https://example.test/?key=secret']) {
  test(`endpoint rejects unsafe form ${endpoint.split(':')[0]}`, () => assert.throws(() => makeGateway({ endpoint, allowInsecureHttp: false })));
}
test('merge maps, replace lists, delete keys, preserve null thinking levels', () => {
  const base = { models: { one: { input: ['text', 'image'], thinkingLevelMap: { low: 'low', high: 'high' } }, two: {} } };
  assert.deepEqual(overlay(base, { models: { one: { input: ['text'], thinkingLevelMap: { low: null } }, two: null } }), {
    models: { one: { input: ['text'], thinkingLevelMap: { low: null, high: 'high' } } },
  });
  assert.ok(Object.hasOwn(base.models, 'two'));
});
test('private config changes take effect while override persists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cpa-layers-'));
  const bundled = join(dir, 'bundled.yaml'), local = join(dir, 'local.yaml');
  await writePrivateFile(bundled, stringify(cfg()));
  const layer = { connections: { 'test-proxy': { timeoutMs: 2000 } } };
  await saveLocalLayer(local, layer, cfg(), null);
  const before = await readFile(local, 'utf8');
  await writePrivateFile(bundled, stringify({ ...cfg(), revision: 'second' }));
  const result = await readLayers(bundled, local);
  assert.equal(result.config?.revision, 'second');
  assert.equal(result.config?.connections['test-proxy'].timeoutMs, 2000);
  assert.equal(await readFile(local, 'utf8'), before);
});
test('empty installation has no invented model or endpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cpa-empty-'));
  assert.equal((await readLayers(join(dir, 'a'), join(dir, 'b'))).config, undefined);
});
test('atomic config has restricted permissions, backup and conflict rejection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cpa-write-')), path = join(dir, 'config.yaml');
  await writePrivateFile(path, 'first', null);
  await assert.rejects(() => writePrivateFile(path, 'second', 'wrong'), /concurrent_file_change/);
  assert.equal(await readFile(path, 'utf8'), 'first');
  await writePrivateFile(path, 'second', 'first');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await readdir(dir)).filter((s) => s.includes('backup')).length, 1);
  const link = join(dir, 'link'); await symlink(path, link);
  await assert.rejects(() => writePrivateFile(link, 'evil'), /unsafe_file_target/);
});
test('credentials: reference resolution, absence, unsafe file and no leakage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cpa-secret-')), path = join(dir, 'key');
  await writeFile(path, 'TEST_SECRET', { mode: 0o600 });
  assert.equal(await resolveSecret({ kind: 'file', path }), 'TEST_SECRET');
  assert.equal(await resolveSecret({ kind: 'file', path: join(dir, 'absent') }), undefined);
  await chmod(path, 0o644);
  await assert.rejects(() => resolveSecret({ kind: 'file', path }), /credential_permissions_unsafe/);
  assert.equal(safeFailure(new Error('Bearer TEST_SECRET')), 'unexpected_failure');
});
test('relative credential/config paths cannot depend on cwd', () => {
  assert.throws(() => expandUserPath('relative/file'), /path_must_be_absolute/);
  assert.equal(expandUserPath('~/file', '/test-home'), '/test-home/file');
});
