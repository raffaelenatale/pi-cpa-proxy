import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as hostAi from '@earendil-works/pi-ai';
import type { Api, Model } from '@earendil-works/pi-ai';
import { seedLookupFrom } from './catalogue.ts';
import { readLayers, safeFailure, userConfigPath } from './configuration.ts';
import { catalogueFor, ompApiKey, ompModelEntry } from './omp-export.ts';

/**
 * omp extension: registers every configured connection as an omp provider with the enriched
 * catalogue (same rows the generated models.yml used to hold), read live from the gateway at startup
 * with the last listing as fallback. Built into dist/omp-entry.js (one file, dependencies inlined)
 * because omp's extension host resolves neither `yaml` nor pi-ai's `providers/all` subpath.
 */
interface OmpHost { registerProvider(name: string, config: Record<string, unknown>): void }
// The omp host's pi-ai shim exposes its bundled catalogue from the package root.
interface OmpCatalogue { getBundledProviders(): string[]; getModels(provider: string): Model<Api>[] }

export default async function (pi: OmpHost): Promise<void> {
  const catalogue = hostAi as unknown as OmpCatalogue;
  const lookup = seedLookupFrom(() => catalogue.getBundledProviders().flatMap((provider) => catalogue.getModels(provider)));
  const agentDirectory = process.env.OMP_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent');
  let connections: [string, Parameters<typeof catalogueFor>[1]][];
  try {
    const { config } = await readLayers(fileURLToPath(new URL('../config.yaml', import.meta.url)), userConfigPath());
    connections = Object.entries(config?.connections ?? {});
  } catch (error) { console.error(`pi-cpa-proxy: ${safeFailure(error)}`); return; }
  for (const [id, gateway] of connections) {
    try {
      const models = await catalogueFor(id, gateway, join(agentDirectory, 'pi-cpa-proxy', 'cache'), lookup);
      pi.registerProvider(id, { baseUrl: gateway.endpoint.replace(/\/$/, ''), apiKey: ompApiKey(gateway.credential), api: gateway.api, models: models.map(ompModelEntry) });
    } catch (error) { console.error(`pi-cpa-proxy: ${id}: ${safeFailure(error)}`); }
  }
}
