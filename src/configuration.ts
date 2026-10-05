import { readFile, mkdir, open, rename, unlink, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { parseDocument, stringify } from "yaml";
import { configurationSpec, type Configuration } from "./schema.ts";

export class ProxyFault extends Error {
  constructor(code: string) { super(code); this.name = "ProxyFault"; }
}
export function safeFailure(error: unknown): string {
  // Never interpolate arbitrary exception text: upstream bodies and keys may be present.
  return error instanceof ProxyFault ? error.message : "unexpected_failure";
}
function isMap(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function rejectUnsafeKeys(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(rejectUnsafeKeys); return; }
  if (!isMap(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new ProxyFault("unsafe_config_key");
    rejectUnsafeKeys(child);
  }
}
export function decodeYaml(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > 262144) throw new ProxyFault("config_too_large");
  try {
    const document = parseDocument(text, { uniqueKeys: true, strict: true });
    if (document.errors.length || document.warnings.length) throw new ProxyFault("invalid_yaml");
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (!isMap(value)) throw new ProxyFault("config_requires_mapping");
    rejectUnsafeKeys(value);
    return value;
  } catch (error) {
    if (error instanceof ProxyFault) throw error;
    throw new ProxyFault("invalid_yaml");
  }
}
/** Maps merge recursively; arrays replace. Null removes keys except in thinking maps, where it means unsupported. */
export function overlay(base: Record<string, unknown>, layer: Record<string, unknown>, context = ''): Record<string, unknown> {
  rejectUnsafeKeys(base); rejectUnsafeKeys(layer);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(layer)) {
    if (value === null && context !== 'thinkingLevelMap') delete result[key];
    else result[key] = isMap(value) && isMap(result[key]) ? overlay(result[key], value, key) : structuredClone(value);
  }
  return result;
}
export function validateConfiguration(value: unknown): Configuration {
  const parsed = configurationSpec.safeParse(value);
  if (!parsed.success) throw new ProxyFault("config_schema_invalid");
  return parsed.data;
}
export function expandUserPath(path: string, home = homedir()): string {
  const expanded = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
  if (!isAbsolute(expanded)) throw new ProxyFault("path_must_be_absolute");
  return expanded;
}
export function userConfigPath(): string {
  return process.env.CPA_PROXY_CONFIG
    ? expandUserPath(process.env.CPA_PROXY_CONFIG)
    : join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "pi-cpa-proxy", "config.yaml");
}
async function optionalYaml(path: string): Promise<Record<string, unknown> | undefined> {
  try { return decodeYaml(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error instanceof ProxyFault ? error : new ProxyFault("config_read_failed");
  }
}
export async function readLayers(bundledPath: string, localPath: string): Promise<{
  config?: Configuration; local: Record<string, unknown>; bundled: Record<string, unknown>; fingerprint: string;
}> {
  const bundled = await optionalYaml(bundledPath) ?? {};
  const local = await optionalYaml(localPath) ?? {};
  const merged = overlay(bundled, local);
  return {
    config: Object.keys(merged).length ? validateConfiguration(merged) : undefined,
    bundled, local, fingerprint: createHash("sha256").update(JSON.stringify(merged)).digest("hex"),
  };
}
export async function writePrivateFile(path: string, text: string, expected?: string | null): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch { throw new ProxyFault("file_busy"); }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    let old: string | null = null;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ProxyFault("unsafe_file_target");
      old = await readFile(path, "utf8");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (expected !== undefined && old !== expected) throw new ProxyFault("concurrent_file_change");
    if (old !== null) {
      const backup = await open(`${path}.backup-${randomUUID()}`, "wx", 0o600);
      try { await backup.writeFile(old); } finally { await backup.close(); }
    }
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}
export async function saveLocalLayer(path: string, local: Record<string, unknown>, bundled: Record<string, unknown>, expected: string | null): Promise<void> {
  validateConfiguration(overlay(bundled, local));
  await writePrivateFile(path, stringify(local), expected);
}
