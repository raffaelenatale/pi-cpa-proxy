import { readFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { decodeYaml, overlay, readLayers, saveLocalLayer, validateConfiguration, ProxyFault } from './configuration.ts';
import { secretSpec } from './schema.ts';

export async function runSetup(ctx: ExtensionCommandContext, bundledPath: string, localPath: string): Promise<boolean> {
  if (!ctx.hasUI) throw new ProxyFault('setup_requires_ui_use_yaml');
  await ctx.waitForIdle();
  let expected: string | null = null;
  try { expected = await readFile(localPath, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ProxyFault('config_read_failed'); }
  const layers = await readLayers(bundledPath, localPath);
  const mode = await ctx.ui.select('CPA setup: credentials remain external', ['Connection wizard', 'Advanced YAML override editor']);
  if (!mode) return false;
  let local = layers.local;
  if (mode === 'Advanced YAML override editor') {
    const entered = await ctx.ui.editor('Local config / private overrides (null removes keys; lists replace)', stringify(Object.keys(local).length ? local : { schemaVersion: 1, connections: {} }));
    if (entered === undefined) return false;
    local = decodeYaml(entered);
  } else {
    const id = await ctx.ui.input('Provider ID (use existing ID to edit)', Object.keys(layers.config?.connections ?? {})[0] ?? 'cpa-proxy');
    if (!id) return false;
    const previous = layers.config?.connections[id];
    const endpoint = await ctx.ui.input('CPA origin, no /v1 suffix', previous?.endpoint ?? 'http://127.0.0.1:8317');
    if (!endpoint) return false;
    const method = await ctx.ui.select('Credential reference — do not paste a key', ['Environment variable', 'Protected file', 'macOS Keychain']);
    if (!method) return false;
    let reference: unknown;
    if (method === 'Environment variable') {
      const name = await ctx.ui.input('Environment variable name', previous?.credential.kind === 'env' ? previous.credential.name : 'CPA_PROXY_API_KEY');
      if (!name) return false;
      reference = { kind: 'env', name };
    } else if (method === 'Protected file') {
      const path = await ctx.ui.input('Credential file (absolute or ~/ path, chmod 600)', previous?.credential.kind === 'file' ? previous.credential.path : '~/.config/pi-cpa/api-key');
      if (!path) return false;
      reference = { kind: 'file', path };
    } else {
      const service = await ctx.ui.input('Keychain service');
      if (!service) return false;
      const account = await ctx.ui.input('Keychain account');
      if (!account) return false;
      reference = { kind: 'keychain', service, account };
    }
    const checked = secretSpec.safeParse(reference);
    if (!checked.success) throw new ProxyFault('credential_reference_invalid');
    const insecure = endpoint.startsWith('http:') ? await ctx.ui.confirm('HTTP endpoint', 'Allow unencrypted HTTP for this explicit local/tunnel endpoint?') : false;
    if (endpoint.startsWith('http:') && !insecure) return false;
    local = overlay(local, { schemaVersion: 1, connections: { [id]: { endpoint, credential: checked.data, allowInsecureHttp: insecure } } });
  }
  const effective = validateConfiguration(overlay(layers.bundled, local));
  if (!await ctx.ui.confirm('Save CPA configuration?', `${Object.keys(effective.connections).length} connection(s). Writes only local configuration; does not change CPA server or Pi defaults. Active provider changes require reload.`)) return false;
  await saveLocalLayer(localPath, local, layers.bundled, expected);
  return true;
}
