import { lstat, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expandUserPath, ProxyFault } from "./configuration.ts";
import type { SecretReference } from "./schema.ts";
const execute = promisify(execFile);

export async function resolveSecret(ref: SecretReference, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  let key: string | undefined;
  if (ref.kind === "env") key = process.env[ref.name];
  else if (ref.kind === "file") {
    const path = expandUserPath(ref.path);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new ProxyFault("credential_file_unsafe");
      if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))) {
        throw new ProxyFault("credential_permissions_unsafe");
      }
      key = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error instanceof ProxyFault ? error : new ProxyFault("credential_read_failed");
    }
  } else {
    if (process.platform !== "darwin") throw new ProxyFault("keychain_platform_unsupported");
    try {
      const result = await execute("security", ["find-generic-password", "-a", ref.account, "-s", ref.service, "-w"], {
        signal, timeout: 5000, maxBuffer: 8192,
      });
      key = result.stdout;
    } catch { throw new ProxyFault("keychain_lookup_failed"); }
  }
  signal?.throwIfAborted();
  key = key?.trim();
  if (!key) return undefined;
  if (key.length > 8192 || /[\r\n\u0000]/.test(key)) throw new ProxyFault("credential_invalid");
  return key;
}
