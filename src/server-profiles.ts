import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, lstat, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ProxyFault, safeFailure, writePrivateFile } from './configuration.ts';
import { adminSecret, profileHttp } from './admin-http.ts';
import { serverAdminSpec, type ServerAdministration, type Gateway } from './schema.ts';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/).max(256).refine((s) => !['__proto__', 'constructor', 'prototype'].includes(s));
const channel = z.string().regex(/^[a-z][a-z0-9-]*$/).max(100).refine((s) => !['constructor', 'prototype'].includes(s));
const aliasEntry = z.strictObject({ name: id, alias: id, fork: z.boolean().default(false),
  'display-name': z.string().max(256).optional(), 'force-mapping': z.boolean().default(false) });
const settingEntry = z.strictObject({ name: id, alias: id.optional(), 'max-context-length': z.number().int().nonnegative().optional() });
const snapshotSpec = z.strictObject({
  aliases: z.record(channel, z.array(aliasEntry)), settings: z.record(channel, z.array(settingEntry)),
});
type Snapshot = z.infer<typeof snapshotSpec>;
const planSpec = z.strictObject({
  target: z.string().regex(/^[a-f0-9]{64}$/), configStamp: z.string().regex(/^[a-f0-9]{64}$/),
  before: snapshotSpec, after: snapshotSpec, channels: z.array(channel),
  previousOwned: z.array(id), owned: z.array(id), changed: z.array(id),
});
export type ServerProfilePlan = z.infer<typeof planSpec>;
const journalSpec = z.strictObject({
  version: z.literal(1), id: z.string().uuid(), plan: planSpec,
  state: z.enum(['pending', 'applied', 'uncertain', 'rolling-back', 'rolled-back']),
  error: z.string().regex(/^[a-zA-Z0-9_]+$/).optional(),
});
type Journal = z.infer<typeof journalSpec>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => JSON.stringify(key) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function profileStamp(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
const same = (a: unknown, b: unknown) => profileStamp(a) === profileStamp(b);
function targetStamp(config: ServerAdministration): string { return profileStamp(config.endpoint.replace(/\/$/, '')); }
function aliasRows(snapshot: Snapshot, alias: string) {
  return Object.entries(snapshot.aliases).flatMap(([channel, entries]) => entries
    .filter((row) => row.alias.toLowerCase() === alias.toLowerCase()).map((row) => ({ channel, row })));
}
function settingRows(snapshot: Snapshot, alias: string) {
  return Object.entries(snapshot.settings).flatMap(([channel, entries]) => entries
    .filter((row) => row.alias?.toLowerCase() === alias.toLowerCase()).map((row) => ({ channel, row })));
}
function ownership(journal?: Journal): string[] {
  return journal?.state === 'applied' ? journal.plan.owned : journal?.state === 'rolled-back' ? journal.plan.previousOwned : [];
}
function expectedOwnershipSnapshot(journal?: Journal): Snapshot | undefined {
  return journal?.state === 'applied' ? journal.plan.after : journal?.state === 'rolled-back' ? journal.plan.before : undefined;
}
function buildPlan(config: ServerAdministration, before: Snapshot, journal?: Journal): ServerProfilePlan {
  if (journal && !['applied', 'rolled-back'].includes(journal.state)) throw new ProxyFault('profile_transaction_open');
  // Combine single OAuth aliases and compatible primary/fallback groups
  const ownedOAuth = Object.keys(config.aliases);
  const ownedGroups = Object.keys(config.compatibleGroups);
  const owned = [...ownedOAuth, ...ownedGroups].sort();
  const previousOwned = ownership(journal);
  if (previousOwned.some((alias) => !owned.includes(alias))) throw new ProxyFault('profile_removal_requires_rollback');
  const expectedPrevious = expectedOwnershipSnapshot(journal);
  const after = structuredClone(before);
  const channels = new Set<string>(), changed: string[] = [];

  // 1. Process single OAuth aliases
  for (const [alias, spec] of Object.entries(config.aliases).sort(([a], [b]) => a.localeCompare(b))) {
    // Existing channels only: rollback can restore exact arrays without inventing/deleting map keys.
    if (!Object.hasOwn(before.aliases, spec.channel) || !Object.hasOwn(before.settings, spec.channel)) throw new ProxyFault('profile_channel_not_initialized');
    if (aliasRows(before, spec.model).length) throw new ProxyFault('profile_source_is_alias');
    const rows = aliasRows(before, alias), settings = settingRows(before, alias);
    if (!previousOwned.includes(alias)) {
      if (rows.length || settings.length) throw new ProxyFault('profile_unowned_alias_collision');
    } else if (!expectedPrevious || !same(rows, aliasRows(expectedPrevious, alias)) || !same(settings, settingRows(expectedPrevious, alias))) {
      throw new ProxyFault('profile_owned_resource_changed');
    }
    for (const name of [spec.channel, ...rows.map((row) => row.channel), ...settings.map((row) => row.channel)]) channels.add(name);
    // Preserve order of unrelated entries; append deterministic managed entries only in touched channels.
    for (const name of channels) {
      after.aliases[name] = after.aliases[name].filter((row) => row.alias.toLowerCase() !== alias.toLowerCase());
      after.settings[name] = after.settings[name].filter((row) => row.alias?.toLowerCase() !== alias.toLowerCase());
    }
    after.aliases[spec.channel].push(aliasEntry.parse({ name: spec.model, alias, fork: true }));
    after.settings[spec.channel].push({ name: spec.model, alias, 'max-context-length': spec.contextWindow });
    if (!same(rows, aliasRows(after, alias)) || !same(settings, settingRows(after, alias))) changed.push(alias);
  }

  // 2. Process compatible primary/fallback groups
  for (const [groupId, spec] of Object.entries(config.compatibleGroups).sort(([a], [b]) => a.localeCompare(b))) {
    const { primary, fallback, contextWindow } = spec;
    if (!Object.hasOwn(before.aliases, primary.channel) || !Object.hasOwn(before.settings, primary.channel)) {
      throw new ProxyFault('profile_channel_not_initialized');
    }
    if (!Object.hasOwn(before.aliases, fallback.channel) || !Object.hasOwn(before.settings, fallback.channel)) {
      throw new ProxyFault('profile_channel_not_initialized');
    }
    if (aliasRows(before, primary.model).length || aliasRows(before, fallback.model).length) {
      throw new ProxyFault('profile_source_is_alias');
    }
    const rows = aliasRows(before, groupId), settings = settingRows(before, groupId);
    if (!previousOwned.includes(groupId)) {
      if (rows.length || settings.length) throw new ProxyFault('profile_unowned_alias_collision');
    } else if (!expectedPrevious || !same(rows, aliasRows(expectedPrevious, groupId)) || !same(settings, settingRows(expectedPrevious, groupId))) {
      throw new ProxyFault('profile_owned_resource_changed');
    }
    for (const name of [primary.channel, fallback.channel, ...rows.map((r) => r.channel), ...settings.map((r) => r.channel)]) {
      channels.add(name);
    }
    for (const name of channels) {
      after.aliases[name] = after.aliases[name].filter((row) => row.alias.toLowerCase() !== groupId.toLowerCase());
      after.settings[name] = after.settings[name].filter((row) => row.alias?.toLowerCase() !== groupId.toLowerCase());
    }
    // Primary row
    after.aliases[primary.channel].push(aliasEntry.parse({ name: primary.model, alias: groupId, fork: true, 'display-name': `CPA ${groupId} · primary` }));
    after.settings[primary.channel].push({ name: primary.model, alias: groupId, 'max-context-length': contextWindow });
    // Fallback row
    after.aliases[fallback.channel].push(aliasEntry.parse({ name: fallback.model, alias: groupId, fork: true, 'display-name': `CPA ${groupId} · fallback` }));
    after.settings[fallback.channel].push({ name: fallback.model, alias: groupId, 'max-context-length': contextWindow });

    if (!same(rows, aliasRows(after, groupId)) || !same(settings, settingRows(after, groupId))) changed.push(groupId);
  }

  // Array order itself matters to CPA. Retain exact before if rows are semantically already equal.
  if (!changed.length) return { target: targetStamp(config), configStamp: profileStamp(config), before, after: structuredClone(before), channels: [], previousOwned, owned, changed };
  return { target: targetStamp(config), configStamp: profileStamp(config), before, after, channels: [...channels].sort(), previousOwned, owned, changed };
}
function patch(plan: ServerProfilePlan, which: 'before' | 'after') {
  return { oauth: {
    'model-alias': Object.fromEntries(plan.channels.map((name) => [name, plan[which].aliases[name]])),
    settings: Object.fromEntries(plan.channels.map((name) => [name, plan[which].settings[name]])),
  } };
}
async function journalFile(path: string): Promise<{ text: string | null; value?: Journal }> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 5000000 || (process.platform !== 'win32' &&
      ((info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())))) throw new ProxyFault('profile_journal_unsafe');
    const text = await readFile(path, 'utf8'); const parsed = journalSpec.safeParse(JSON.parse(text));
    if (!parsed.success) throw new ProxyFault('profile_journal_invalid');
    return { text, value: parsed.data };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: null };
    throw error instanceof ProxyFault ? error : new ProxyFault('profile_journal_unreadable');
  }
}
async function protectedDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' &&
      ((info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())))) throw new ProxyFault('profile_directory_unsafe');
}
export function openServerProfiles(unchecked: ServerAdministration, gateway: Pick<Gateway, 'endpoint' | 'credential' | 'timeoutMs'>, stateDirectory: string) {
  const parsed = serverAdminSpec.safeParse(unchecked);
  if (!parsed.success) throw new ProxyFault('profile_config_invalid');
  const config = parsed.data;
  const directory = join(stateDirectory, targetStamp(config)), path = join(directory, 'transaction.json');
  const lockPath = join(directory, 'operation.lock');
  async function locked<T>(task: () => Promise<T>): Promise<T> {
    await protectedDirectory(stateDirectory); await protectedDirectory(directory);
    let lock; try { lock = await open(lockPath, 'wx', 0o600); } catch { throw new ProxyFault('profile_operation_busy'); }
    try { return await task(); } finally { await lock.close(); await unlink(lockPath); }
  }
  async function credentials(signal: AbortSignal) {
    const admin = await adminSecret(config.credential, signal), client = await adminSecret(gateway.credential, signal);
    return { admin, client };
  }
  async function readSnapshot(keys: { admin: string; client: string }, signal: AbortSignal): Promise<Snapshot> {
    const aliases = await profileHttp(config.endpoint, '/v8/management/config/oauth/model-alias', keys.admin, config.timeoutMs, signal, undefined, [keys.admin, keys.client]);
    const settings = await profileHttp(config.endpoint, '/v8/management/config/oauth/settings', keys.admin, config.timeoutMs, signal, undefined, [keys.admin, keys.client]);
    const parsed = snapshotSpec.safeParse({ aliases, settings });
    if (!parsed.success) throw new ProxyFault('profile_contract_unsupported');
    return parsed.data;
  }
  async function stableSnapshot(keys: { admin: string; client: string }, signal: AbortSignal) {
    const first = await readSnapshot(keys, signal), second = await readSnapshot(keys, signal);
    if (!same(first, second)) throw new ProxyFault('profile_snapshot_unstable');
    return second;
  }
  async function listing(keys: { admin: string; client: string }, signal: AbortSignal): Promise<Set<string>> {
    const body = await profileHttp(gateway.endpoint, '/v1/models', keys.client, gateway.timeoutMs, signal, undefined, [keys.admin, keys.client]);
    const decoded = z.object({ data: z.array(z.object({ id })) }).safeParse(body);
    if (!decoded.success) throw new ProxyFault('profile_catalogue_invalid');
    return new Set(decoded.data.data.map((entry) => entry.id.toLowerCase()));
  }
  function writesEnabled() {
    if (!config.allowProfileWrites || !config.exclusiveConfigWriter || !config.acceptLayoutMigration) throw new ProxyFault('profile_writes_disabled');
  }
  async function verifyCatalogue(keys: { admin: string; client: string }, plan: ServerProfilePlan, signal: AbortSignal) {
    const expected = plan.owned.map((alias) => alias.toLowerCase());
    for (let attempt = 0; attempt < 12; attempt++) {
      const actual = await listing(keys, signal);
      const allListed = expected.every((alias) => actual.has(alias)) &&
        Object.values(config.aliases).every((spec) => actual.has(spec.model.toLowerCase())) &&
        Object.values(config.compatibleGroups).every((spec) => actual.has(spec.primary.model.toLowerCase()) && actual.has(spec.fallback.model.toLowerCase()));
      if (allListed) return;
      if (signal.aborted) throw new ProxyFault('admin_aborted');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new ProxyFault('profile_catalogue_reload_unverified');
  }
  return {
    async inspect(signal: AbortSignal) {
      const keys = await credentials(signal); const snapshot = await stableSnapshot(keys, signal);
      const journal = await journalFile(path);
      const configuredTotal = Object.keys(config.aliases).length + Object.keys(config.compatibleGroups).length;
      return { channels: Object.keys(snapshot.aliases).length, configuredAliases: configuredTotal,
        ownedAliases: ownership(journal.value).length, transaction: journal.value?.state ?? 'none',
        writes: config.allowProfileWrites, compareAndSwap: false, compatiblePrimaryFallback: Object.keys(config.compatibleGroups).length > 0 };
    },
    async preview(signal: AbortSignal): Promise<ServerProfilePlan> {
      const keys = await credentials(signal); const before = await stableSnapshot(keys, signal);
      const journal = await journalFile(path); const plan = buildPlan(config, before, journal.value);
      const models = await listing(keys, signal);
      for (const [alias, spec] of Object.entries(config.aliases)) {
        if (!models.has(spec.model.toLowerCase())) throw new ProxyFault('profile_source_not_listed');
        if (!plan.previousOwned.includes(alias) && models.has(alias.toLowerCase())) throw new ProxyFault('profile_catalogue_alias_collision');
      }
      for (const [groupId, spec] of Object.entries(config.compatibleGroups)) {
        if (!models.has(spec.primary.model.toLowerCase()) || !models.has(spec.fallback.model.toLowerCase())) {
          throw new ProxyFault('profile_source_not_listed');
        }
        if (!plan.previousOwned.includes(groupId) && models.has(groupId.toLowerCase())) {
          throw new ProxyFault('profile_catalogue_alias_collision');
        }
      }
      return plan;
    },
    async apply(uncheckedPlan: ServerProfilePlan, approval: string, signal: AbortSignal): Promise<string> {
      writesEnabled(); const decoded = planSpec.safeParse(uncheckedPlan);
      if (!decoded.success) throw new ProxyFault('profile_plan_invalid'); const plan = decoded.data;
      return locked(async () => {
        const prior = await journalFile(path);
        if (!same(plan, buildPlan(config, plan.before, prior.value)) || approval !== profileStamp(plan)) throw new ProxyFault('profile_approval_mismatch');
        if (!plan.changed.length) throw new ProxyFault('profile_no_changes');
        const keys = await credentials(signal), current = await stableSnapshot(keys, signal);
        if (!same(current, plan.before)) throw new ProxyFault('profile_concurrent_change');
        const models = await listing(keys, signal);
        for (const [alias, spec] of Object.entries(config.aliases)) {
          if (!models.has(spec.model.toLowerCase())) throw new ProxyFault('profile_source_not_listed');
          if (!plan.previousOwned.includes(alias) && models.has(alias.toLowerCase())) throw new ProxyFault('profile_catalogue_alias_collision');
        }
        for (const [groupId, spec] of Object.entries(config.compatibleGroups)) {
          if (!models.has(spec.primary.model.toLowerCase()) || !models.has(spec.fallback.model.toLowerCase())) {
            throw new ProxyFault('profile_source_not_listed');
          }
          if (!plan.previousOwned.includes(groupId) && models.has(groupId.toLowerCase())) {
            throw new ProxyFault('profile_catalogue_alias_collision');
          }
        }
        if (prior.value) {
          const archive = join(directory, `${prior.value.id}.json`), existing = await journalFile(archive);
          if (existing.text !== null && existing.text !== prior.text) throw new ProxyFault('profile_archive_conflict');
          if (existing.text === null) await writePrivateFile(archive, prior.text!, null);
        }
        const journal: Journal = { version: 1, id: randomUUID(), state: 'pending', plan };
        let text = JSON.stringify(journal); await writePrivateFile(path, text, prior.text);
        try {
          await profileHttp(config.endpoint, '/v8/management/config', keys.admin, config.timeoutMs, signal, patch(plan, 'after'), [keys.admin, keys.client]);
          const observed = await stableSnapshot(keys, signal);
          if (!same(observed, plan.after)) throw new ProxyFault('profile_verification_failed');
          await verifyCatalogue(keys, plan, signal);
          const next = JSON.stringify({ ...journal, state: 'applied' });
          await writePrivateFile(path, next, text); text = next; return journal.id;
        } catch (error) {
          const code = safeFailure(error);
          try { await writePrivateFile(path, JSON.stringify({ ...journal, state: 'uncertain', error: code }), text); }
          catch { throw new ProxyFault('profile_journal_failed_effects_unknown'); }
          throw new ProxyFault(`profile_effects_uncertain_${code}`);
        }
      });
    },
    async rollback(approvedId: string, signal: AbortSignal) {
      writesEnabled(); return locked(async () => {
        const previous = await journalFile(path), journal = previous.value;
        if (!journal || journal.id !== approvedId || journal.plan.target !== targetStamp(config)) throw new ProxyFault('profile_rollback_reference_invalid');
        if (journal.state === 'rolled-back') return;
        const keys = await credentials(signal), current = await stableSnapshot(keys, signal);
        if (!same(current, journal.plan.before) && !same(current, journal.plan.after)) throw new ProxyFault('profile_rollback_conflict');
        let text = previous.text;
        if (!same(current, journal.plan.before)) {
          const pending = JSON.stringify({ ...journal, state: 'rolling-back' }); await writePrivateFile(path, pending, text); text = pending;
          try {
            await profileHttp(config.endpoint, '/v8/management/config', keys.admin, config.timeoutMs, signal, patch(journal.plan, 'before'), [keys.admin, keys.client]);
            if (!same(await stableSnapshot(keys, signal), journal.plan.before)) throw new ProxyFault('profile_rollback_verification_failed');
          } catch (error) { throw new ProxyFault(`profile_rollback_uncertain_${safeFailure(error)}`); }
        }
        try { await writePrivateFile(path, JSON.stringify({ ...journal, state: 'rolled-back' }), text); }
        catch { throw new ProxyFault('profile_rollback_journal_failed'); }
      });
    },
    async transactionId(): Promise<string | undefined> { return (await journalFile(path)).value?.id; },
  };
}
