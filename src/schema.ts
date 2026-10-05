import { z } from "zod";

export const wireApis = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
export const effortLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const positive = z.number().int().positive().max(100_000_000);
const label = z.string().min(1).max(256).refine((s) => !/[\r\n\u0000]/.test(s));
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/).max(256)
  .refine((s) => !['__proto__', 'constructor', 'prototype'].includes(s));
const pathRef = z.string().min(1).max(4096).refine((s) => !/[\r\n\u0000]/.test(s));
export const secretSpec = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("env"), name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) }),
  z.strictObject({ kind: z.literal("file"), path: pathRef }),
  z.strictObject({ kind: z.literal("keychain"), service: label, account: label }),
]);
const priceFields = {
  input: z.number().nonnegative().finite(), output: z.number().nonnegative().finite(),
  cacheRead: z.number().nonnegative().finite(), cacheWrite: z.number().nonnegative().finite(),
};
export const priceSpec = z.strictObject({
  ...priceFields,
  tiers: z.array(z.strictObject({ inputTokensAbove: z.number().int().nonnegative(), ...priceFields })).optional(),
}).superRefine((v, ctx) => {
  let previous = -1;
  for (const tier of v.tiers ?? []) {
    if (tier.inputTokensAbove <= previous) ctx.addIssue({ code: "custom", message: "tier_order" });
    previous = tier.inputTokensAbove;
  }
});
const compatSpec = z.strictObject({
  supportsDeveloperRole: z.boolean().optional(), supportsStore: z.boolean().optional(),
  supportsReasoningEffort: z.boolean().optional(), supportsStrictMode: z.boolean().optional(),
  maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
  thinkingFormat: z.enum(["openai", "zai", "qwen"]).optional(), zaiToolStream: z.boolean().optional(),
});
const effortMap = z.partialRecord(z.enum(effortLevels), z.union([label, z.null()]));
export const modelSpec = z.strictObject({
  source: z.strictObject({ provider: label, id: identifier }).optional(),
  name: label.optional(), api: z.enum(wireApis).optional(),
  contextWindow: positive.optional(), maxTokens: positive.optional(),
  reasoning: z.boolean().optional(), input: z.array(z.enum(["text", "image"])).min(1).max(2).optional(),
  cost: priceSpec.optional(), compat: compatSpec.optional(), thinkingLevelMap: effortMap.optional(),
  inputLimits: z.strictObject({
    maxRequestBytes: positive.optional(),
    images: z.strictObject({
      maxPerMessage: positive.optional(), maxPerRequest: positive.optional(),
      resize: z.strictObject({
        maxWidth: positive.optional(), maxHeight: positive.optional(), maxBytes: positive.optional(),
        jpegQuality: z.number().int().min(1).max(100).optional(),
      }).optional(),
    }).optional(),
  }).optional(),
  enabled: z.boolean().optional(),
});
const profileSpec = z.strictObject({
  members: z.array(identifier).min(1).max(16),
  effort: z.enum(["inherit", ...effortLevels]).default("inherit"),
  metadata: modelSpec.omit({ source: true }).default({}),
});
export const serverAdminSpec = z.strictObject({
  kind: z.literal('cli-proxy-api-v8'),
  endpoint: z.string().url(), credential: secretSpec,
  allowInsecureHttp: z.boolean().default(false),
  timeoutMs: z.number().int().min(100).max(60000).default(8000),
  allowProfileWrites: z.boolean().default(false),
  exclusiveConfigWriter: z.boolean().default(false),
  acceptLayoutMigration: z.boolean().default(false),
  aliases: z.record(identifier, z.strictObject({
    channel: z.enum(['codex', 'antigravity', 'claude', 'gemini-cli', 'aistudio', 'kimi', 'kimi-ai', 'xai', 'devin', 'meta']),
    model: identifier, contextWindow: positive,
  })).default({}),
  compatibleGroups: z.record(identifier, z.strictObject({
    primary: z.strictObject({
      channel: z.enum(['codex', 'antigravity', 'claude', 'gemini-cli', 'aistudio', 'kimi', 'kimi-ai', 'xai', 'devin', 'meta']),
      model: identifier,
    }),
    fallback: z.strictObject({
      channel: z.enum(['codex', 'antigravity', 'claude', 'gemini-cli', 'aistudio', 'kimi', 'kimi-ai', 'xai', 'devin', 'meta']),
      model: identifier,
    }),
    contextWindow: positive,
  })).default({}),
}).superRefine((v, ctx) => {
  let url: URL;
  try { url = new URL(v.endpoint); } catch { return; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    ctx.addIssue({ code: 'custom', message: 'admin_origin_policy' });
  }
  if (url.protocol === 'http:' && !v.allowInsecureHttp) ctx.addIssue({ code: 'custom', message: 'http_requires_consent' });
  if (v.allowProfileWrites && (!v.exclusiveConfigWriter || !v.acceptLayoutMigration)) {
    ctx.addIssue({ code: 'custom', message: 'profile_write_requires_exclusive_writer_and_migration_consent' });
  }
  const aliases = Object.keys(v.aliases).map((id) => id.toLowerCase());
  if (new Set(aliases).size !== aliases.length || Object.entries(v.aliases).some(([id, spec]) => aliases.includes(spec.model.toLowerCase()) || id.toLowerCase() === spec.model.toLowerCase())) {
    ctx.addIssue({ code: 'custom', message: 'server_alias_chain_or_duplicate' });
  }
  const groups = Object.keys(v.compatibleGroups).map((id) => id.toLowerCase());
  if (new Set(groups).size !== groups.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate_compatible_group_id' });
  }
  for (const [id, spec] of Object.entries(v.compatibleGroups)) {
    const idLower = id.toLowerCase();
    if (aliases.includes(idLower)) {
      ctx.addIssue({ code: 'custom', message: 'compatible_group_collision_with_oauth_alias' });
    }
    const primLower = spec.primary.model.toLowerCase();
    const fallLower = spec.fallback.model.toLowerCase();
    if (primLower === idLower || fallLower === idLower || aliases.includes(primLower) || aliases.includes(fallLower) || groups.includes(primLower) || groups.includes(fallLower)) {
      ctx.addIssue({ code: 'custom', message: 'compatible_group_chain_or_self_reference' });
    }
  }
});
export const managerSpec = z.strictObject({
  kind: z.literal('manager-plus'),
  endpoint: z.string().url(), credential: secretSpec,
  allowInsecureHttp: z.boolean().default(false),
  timeoutMs: z.number().int().min(100).max(60000).default(8000),
  allowPriceWrites: z.boolean().default(false),
  exclusivePriceWriter: z.boolean().default(false),
  prices: z.record(identifier, priceSpec).default({}),
}).superRefine((v, ctx) => {
  let url: URL;
  try { url = new URL(v.endpoint); } catch { return; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    ctx.addIssue({ code: 'custom', path: ['endpoint'], message: 'admin_origin_policy' });
  }
  if (url.protocol === 'http:' && !v.allowInsecureHttp) ctx.addIssue({ code: 'custom', message: 'http_requires_consent' });
  if (v.allowPriceWrites && !v.exclusivePriceWriter) ctx.addIssue({ code: 'custom', message: 'full_replace_requires_exclusive_writer' });
  if (Object.values(v.prices).some((price) => price.tiers?.some((tier) => tier.inputTokensAbove <= 0))) {
    ctx.addIssue({ code: 'custom', message: 'manager_requires_positive_tier_threshold' });
  }
});
const gatewaySpec = z.strictObject({
  endpoint: z.string().url(),
  credential: secretSpec,
  allowInsecureHttp: z.boolean().default(false),
  api: z.enum(wireApis).default("openai-completions"),
  timeoutMs: z.number().int().min(100).max(60_000).default(8000),
  cacheTtlSeconds: z.number().int().min(0).max(604800).default(3600),
  builtinCatalog: z.boolean().default(true),
  models: z.record(identifier, modelSpec).default({}),
  profiles: z.record(identifier, profileSpec).default({}),
  hidden: z.array(identifier).default([]),
  admin: managerSpec.optional(),
  serverAdmin: serverAdminSpec.optional(),
}).superRefine((v, ctx) => {
  let u: URL;
  try { u = new URL(v.endpoint); } catch { return; }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
    ctx.addIssue({ code: "custom", path: ["endpoint"], message: "endpoint_policy" });
  }
  if (u.protocol === 'http:' && !v.allowInsecureHttp) {
    ctx.addIssue({ code: "custom", path: ["endpoint"], message: "http_requires_consent" });
  }
  if (u.pathname !== '/' && u.pathname !== '') {
    ctx.addIssue({ code: "custom", path: ["endpoint"], message: "use_origin_without_api_suffix" });
  }
  for (const [id, profile] of Object.entries(v.profiles)) {
    if (v.models[id]) ctx.addIssue({ code: "custom", path: ["profiles", id], message: "duplicate_model_profile" });
    if (profile.members.includes(id)) ctx.addIssue({ code: "custom", path: ["profiles", id], message: "profile_cycle" });
  }
});
export const configurationSpec = z.strictObject({
  schemaVersion: z.literal(1),
  revision: label.optional(),
  connections: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), gatewaySpec),
});
export type Configuration = z.infer<typeof configurationSpec>;
export type Gateway = Configuration["connections"][string];
export type SecretReference = z.infer<typeof secretSpec>;
export type ModelOverrides = z.infer<typeof modelSpec>;
export type Price = z.infer<typeof priceSpec>;
export type WireApi = typeof wireApis[number];
export type ManagerConfiguration = z.infer<typeof managerSpec>;
export type ServerAdministration = z.infer<typeof serverAdminSpec>;
