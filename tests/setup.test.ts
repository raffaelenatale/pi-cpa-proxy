import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { runSetup } from '../src/setup.ts';
import { readLayers, writePrivateFile } from '../src/configuration.ts';
import { makeGateway } from './fixtures.ts';
import { wireApis } from '../src/schema.ts';

function uiContext(inputs: (string | undefined)[], choices: (string | undefined)[], confirmations: boolean[], editorValue?: string): ExtensionCommandContext {
  return {
    hasUI: true, waitForIdle: async () => {},
    ui: { input: async () => inputs.shift(), select: async () => choices.shift(), confirm: async () => confirmations.shift() ?? false, editor: async () => editorValue },
  } as unknown as ExtensionCommandContext;
}
test('first setup creates validated config without keys or server writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cpa-setup-')), local = join(dir, 'config.yaml');
  const ctx = uiContext(['new-cpa', 'https://example.invalid', 'MY_KEY'], ['Connection wizard', 'openai-completions', 'Environment variable', 'Save without connection check'], [true]);
  assert.equal(await runSetup(ctx, join(dir, 'absent'), local), true);
  const result = await readLayers(join(dir, 'absent'), local);
  assert.deepEqual(result.config?.connections['new-cpa'].credential, { kind: 'env', name: 'MY_KEY' });
});
test('cancelled setup preserves existing config byte for byte', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cpa-setup-')), local = join(dir, 'config.yaml');
  const original = stringify({ schemaVersion: 1, connections: { 'test-proxy': makeGateway() } });
  await writePrivateFile(local, original);
  assert.equal(await runSetup(uiContext([], [], []), join(dir, 'absent'), local), false);
  assert.equal(await readFile(local, 'utf8'), original);
});
test('private advanced editor stores sparse overrides without copying preset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cpa-setup-')), local = join(dir, 'local.yaml'), bundled = join(dir, 'bundled.yaml');
  await writePrivateFile(bundled, stringify({ schemaVersion: 1, connections: { 'test-proxy': makeGateway() } }));
  const text = 'connections:\n  test-proxy:\n    timeoutMs: 3000\n';
  const ctx = uiContext([], ['Advanced YAML override editor', 'Save without connection check'], [true], text);
  assert.equal(await runSetup(ctx, bundled, local), true);
  assert.doesNotMatch(await readFile(local, 'utf8'), /endpoint|models|profiles/);
  assert.equal((await readLayers(bundled, local)).config?.connections['test-proxy'].timeoutMs, 3000);
});
test('invalid advanced editor input never writes config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cpa-setup-')), local = join(dir, 'local.yaml');
  const ctx = uiContext([], ['Advanced YAML override editor'], [true], 'schemaVersion: 2\nconnections: {}');
  await assert.rejects(() => runSetup(ctx, join(dir, 'absent'), local), /config_schema_invalid/);
  await assert.rejects(() => readFile(local));
});
for (const api of wireApis) {
  test(`wizard records explicit ${api} protocol without discovery`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cpa-setup-')), local = join(dir, 'config.yaml');
    const ctx = uiContext(['new-cpa', 'https://example.invalid', 'MY_KEY'],
      ['Connection wizard', api, 'Environment variable', 'Save without connection check'], [true]);
    assert.equal(await runSetup(ctx, join(dir, 'absent'), local), true);
    assert.equal((await readLayers(join(dir, 'absent'), local)).config?.connections['new-cpa'].api, api);
  });
}
test('wizard cancellation at protocol selection leaves configuration untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cpa-setup-')), local = join(dir, 'config.yaml');
  assert.equal(await runSetup(uiContext(['new-cpa', 'https://example.invalid'],
    ['Connection wizard', undefined], []), join(dir, 'absent'), local), false);
  await assert.rejects(() => readFile(local));
});
test('headless setup rejects clearly instead of waiting on input', async () => {
  await assert.rejects(() => runSetup({ hasUI: false } as ExtensionCommandContext, '/unused', '/unused'), /setup_requires_ui_use_yaml/);
});
