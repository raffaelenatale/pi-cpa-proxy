import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { assemblePrivate } from '../scripts/assemble-private.ts';
import { makeGateway } from './fixtures.ts';
const root = fileURLToPath(new URL('..', import.meta.url));

test('private bundle contains identical runtime, separate config and publish protection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cpa-bundle-')), input = join(dir, 'input.yaml'), output = join(dir, 'bundle');
  const config = stringify({ schemaVersion: 1, connections: { 'test-proxy': makeGateway() } });
  await writeFile(input, config);
  await assemblePrivate(input, output);
  const publicManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const privateManifest = JSON.parse(await readFile(join(output, 'package.json'), 'utf8'));
  assert.equal(privateManifest.private, true);
  assert.notEqual(privateManifest.name, publicManifest.name);
  assert.equal(privateManifest.version, publicManifest.version);
  assert.ok(privateManifest.files.includes('config.yaml'));
  assert.equal(privateManifest.devDependencies, undefined);
  assert.equal(await readFile(join(output, 'config.yaml'), 'utf8'), config);
  for (const path of await readdir(join(root, 'src'))) {
    assert.equal(await readFile(join(output, 'src', path), 'utf8'), await readFile(join(root, 'src', path), 'utf8'));
  }
  assert.equal((await readdir(output)).includes('node_modules'), false);
  await assert.rejects(() => assemblePrivate(input, output), /destination_already_exists/);
});
test('private bundling rejects inline secrets before creating output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cpa-bundle-')), input = join(dir, 'input.yaml'), output = join(dir, 'bundle');
  await writeFile(input, 'schemaVersion: 1\nconnections: {}\napiKey: NEVER_PUBLISH\n');
  await assert.rejects(() => assemblePrivate(input, output), /config_schema_invalid/);
  await assert.rejects(() => readdir(output));
});
