import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { Api, Model } from '@earendil-works/pi-ai';
import { deriveCatalogue, type ListingEntry, type SeedLookup } from './catalogue.ts';
import { ProxyFault, expandUserPath } from './configuration.ts';
import { requestListing } from './listing.ts';
import { resolveSecret } from './credentials.ts';
import type { Gateway, SecretReference } from './schema.ts';

export const OMP_MANAGED_MARKER = 'managed-by: pi-cpa-proxy';

/**
 * omp (oh-my-pi) discovers gateway models via GET /v1/models, which carries no limits, and then
 * assumes generic 128k/32k defaults for unknown ids. Explicit `models:` entries in models.yml win
 * over discovery, so the enriched catalogue (bundled seeds + config overrides + profile derivation)
 * is materialised into the omp configuration. The credential is referenced, never copied:
 * file -> omp command-resolved secret (`!cat`), env -> variable name, keychain -> `!security`.
 * No Pi runtime is needed: this module only uses the engine's catalogue and the pi-ai model types.
 */
export function ompApiKey(credential: SecretReference): string {
  if (credential.kind === 'env') return credential.name;
  if (credential.kind === 'file') return `!cat ${expandUserPath(credential.path)}`;
  return `!security find-generic-password -a ${credential.account} -s ${credential.service} -w`;
}

export function ompModelEntry(model: Model<Api>): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: model.id, name: model.name ?? model.id, api: model.api, baseUrl: model.baseUrl,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    reasoning: model.reasoning, input: model.input,
    cost: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite },
  };
  if (model.cost.tiers?.length) {
    entry.cost = {
      ...(entry.cost as Record<string, unknown>),
      tiers: model.cost.tiers.map((tier) => ({
        inputTokensAbove: tier.inputTokensAbove, input: tier.input, output: tier.output,
        cacheRead: tier.cacheRead, cacheWrite: tier.cacheWrite,
      })),
    };
  }
  return entry;
}

export function ompModelsYml(id: string, gateway: Gateway, models: Model<Api>[]): string {
  const provider: Record<string, unknown> = {
    baseUrl: gateway.endpoint.replace(/\/$/, ''),
    apiKey: ompApiKey(gateway.credential),
    api: gateway.api,
    models: models.map(ompModelEntry),
  };
  // Per-model `api` + `baseUrl`: omp appends only the path suffix to baseUrl, so the OpenAI surface
  // needs `/v1` and the Anthropic one must not have it (both come from the derived model).
  const header = `# ${OMP_MANAGED_MARKER} connection ${id}. Regenerate with: node --experimental-strip-types src/omp-cli.ts --write. Do not hand-edit limits; fix config.yaml instead.`;
  return `${header}\n${stringify({ providers: { [id]: provider } })}`;
}

/** Live catalogue; falls back to the last cached listing when the gateway is unreachable. A live listing refreshes the cache. */
export async function catalogueFor(id: string, gateway: Gateway, cacheDirectory: string, lookup?: SeedLookup): Promise<Model<Api>[]> {
  const identity = createHash('sha256').update(JSON.stringify(gateway)).digest('hex');
  const cacheFile = join(cacheDirectory, `${id}-${identity}.json`);
  try {
    const key = await resolveSecret(gateway.credential);
    if (!key) throw new ProxyFault('credential_missing');
    const entries = await requestListing(gateway, key, AbortSignal.timeout(gateway.timeoutMs));
    const models = deriveCatalogue(id, gateway, entries, lookup).models;
    try { await mkdir(cacheDirectory, { recursive: true, mode: 0o700 }); await writeFile(cacheFile, JSON.stringify({ identity, checkedAt: Date.now(), entries }), { mode: 0o600 }); } catch { /* cache is best effort */ }
    return models;
  } catch (liveError) {
    try {
      const raw = JSON.parse(await readFile(cacheFile, 'utf8')) as { entries?: ListingEntry[] };
      const models = deriveCatalogue(id, gateway, raw.entries ?? [], lookup).models;
      if (models.length) return models;
      throw new ProxyFault('omp_catalogue_cache_empty');
    } catch { throw liveError instanceof ProxyFault ? liveError : new ProxyFault('omp_catalogue_unavailable'); }
  }
}
