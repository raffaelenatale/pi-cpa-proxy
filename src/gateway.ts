import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createProvider, lazyApi, type Provider, type ProviderStreams, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { z } from "zod";
import { deriveCatalogue, type ListingEntry, type SeedLookup } from "./catalogue.ts";
import { ProxyFault, safeFailure, writePrivateFile } from "./configuration.ts";
import { resolveSecret } from "./credentials.ts";
import type { Gateway } from "./schema.ts";
import { guardedStreams } from './stream-boundary.ts';

const listingSpec = z.strictObject({
  entries: z.array(z.strictObject({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/).max(256) })).max(10000),
  checkedAt: z.number().int().nonnegative(),
  identity: z.string(),
});
type CompatFactory = 'openAICompletionsApi' | 'openAIResponsesApi' | 'anthropicMessagesApi' | 'googleGenerativeAIApi';
/**
 * Pi's extension loader aliases only selected pi-ai entrypoints (root, compat, oauth, providers/all) to the
 * host copy; `pi-ai/api/*` subpaths do not resolve from packages installed without their own pi-ai
 * (git/npm installs). Prefer the host instance via compat, fall back to the subpath when compat is gone.
 */
function hostApi(factory: CompatFactory, load: () => Promise<ProviderStreams>): ProviderStreams {
  return lazyApi(async () => {
    try {
      const compat = await import('@earendil-works/pi-ai/compat') as Partial<Record<CompatFactory, () => ProviderStreams>>;
      const make = compat[factory];
      if (typeof make === 'function') return make();
    } catch { /* compat entrypoint removed: use the direct API subpath below. */ }
    return load();
  });
}
const implementations = {
  'openai-completions': guardedStreams(hostApi('openAICompletionsApi', () => import('@earendil-works/pi-ai/api/openai-completions'))),
  'openai-responses': guardedStreams(hostApi('openAIResponsesApi', () => import('@earendil-works/pi-ai/api/openai-responses'))),
  'anthropic-messages': guardedStreams(hostApi('anthropicMessagesApi', () => import('@earendil-works/pi-ai/api/anthropic-messages'))),
  'google-generative-ai': guardedStreams(hostApi('googleGenerativeAIApi', () => import('@earendil-works/pi-ai/api/google-generative-ai'))),
};
export interface GatewayHealth {
  source: 'empty' | 'cache' | 'live'; checkedAt: number; omitted: number; missingProfiles: number;
  error?: string; cacheError?: string;
}
export async function requestListing(gateway: Gateway, key: string, signal: AbortSignal): Promise<ListingEntry[]> {
  let response: Response;
  try {
    response = await fetch(`${gateway.endpoint.replace(/\/$/, '')}/v1/models`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(gateway.timeoutMs)]),
    });
  } catch { throw new ProxyFault(signal.aborted ? 'catalogue_aborted' : 'catalogue_network_failed'); }
  if (!response.ok) { await response.body?.cancel(); throw new ProxyFault(`catalogue_http_${response.status}`); }
  // Bound the response during streaming, not after buffering an untrusted server body.
  const reader = response.body?.getReader();
  if (!reader) throw new ProxyFault('catalogue_body_missing');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > 2_000_000) throw new ProxyFault('catalogue_too_large');
      chunks.push(item.value);
    }
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const decoded = z.object({ data: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/).max(256) })).max(10000) }).safeParse(raw);
    if (!decoded.success) throw new ProxyFault('catalogue_shape_invalid');
    return decoded.data.data.map(({ id }) => ({ id }));
  } catch (error) { throw error instanceof ProxyFault ? error : new ProxyFault('catalogue_body_invalid'); }
  finally { await reader.cancel().catch(() => {}); }
}
export async function openGateway(id: string, config: Gateway, cacheDirectory: string, lookup?: SeedLookup): Promise<{ provider: Provider; health: GatewayHealth }> {
  const identity = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  const cachePath = join(cacheDirectory, `${id}-${identity}.json`);
  let entries: ListingEntry[] = [];
  const health: GatewayHealth = { source: 'empty', checkedAt: 0, omitted: 0, missingProfiles: 0 };
  try {
    const raw = await readFile(cachePath, 'utf8');
    if (Buffer.byteLength(raw) > 2_000_000) throw new ProxyFault('cache_too_large');
    const stored = listingSpec.parse(JSON.parse(raw));
    if (stored.identity !== identity) throw new ProxyFault('cache_identity_mismatch');
    entries = stored.entries;
    health.source = 'cache'; health.checkedAt = stored.checkedAt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') health.cacheError = 'cache_invalid_or_unreadable';
  }
  const initial = deriveCatalogue(id, config, entries, lookup);
  let models = initial.models;
  Object.assign(health, { omitted: initial.omitted, missingProfiles: initial.missingProfiles });
  const core = createProvider({
    id, name: `CPA Proxy (${id})`, baseUrl: config.endpoint, models: [], api: implementations,
    auth: { apiKey: {
      name: 'Configured CPA credential',
      async resolve({ signal }) {
        const key = await resolveSecret(config.credential, signal);
        return key ? { auth: { apiKey: key }, source: `configured-${config.credential.kind}` } : undefined;
      },
    } },
  });
  const provider: Provider = {
    ...core,
    getModels: () => models,
    getAllModels: () => models,
    async refreshModels(context: RefreshModelsContext) {
      if (!context.allowNetwork) return;
      if (!context.force && health.checkedAt && Date.now() - health.checkedAt < config.cacheTtlSeconds * 1000) return;
      try {
        const key = await resolveSecret(config.credential, context.signal);
        if (!key) throw new ProxyFault('credential_missing');
        const fetched = await requestListing(config, key, context.signal);
        const next = deriveCatalogue(id, config, fetched, lookup);
        const checkedAt = Date.now();
        context.signal.throwIfAborted();
        const installed = await context.publish({ update: () => {
          models = next.models;
          entries = fetched;
          Object.assign(health, { source: 'live', checkedAt, omitted: next.omitted, missingProfiles: next.missingProfiles, error: undefined });
        } });
        if (installed) {
          try {
            await writePrivateFile(cachePath, JSON.stringify({ identity, checkedAt, entries }));
            health.cacheError = undefined;
          } catch { health.cacheError = 'cache_write_failed'; }
        }
      } catch (error) {
        health.error = safeFailure(error);
        throw error instanceof ProxyFault ? error : new ProxyFault('catalogue_refresh_failed');
      }
    },
  };
  return { provider, health };
}
