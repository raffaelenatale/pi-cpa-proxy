import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as hostAi from '@earendil-works/pi-ai';
import type { Api, Model } from '@earendil-works/pi-ai';
import { seedLookupFrom } from './catalogue.ts';
import { readLayers, safeFailure, userConfigPath } from './configuration.ts';
import { catalogueFor, ompApiKey, ompModelEntry, ompSearchProvider } from './omp-export.ts';
import { profileMapToolDefinition } from './profile-map-registration.ts';
import { searchToolDefinition } from './search-registration.ts';
import type { Configuration } from './schema.ts';

/**
 * omp extension: registers every configured connection as an omp provider with the enriched
 * catalogue, read live from the gateway at startup with the last listing as fallback.
 * `integrations.piWebAccess` also registers CPA's Gemini endpoint as a grounding provider for omp's
 * `web` role, and `integrations.searchTools` become model-callable tools (same definition as in Pi).
 * `cpa_profile_map` is registered as a tool too (same definition as in Pi; the `/profile-map` command stays Pi-only).
 * Built into dist/omp-entry.js (one file, dependencies inlined)
 * because omp's extension host resolves neither `yaml` nor pi-ai's `providers/all` subpath.
 */
interface OmpHost {
  registerProvider(name: string, config: Record<string, unknown>): void;
  registerTool(tool: Record<string, unknown>): void;
}
// The omp host's pi-ai shim exposes its bundled catalogue from the package root.
interface OmpCatalogue { getBundledProviders(): string[]; getModels(provider: string): Model<Api>[] }

export default async function (pi: OmpHost): Promise<void> {
  const catalogue = hostAi as unknown as OmpCatalogue;
  const lookup = seedLookupFrom(() => catalogue.getBundledProviders().flatMap((provider) => catalogue.getModels(provider)));
  const agentDirectory = process.env.OMP_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent');
  const paths = { bundled: fileURLToPath(new URL('../config.yaml', import.meta.url)), local: userConfigPath() };
  // Same table as Pi's cpa_profile_map; registered before the configuration is read so the tool also reports a broken configuration.
  try {
    pi.registerTool({ ...profileMapToolDefinition(hostAi.Type, paths), approval: 'read' });
  } catch (error) { console.error(`pi-cpa-proxy: cpa_profile_map: ${safeFailure(error)}`); }
  let config: Configuration | undefined;
  try {
    config = (await readLayers(paths.bundled, paths.local)).config;
  } catch (error) { console.error(`pi-cpa-proxy: ${safeFailure(error)}`); return; }
  const catalogues = new Map<string, Model<Api>[]>();
  for (const [id, gateway] of Object.entries(config?.connections ?? {})) {
    try {
      const models = await catalogueFor(id, gateway, join(agentDirectory, 'pi-cpa-proxy', 'cache'), lookup);
      catalogues.set(id, models);
      pi.registerProvider(id, { baseUrl: gateway.endpoint.replace(/\/$/, ''), apiKey: ompApiKey(gateway.credential), api: gateway.api, models: models.map(ompModelEntry) });
    } catch (error) { console.error(`pi-cpa-proxy: ${id}: ${safeFailure(error)}`); }
  }

  const web = config?.integrations?.piWebAccess;
  const webModels = web && catalogues.get(web.connection);
  if (web && webModels) {
    try {
      const provider = ompSearchProvider(web.connection, config!.connections[web.connection], webModels, web.searchModel);
      if (provider) pi.registerProvider(provider.name, provider.config);
      else console.error(`pi-cpa-proxy: web search model ${web.searchModel} is not in the ${web.connection} catalogue`);
    } catch (error) { console.error(`pi-cpa-proxy: web search provider: ${safeFailure(error)}`); }
  }

  for (const [name, tool] of Object.entries(config?.integrations?.searchTools ?? {})) {
    try {
      pi.registerTool({ ...searchToolDefinition(name, tool, hostAi.Type, paths), approval: 'read' });
    } catch (error) { console.error(`pi-cpa-proxy: search tool ${name}: ${safeFailure(error)}`); }
  }
}
