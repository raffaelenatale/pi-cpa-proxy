import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { ProxyFault } from './configuration.ts';
import { openServerProfiles, profileStamp } from './server-profiles.ts';
import type { Configuration } from './schema.ts';

export async function runServerProfileCommand(ctx: ExtensionCommandContext, configuration: Configuration | undefined,
  stateDirectory: string, beforeWrite?: () => Promise<void>): Promise<void> {
  if (!ctx.hasUI) throw new ProxyFault('profile_requires_explicit_ui_approval');
  const connections = Object.entries(configuration?.connections ?? {}).filter(([, gateway]) => gateway.serverAdmin);
  if (!connections.length) throw new ProxyFault('profile_admin_not_configured');
  await ctx.waitForIdle();
  const choice = await ctx.ui.select('CPA server aliases & compatible groups', connections.map(([id]) => id));
  if (!choice) return;
  const gateway = connections.find(([id]) => id === choice)?.[1];
  if (!gateway?.serverAdmin) throw new ProxyFault('profile_selection_invalid');
  const client = openServerProfiles(gateway.serverAdmin, gateway, stateDirectory);
  const action = await ctx.ui.select('Explicit server alias administration', ['Read-only status', 'Preview / publish server aliases', 'Rollback latest publication']);
  if (!action) return;
  const signal = () => AbortSignal.timeout(60000);
  if (action === 'Read-only status') {
    const status = await client.inspect(signal());
    const groupsLabel = status.compatiblePrimaryFallback ? 'configured' : 'none';
    ctx.ui.notify(`OAuth channels=${status.channels}; configured=${status.configuredAliases}; owned=${status.ownedAliases}; transaction=${status.transaction}; writes=${status.writes ? 'enabled' : 'disabled'}; CAS=unavailable; compatible primary/fallback=${groupsLabel}`, 'info');
  } else if (action === 'Preview / publish server aliases') {
    const plan = await client.preview(signal());
    if (!plan.changed.length) { ctx.ui.notify('No alias changes. No server writes.', 'info'); return; }
    const summary = plan.changed.map((alias) => {
      const before = Object.entries(plan.before.aliases).flatMap(([channel, rows]) => rows.filter((row) => row.alias.toLowerCase() === alias.toLowerCase()).map((row) => {
        const context = plan.before.settings[channel].filter((setting) => setting.alias?.toLowerCase() === alias.toLowerCase());
        return `${channel}/${row.name}; fork=${row.fork}; force-mapping=${row['force-mapping']}; context=${JSON.stringify(context)}`;
      }));
      const oauthSpec = gateway.serverAdmin!.aliases[alias];
      if (oauthSpec) {
        return `${alias}: ${before.join(', ') || 'absent'} → ${oauthSpec.channel}/${oauthSpec.model}; context=${oauthSpec.contextWindow}; fork=true (original retained)`;
      }
      const groupSpec = gateway.serverAdmin!.compatibleGroups[alias];
      if (groupSpec) {
        return `${alias} (compatible group): ${before.join(', ') || 'absent'} → primary=${groupSpec.primary.channel}/${groupSpec.primary.model}, fallback=${groupSpec.fallback.channel}/${groupSpec.fallback.model}; context=${groupSpec.contextWindow}; fork=true`;
      }
      return `${alias}: updated`;
    }).join('\n');
    if (Buffer.byteLength(summary) > 64000) throw new ProxyFault('profile_preview_too_large_split_scope');
    ctx.ui.notify(summary, 'info');
    if (!gateway.serverAdmin.allowProfileWrites) { ctx.ui.notify('Read-only preview: profile writes disabled.', 'info'); return; }
    if (!await ctx.ui.confirm('Publish these server aliases to CPA?', `${summary}\nA single scoped PATCH updates alias/context lists on existing channels. Other alias rows and config sections are retained. Successful v8 writes may migrate the whole persisted layout; rollback restores these alias lists, NOT the former layout/comments. Stop all config writers; server CAS unavailable. Catalogue verification proves listing only, not completions or fallback.`)) return;
    await beforeWrite?.();
    const transaction = await client.apply(plan, profileStamp(plan), signal());
    ctx.ui.notify(`Server alias config and catalogue verified. Transaction: ${transaction}`, 'info');
  } else {
    const transaction = await client.transactionId();
    if (!transaction) { ctx.ui.notify('No publication to roll back.', 'info'); return; }
    if (!await ctx.ui.confirm('Rollback latest alias publication?', `Restore owned channel lists for ${transaction}? Refuses changed alias/context snapshots. Layout migration and comments cannot be undone through this secret-free adapter. Stop all config writers.`)) return;
    await beforeWrite?.(); await client.rollback(transaction, signal());
    ctx.ui.notify(`Alias configuration rollback verified: ${transaction}`, 'info');
  }
}
