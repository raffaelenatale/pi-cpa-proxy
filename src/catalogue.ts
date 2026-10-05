import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { effortLevels, type Gateway, type ModelOverrides, type Price, type WireApi } from "./schema.ts";
import { ProxyFault } from "./configuration.ts";

export interface ListingEntry { id: string; }
export interface CatalogueOutcome { models: Model<Api>[]; omitted: number; missingProfiles: number; }
export type SeedLookup = (id: string, source?: ModelOverrides["source"]) => Model<Api> | undefined;
let builtinEntries: Model<Api>[] | undefined;
export const lookupBuiltin: SeedLookup = (id, source) => {
  builtinEntries ??= getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider)) as Model<Api>[];
  const choices = builtinEntries.filter((entry) => source ? entry.provider === source.provider && entry.id === source.id : entry.id === id);
  // Multiple providers can give the same ID materially different limits/costs. No arbitrary first match.
  if (choices.length === 1) return choices[0];
  if (!choices.length) return undefined;
  const signature = (entry: Model<Api>) => JSON.stringify([entry.contextWindow, entry.maxTokens, entry.input, entry.reasoning, entry.cost, entry.thinkingLevelMap, entry.compat]);
  return choices.every((entry) => signature(entry) === signature(choices[0])) ? choices[0] : undefined;
};
export function entranceUrl(origin: string, api: WireApi): string {
  return origin.replace(/\/$/, '') + (api === "anthropic-messages" ? '' : api === "google-generative-ai" ? '/v1beta' : '/v1');
}
export function priceCeiling(prices: Price[]): Price {
  const keys = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const thresholds = [...new Set(prices.flatMap((price) => price.tiers?.map((tier) => tier.inputTokensAbove) ?? []))].sort((a, b) => a - b);
  const maxRates = (at?: number) => {
    const values = prices.map((price) => at === undefined ? price : [...(price.tiers ?? [])].reverse().find((tier) => at >= tier.inputTokensAbove) ?? price);
    return Object.fromEntries(keys.map((key) => [key, Math.max(...values.map((v) => v[key]))])) as Omit<Price, 'tiers'>;
  };
  return { ...maxRates(), ...(thresholds.length ? { tiers: thresholds.map((threshold) => ({ inputTokensAbove: threshold, ...maxRates(threshold) })) } : {}) };
}
function minimumBounds(values: Record<string, unknown>[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of new Set(values.flatMap((value) => Object.keys(value)))) {
    const present = values.map((value) => value[key]).filter((value) => value !== undefined);
    result[key] = typeof present[0] === 'number' ? Math.min(...present as number[]) : minimumBounds(present as Record<string, unknown>[]);
  }
  return result;
}
function assembleModel(provider: string, id: string, gateway: Gateway, patch: ModelOverrides, lookup: SeedLookup): Model<Api> | undefined {
  const seed = gateway.builtinCatalog ? lookup(id, patch.source) : undefined;
  const api = patch.api ?? gateway.api;
  const contextWindow = patch.contextWindow ?? seed?.contextWindow;
  const maxTokens = patch.maxTokens ?? seed?.maxTokens;
  const cost = patch.cost ?? seed?.cost;
  const input = patch.input ?? seed?.input;
  const reasoning = patch.reasoning ?? seed?.reasoning;
  const compat = { ...(seed?.api === api ? seed?.compat : {}), ...patch.compat };
  if (!contextWindow || !maxTokens || !cost || !input || reasoning === undefined || maxTokens > contextWindow) return undefined;
  return {
    id, provider, name: patch.name ?? id, api, baseUrl: entranceUrl(gateway.endpoint, api),
    contextWindow, maxTokens, cost, input, reasoning,
    ...(patch.inputLimits ?? seed?.inputLimits ? { inputLimits: patch.inputLimits ?? seed?.inputLimits } : {}),
    ...(patch.thinkingLevelMap ?? seed?.thinkingLevelMap ? { thinkingLevelMap: patch.thinkingLevelMap ?? seed?.thinkingLevelMap } : {}),
    ...(Object.keys(compat).length ? { compat } : {}),
  } as Model<Api>;
}
export function deriveCatalogue(provider: string, gateway: Gateway, listing: ListingEntry[], lookup: SeedLookup = lookupBuiltin): CatalogueOutcome {
  const present = new Set(listing.map((entry) => entry.id));
  const hidden = new Set(gateway.hidden);
  const resolved = new Map<string, Model<Api>>();
  const resolving = new Set<string>();
  const resolve = (id: string): Model<Api> | undefined => {
    if (resolved.has(id)) return resolved.get(id);
    if (resolving.has(id)) throw new ProxyFault("profile_reference_cycle");
    resolving.add(id);
    try {
      const profile = gateway.profiles[id];
      let model: Model<Api> | undefined;
      if (profile) {
        const members = profile.members.map(resolve);
        if (members.some((member) => !member)) return undefined;
        const complete = members as Model<Api>[];
        const commonInput = complete[0].input.filter((input) => complete.every((member) => member.input.includes(input)));
        const profileApi = profile.metadata.api ?? gateway.api;
        const primary = complete[0];
        const commonMap = Object.fromEntries(effortLevels.map((level) => {
          const values = complete.map((member) => member.thinkingLevelMap?.[level] ?? (member.thinkingLevelMap && Object.hasOwn(member.thinkingLevelMap, level) ? null : level));
          return [level, values.every((value) => value !== null) ? values[0] : null];
        }));
        const requestedMap = { ...commonMap, ...profile.metadata.thinkingLevelMap };
        const jointMap = Object.fromEntries(effortLevels.map((level) => [level, commonMap[level] === null ? null : requestedMap[level]]));
        const patch: ModelOverrides = {
          contextWindow: Math.min(...complete.map((member) => member.contextWindow)),
          maxTokens: Math.min(...complete.map((member) => member.maxTokens)),
          cost: priceCeiling(complete.map((member) => member.cost)),
          input: commonInput, reasoning: complete.every((member) => member.reasoning),
          ...profile.metadata,
          compat: { ...(primary.api === profileApi ? primary.compat : {}), ...profile.metadata.compat } as ModelOverrides['compat'],
          thinkingLevelMap: jointMap,
          inputLimits: minimumBounds([...complete.map((member) => member.inputLimits ?? {}), profile.metadata.inputLimits ?? {}]),
        };
        if (!commonInput.length || (patch.reasoning && complete.some((member) => !member.reasoning)) || (patch.contextWindow! > Math.min(...complete.map((m) => m.contextWindow))) ||
            (patch.maxTokens! > Math.min(...complete.map((m) => m.maxTokens))) ||
            patch.input!.some((input) => !commonInput.includes(input))) throw new ProxyFault("profile_exceeds_member_capabilities");
        if (profile.effort !== 'inherit') {
          if (patch.thinkingLevelMap?.[profile.effort] === null) throw new ProxyFault("fixed_effort_unsupported");
          const value = patch.thinkingLevelMap?.[profile.effort] ?? profile.effort;
          patch.thinkingLevelMap = Object.fromEntries(effortLevels.map((level) => [level, value]));
        }
        model = assembleModel(provider, id, gateway, patch, () => undefined);
      } else model = assembleModel(provider, id, gateway, gateway.models[id] ?? {}, lookup);
      if (model) resolved.set(id, model);
      return model;
    } finally { resolving.delete(id); }
  };
  const models: Model<Api>[] = [];
  let omitted = 0;
  for (const id of [...present].sort()) {
    if (hidden.has(id) || gateway.models[id]?.enabled === false || gateway.profiles[id]?.metadata.enabled === false) continue;
    const model = resolve(id);
    if (model) models.push(model); else omitted++;
  }
  return { models, omitted, missingProfiles: Object.keys(gateway.profiles).filter((id) => !present.has(id)).length };
}
