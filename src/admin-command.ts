import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { managementStamp, openPriceAdministrator } from './management.ts';
import { ProxyFault } from './configuration.ts';
import type { Configuration } from './schema.ts';

export async function runAdministration(ctx: ExtensionCommandContext, config: Configuration | undefined, stateDirectory: string, beforeWrite?: () => Promise<void>): Promise<void> {
  if (!ctx.hasUI) throw new ProxyFault('admin_requires_explicit_ui_approval');
  const entries = Object.entries(config?.connections ?? {}).filter(([, connection]) => !!connection.admin);
  if (!entries.length) throw new ProxyFault('admin_not_configured');
  await ctx.waitForIdle();
  const selected = await ctx.ui.select('CPA administration (separate admin credential)', entries.map(([id]) => id));
  if (!selected) return;
  const entry = entries.find(([id]) => id === selected);
  if (!entry?.[1].admin) throw new ProxyFault('admin_selection_invalid');
  const client = openPriceAdministrator(entry[1].admin, stateDirectory);
  const action = await ctx.ui.select('Manager Plus prices — no automatic server changes', ['Read-only status', 'Preview / apply configured prices', 'Rollback latest transaction']);
  if (!action) return;
  // Each interaction creates its own bounded operation; never retain a signal across user dialogs.
  const signal = () => AbortSignal.timeout(60000);
  if (action === 'Read-only status') {
    const status = await client.inspect(signal());
    ctx.ui.notify(`Prices readable; count=${status.priceCount}; configuredScope=${status.scopeCount}; writes=${status.priceWriteEnabled ? 'enabled' : 'disabled'}; transaction=${status.transaction}; server CAS=unavailable`, 'info');
  } else if (action === 'Preview / apply configured prices') {
    const plan = await client.preview(signal());
    if (!plan.changed.length) { ctx.ui.notify('Configured prices already match. No server writes.', 'info'); return; }
    const summary = plan.changed.map((id) => {
      const old = plan.before[id], next = plan.after[id];
      // Show full pricing rules, not just counts: a same-size tier list can contain very different rates.
      // Deliberately omit rawJson bodies and arbitrary upstream source strings from notifications.
      const view = (price: typeof old | undefined) => price ? JSON.stringify({
        input: price.prompt, output: price.completion, cache: price.cache,
        cacheRead: price.cacheRead ?? 0, cacheWrite: price.cacheCreation ?? 0,
        configured: { input: price.promptConfigured ?? false, output: price.completionConfigured ?? false,
          cacheRead: price.cacheReadConfigured ?? false, cacheWrite: price.cacheCreationConfigured ?? false },
        contextTiers: price.contextTiers ?? [], serviceTiers: price.serviceTiers ?? [],
        rawMetadataPresent: !!price.rawJson, source: price.source ? 'existing metadata' : 'absent',
      }) : 'absent';
      return `${id}:\nBEFORE ${view(old)}\nAFTER ${view(next)}`;
    }).join('\n');
    if (Buffer.byteLength(summary) > 64000) throw new ProxyFault('admin_preview_too_large_split_scope');
    ctx.ui.notify(summary, 'info');
    if (!entry[1].admin.allowPriceWrites) { ctx.ui.notify('Preview only: allowPriceWrites is disabled.', 'info'); return; }
    const agreed = await ctx.ui.confirm('Apply Manager Plus price replacement?', `${plan.changed.length} managed row(s) change; unrelated rows retained. Advanced rules on managed rows are replaced by configured rules.\nFull-table PUT has no server CAS. Stop all other price writers during this operation.\n${summary}`);
    if (!agreed) return;
    await beforeWrite?.();
    const id = await client.apply(plan, managementStamp(plan), signal());
    ctx.ui.notify(`Prices applied and read-back verified. Rollback transaction: ${id}`, 'info');
  } else {
    const id = await client.transactionId();
    if (!id) { ctx.ui.notify('No latest transaction to roll back.', 'info'); return; }
    if (!await ctx.ui.confirm('Rollback latest price transaction?', `Restore the full before-snapshot for transaction ${id}? Refuses if the current table has conflicting changes. Stop all other price writers.`)) return;
    await beforeWrite?.();
    await client.rollback(id, signal());
    ctx.ui.notify(`Price rollback verified: ${id}`, 'info');
  }
}
