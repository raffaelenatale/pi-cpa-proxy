import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ProxyFault, safeFailure, writePrivateFile } from './configuration.ts';
import { resolveSecret } from './credentials.ts';
import { managerSpec, type ManagerConfiguration, type Price } from './schema.ts';

const rate = z.number().nonnegative().finite();
const flags = {
  promptConfigured: z.boolean().optional(), completionConfigured: z.boolean().optional(),
  cacheReadConfigured: z.boolean().optional(), cacheCreationConfigured: z.boolean().optional(),
};
const amounts = { prompt: rate, completion: rate, cache: rate, cacheRead: rate.optional(), cacheCreation: rate.optional() };
const contextRule = z.strictObject({ ...amounts, ...flags, cacheConfigured: z.boolean().optional(), thresholdTokens: z.number().int().positive() });
const serviceRule = z.strictObject({ ...amounts, ...flags, cacheConfigured: z.boolean().optional(), mode: z.string().min(1), serviceTier: z.string().min(1) });
export const managerPriceSpec = z.strictObject({
  ...amounts, ...flags,
  source: z.string().optional(), sourceModelId: z.string().optional(), rawJson: z.string().max(262144).optional(),
  updatedAtMs: z.number().int().nonnegative().optional(), syncedAtMs: z.number().int().nonnegative().nullable().optional(),
  contextTiers: z.array(contextRule).optional(), serviceTiers: z.array(serviceRule).optional(),
});
const modelId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/).max(256).refine((s) => !['constructor', 'prototype', '__proto__'].includes(s));
const tableSpec = z.record(modelId, managerPriceSpec);
const responseSpec = z.strictObject({ prices: tableSpec });
export type ManagerPrice = z.infer<typeof managerPriceSpec>;
export type PriceTable = Record<string, ManagerPrice>;
const planSpec = z.strictObject({
  target: z.string().regex(/^[a-f0-9]{64}$/), configStamp: z.string().regex(/^[a-f0-9]{64}$/),
  before: tableSpec, after: tableSpec, changed: z.array(modelId),
});
export type PricePlan = z.infer<typeof planSpec>;
const journalSpec = z.strictObject({
  version: z.literal(1), id: z.string().uuid(),
  state: z.enum(['pending', 'applied', 'uncertain', 'rolling-back', 'rolled-back']),
  plan: planSpec, error: z.string().regex(/^[a-zA-Z0-9_]+$/).optional(),
});
type Journal = z.infer<typeof journalSpec>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const isPrice = !!value && typeof value === 'object' && ['prompt', 'completion', 'cache'].every((key) => typeof (value as Record<string, unknown>)[key] === 'number');
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([key, v]) => {
    if (v === undefined) return false;
    if (!isPrice) return true;
    if (key === 'updatedAtMs') return false;
    // Go's omitempty response encoding omits zero optional rates, false flags and empty metadata.
    if (['cacheRead', 'cacheCreation'].includes(key) && v === 0) return false;
    if (key.endsWith('Configured') && v === false) return false;
    if (['source', 'sourceModelId', 'rawJson', 'contextTiers', 'serviceTiers', 'syncedAtMs'].includes(key) &&
        (v === '' || v === null || (Array.isArray(v) && !v.length))) return false;
    return true;
  })
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => JSON.stringify(key) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function managementStamp(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function toManagerPrice(cost: Price): ManagerPrice {
  const fields = (price: Omit<Price, 'tiers'>) => ({
    prompt: price.input, completion: price.output, cache: price.cacheRead, cacheRead: price.cacheRead, cacheCreation: price.cacheWrite,
    promptConfigured: true, completionConfigured: true, cacheReadConfigured: true, cacheCreationConfigured: true,
  });
  return {
    ...fields(cost), source: 'manual', sourceModelId: 'pi-cpa-proxy',
    ...(cost.tiers?.length ? { contextTiers: cost.tiers.map((tier) => ({ ...fields(tier), thresholdTokens: tier.inputTokensAbove, cacheConfigured: true })) } : {}),
  };
}
/** Fixed path allowlist: config data never specifies request paths or arbitrary methods. */
async function managerRequest(config: ManagerConfiguration, method: 'GET' | 'PUT', signal: AbortSignal, body?: unknown): Promise<PriceTable> {
  if (signal.aborted) throw new ProxyFault('admin_aborted');
  let key: string | undefined;
  try { key = await resolveSecret(config.credential, signal); }
  catch (error) { throw signal.aborted ? new ProxyFault('admin_aborted') : error instanceof ProxyFault ? error : new ProxyFault('admin_credential_failed'); }
  if (!key) throw new ProxyFault('admin_credential_missing');
  let response: Response;
  try {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload && Buffer.byteLength(payload) > 2000000) throw new ProxyFault('admin_payload_too_large');
    response = await fetch(`${config.endpoint.replace(/\/$/, '')}/v0/management/model-prices`, {
      method, body: payload, redirect: 'error',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
    });
  } catch (error) { throw error instanceof ProxyFault ? error : new ProxyFault(signal.aborted ? 'admin_aborted' : 'admin_network_failed'); }
  if (!response.ok) { await response.body?.cancel(); throw new ProxyFault(`admin_http_${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new ProxyFault('admin_body_missing');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > 2000000) throw new ProxyFault('admin_response_too_large');
      chunks.push(next.value);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const raw = JSON.parse(text);
    // Never persist an echoed admin credential, including one escaped inside rawJson metadata.
    const containsCredential = (value: unknown): boolean => typeof value === 'string'
      ? value.includes(key) : !!value && typeof value === 'object' && Object.entries(value).some(([name, child]) => name.includes(key) || containsCredential(child));
    if (containsCredential(raw)) throw new ProxyFault('admin_response_contains_credential');
    const parsed = responseSpec.safeParse(raw);
    if (!parsed.success) throw new ProxyFault('admin_contract_unsupported');
    return parsed.data.prices;
  } catch (error) { throw error instanceof ProxyFault ? error : new ProxyFault('admin_body_invalid'); }
  finally { await reader.cancel().catch(() => {}); }
}
function destinationKey(config: ManagerConfiguration): string {
  return managementStamp(config.endpoint.replace(/\/$/, ''));
}
function buildPlan(config: ManagerConfiguration, before: PriceTable): PricePlan {
  const after = structuredClone(before);
  const changed: string[] = [];
  for (const [id, cost] of Object.entries(config.prices).sort(([a], [b]) => a.localeCompare(b))) {
    const expected = toManagerPrice(cost);
    const current = before[id];
    // Changes to managed rows intentionally replace their advanced rules; other rows remain untouched.
    if (!current || managementStamp(current) !== managementStamp(expected)) { after[id] = expected; changed.push(id); }
  }
  return { target: destinationKey(config), configStamp: managementStamp(config), before, after, changed };
}
async function readJournal(path: string): Promise<{ value?: Journal; text: string | null }> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5000000 ||
        (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))) throw new ProxyFault('admin_journal_unsafe');
    const text = await readFile(path, 'utf8');
    const decoded = journalSpec.safeParse(JSON.parse(text));
    if (!decoded.success) throw new ProxyFault('admin_journal_invalid');
    return { value: decoded.data, text };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: null };
    throw error instanceof ProxyFault ? error : new ProxyFault('admin_journal_unreadable');
  }
}
function requireWriteConsent(config: ManagerConfiguration): void {
  if (!config.allowPriceWrites || !config.exclusivePriceWriter) throw new ProxyFault('admin_writes_disabled');
}
export function openPriceAdministrator(unchecked: ManagerConfiguration, stateDirectory: string) {
  // Revalidate at the module boundary, including endpoint consent and exclusive-writer policy.
  const parsed = managerSpec.safeParse(unchecked);
  if (!parsed.success) throw new ProxyFault('admin_config_invalid');
  const config = parsed.data;
  const directory = join(stateDirectory, destinationKey(config));
  const journalPath = join(directory, 'transaction.json');
  const lockPath = join(directory, 'operation.lock');
  async function privateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' &&
      ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())))) throw new ProxyFault('admin_directory_unsafe');
  }
  async function locked<T>(task: () => Promise<T>): Promise<T> {
    await privateDirectory(stateDirectory);
    await privateDirectory(directory);
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); } catch { throw new ProxyFault('admin_operation_busy'); }
    try { return await task(); } finally { await lock.close(); await unlink(lockPath); }
  }
  return {
    async inspect(signal: AbortSignal) {
      const prices = await managerRequest(config, 'GET', signal);
      const { value } = await readJournal(journalPath);
      return { priceRead: true, priceWriteEnabled: config.allowPriceWrites, compareAndSwap: false,
        priceCount: Object.keys(prices).length, transaction: value?.state ?? 'none',
        scopeCount: Object.keys(config.prices).length };
    },
    async preview(signal: AbortSignal): Promise<PricePlan> {
      return buildPlan(config, await managerRequest(config, 'GET', signal));
    },
    async apply(untrustedPlan: PricePlan, approval: string, signal: AbortSignal): Promise<string> {
      requireWriteConsent(config);
      const valid = planSpec.safeParse(untrustedPlan);
      if (!valid.success) throw new ProxyFault('admin_plan_invalid');
      const plan = valid.data;
      if (managementStamp(plan) !== approval || managementStamp(buildPlan(config, plan.before)) !== approval) throw new ProxyFault('admin_approval_mismatch');
      if (!plan.changed.length) throw new ProxyFault('admin_no_changes');
      return locked(async () => {
        const prior = await readJournal(journalPath);
        if (prior.value && !['applied', 'rolled-back'].includes(prior.value.state)) throw new ProxyFault('admin_transaction_open');
        const current = await managerRequest(config, 'GET', signal);
        if (managementStamp(current) !== managementStamp(plan.before)) throw new ProxyFault('admin_concurrent_change');
        if (prior.value) {
          const archivePath = join(directory, `${prior.value.id}.json`);
          const archived = await readJournal(archivePath);
          if (archived.text !== null && archived.text !== prior.text) throw new ProxyFault('admin_archive_conflict');
          if (archived.text === null) await writePrivateFile(archivePath, prior.text!, null);
        }
        const journal: Journal = { version: 1, id: randomUUID(), state: 'pending', plan };
        let text = JSON.stringify(journal);
        await writePrivateFile(journalPath, text, prior.text);
        try {
          signal.throwIfAborted();
          await managerRequest(config, 'PUT', signal, { prices: plan.after });
          const observed = await managerRequest(config, 'GET', signal);
          if (managementStamp(observed) !== managementStamp(plan.after)) throw new ProxyFault('admin_verification_failed');
          const updated = JSON.stringify({ ...journal, state: 'applied' });
          await writePrivateFile(journalPath, updated, text); text = updated;
          return journal.id;
        } catch (error) {
          const code = safeFailure(error);
          try { await writePrivateFile(journalPath, JSON.stringify({ ...journal, state: 'uncertain', error: code }), text); }
          catch { throw new ProxyFault('admin_journal_update_failed_effects_unknown'); }
          throw new ProxyFault(`admin_effects_uncertain_${code}`);
        }
      });
    },
    async rollback(approvedId: string, signal: AbortSignal): Promise<void> {
      requireWriteConsent(config);
      return locked(async () => {
        const previous = await readJournal(journalPath);
        const journal = previous.value;
        if (!journal || journal.id !== approvedId || journal.plan.target !== destinationKey(config)) throw new ProxyFault('admin_rollback_reference_invalid');
        if (journal.state === 'rolled-back') return;
        const current = await managerRequest(config, 'GET', signal);
        const digest = managementStamp(current);
        const before = managementStamp(journal.plan.before);
        const after = managementStamp(journal.plan.after);
        if (digest !== before && digest !== after) throw new ProxyFault('admin_rollback_conflict');
        let text = previous.text;
        if (digest !== before) {
          const pending = JSON.stringify({ ...journal, state: 'rolling-back' });
          await writePrivateFile(journalPath, pending, text); text = pending;
          try {
            await managerRequest(config, 'PUT', signal, { prices: journal.plan.before });
            const observed = await managerRequest(config, 'GET', signal);
            if (managementStamp(observed) !== before) throw new ProxyFault('admin_rollback_verification_failed');
          } catch (error) { throw new ProxyFault(`admin_rollback_uncertain_${safeFailure(error)}`); }
        }
        try { await writePrivateFile(journalPath, JSON.stringify({ ...journal, state: 'rolled-back' }), text); }
        catch { throw new ProxyFault('admin_rollback_journal_failed'); }
      });
    },
    async transactionId(): Promise<string | undefined> { return (await readJournal(journalPath)).value?.id; },
  };
}
