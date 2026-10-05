import { ProxyFault } from './configuration.ts';
import { resolveSecret } from './credentials.ts';
import type { SecretReference } from './schema.ts';

export async function adminSecret(reference: SecretReference, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new ProxyFault('admin_aborted');
  try {
    const key = await resolveSecret(reference, signal);
    if (!key) throw new ProxyFault('admin_credential_missing');
    return key;
  } catch (error) {
    throw signal.aborted ? new ProxyFault('admin_aborted') : error instanceof ProxyFault ? error : new ProxyFault('admin_credential_failed');
  }
}
const allowedPaths = new Set(['/v8/management/config/oauth/model-alias', '/v8/management/config/oauth/settings', '/v8/management/config', '/v1/models']);
/** Only the fixed secret-free read paths and bounded root PATCH used by the profile adapter. */
export async function profileHttp(endpoint: string, path: string, key: string, timeoutMs: number, signal: AbortSignal,
  body?: unknown, forbiddenSecrets: string[] = [key]): Promise<unknown> {
  if (!allowedPaths.has(path) || (body !== undefined && path !== '/v8/management/config') || (body === undefined && path === '/v8/management/config')) {
    throw new ProxyFault('admin_path_forbidden');
  }
  if (signal.aborted) throw new ProxyFault('admin_aborted');
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload && Buffer.byteLength(payload) > 2000000) throw new ProxyFault('admin_payload_too_large');
  function safeProfilePatch(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const root = value as Record<string, unknown>;
    if (Object.keys(root).length !== 1 || !root.oauth || typeof root.oauth !== 'object' || Array.isArray(root.oauth)) return false;
    const oauth = root.oauth as Record<string, unknown>;
    if (Object.keys(oauth).sort().join(',') !== 'model-alias,settings') return false;
    for (const [section, map] of Object.entries(oauth)) {
      if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
      for (const [channel, rows] of Object.entries(map)) {
        if (!/^[a-z][a-z0-9-]*$/.test(channel) || ['constructor', 'prototype'].includes(channel) || !Array.isArray(rows)) return false;
        const allowed = section === 'model-alias' ? ['name', 'alias', 'fork', 'display-name', 'force-mapping'] : ['name', 'alias', 'max-context-length'];
        if (rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some((key) => !allowed.includes(key)))) return false;
      }
    }
    return true;
  }
  if (body !== undefined && !safeProfilePatch(body)) throw new ProxyFault('admin_patch_scope_forbidden');
  let response: Response;
  try {
    response = await fetch(`${endpoint.replace(/\/$/, '')}${path}`, {
      method: payload === undefined ? 'GET' : 'PATCH', body: payload, redirect: 'error',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
  } catch { throw new ProxyFault(signal.aborted ? 'admin_aborted' : 'admin_network_failed'); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new ProxyFault(`admin_http_${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new ProxyFault('admin_body_missing');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length; if (size > 2000000) throw new ProxyFault('admin_response_too_large');
      chunks.push(next.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    function containsSecret(item: unknown): boolean {
      if (typeof item === 'string') return forbiddenSecrets.some((secret) => item.includes(secret));
      return !!item && typeof item === 'object' && Object.entries(item).some(([name, child]) => containsSecret(name) || containsSecret(child));
    }
    if (containsSecret(value)) throw new ProxyFault('admin_response_contains_credential');
    return value;
  } catch (error) { throw error instanceof ProxyFault ? error : new ProxyFault('admin_body_invalid'); }
  finally { await reader.cancel().catch(() => {}); }
}
