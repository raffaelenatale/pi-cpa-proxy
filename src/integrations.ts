import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { expandUserPath, ProxyFault, writePrivateFile } from "./configuration.ts";
import type { Gateway, SecretReference } from "./schema.ts";

/** Settings of `integrations.piWebAccess` after validation. */
export interface PiWebAccessSettings { connection: string; searchModel: string; defaultProvider: boolean }
export type PiWebAccessOutcome = { status: "created" | "updated" | "unchanged"; path: string };

function shellQuote(value: string): string {
  if (/[\r\n\u0000]/.test(value)) throw new ProxyFault("web_search_reference_invalid");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Translates a credential reference into pi-web-access' own source syntax (`$NAME` or `!command`).
 * The key itself is never read or written here: pi-web-access resolves it when it needs it.
 */
export function webAccessCredentialSource(ref: SecretReference): string {
  if (ref.kind === "env") return `$${ref.name}`;
  if (ref.kind === "file") return `!cat -- ${shellQuote(expandUserPath(ref.path))}`;
  if (process.platform !== "darwin") throw new ProxyFault("keychain_platform_unsupported");
  return `!security find-generic-password -a ${shellQuote(ref.account)} -s ${shellQuote(ref.service)} -w`;
}

/** Mirrors pi-web-access' lookup of web-search.json so both read and write the same file. */
export function webSearchConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir(), exists = existsSync): string {
  if (env.PI_CODING_AGENT_DIR) return join(env.PI_CODING_AGENT_DIR, "web-search.json");
  const legacy = join(home, ".pi");
  if (env.XDG_CONFIG_HOME) {
    const xdg = join(env.XDG_CONFIG_HOME, "pi");
    if (exists(join(xdg, "web-search.json"))) return join(xdg, "web-search.json");
    if (exists(join(legacy, "web-search.json"))) return join(legacy, "web-search.json");
    return join(xdg, "web-search.json");
  }
  const agent = join(home, ".pi", "agent");
  if (exists(join(agent, "web-search.json"))) return join(agent, "web-search.json");
  if (exists(join(legacy, "web-search.json"))) return join(legacy, "web-search.json");
  return join(agent, "web-search.json");
}

export function desiredWebSearchSettings(settings: PiWebAccessSettings, gateway: Gateway): Record<string, string> {
  const desired: Record<string, string> = {
    geminiBaseUrl: gateway.endpoint.replace(/\/+$/, ""),
    geminiApiKey: webAccessCredentialSource(gateway.credential),
    searchModel: settings.searchModel,
  };
  if (settings.defaultProvider) desired.provider = "gemini";
  return desired;
}

/**
 * Makes pi-web-access search through CPA's Gemini endpoint. Writes only the managed keys of web-search.json
 * (other keys are preserved), only when they differ, never touches CPA, and never stores the API key.
 * A file that is not strict JSON is left untouched.
 */
export async function syncPiWebAccess(settings: PiWebAccessSettings, gateway: Gateway, path = webSearchConfigPath()): Promise<PiWebAccessOutcome> {
  const desired = desiredWebSearchSettings(settings, gateway);
  let text: string | null = null;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ProxyFault("web_search_config_unreadable"); }
  let current: Record<string, unknown> = {};
  if (text !== null) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not_object");
      current = parsed as Record<string, unknown>;
    } catch { throw new ProxyFault("web_search_config_invalid"); }
  }
  if (text !== null && Object.entries(desired).every(([key, value]) => current[key] === value)) return { status: "unchanged", path };
  await writePrivateFile(path, `${JSON.stringify({ ...current, ...desired }, null, 2)}\n`, text);
  return { status: text === null ? "created" : "updated", path };
}
