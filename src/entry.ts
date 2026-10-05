import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProxyFault, readLayers, safeFailure, userConfigPath } from './configuration.ts';
import { openGateway, type GatewayHealth } from './gateway.ts';
import { runSetup } from './setup.ts';
import { runAdministration } from './admin-command.ts';
import { runServerProfileCommand } from './profile-command.ts';

export default async function attachProxy(pi: ExtensionAPI): Promise<void> {
  const bundledPath = fileURLToPath(new URL('../config.yaml', import.meta.url));
  const localPath = userConfigPath();
  const gateways: { id: string; health: GatewayHealth }[] = [];
  let startupError: string | undefined;
  let configured = false;
  try {
    const layers = await readLayers(bundledPath, localPath);
    configured = !!layers.config;
    for (const [id, connection] of Object.entries(layers.config?.connections ?? {})) {
      const opened = await openGateway(id, connection, join(dirname(localPath), 'cache'));
      // Pi registers new native providers cache-only; fetch in the awaited factory so
      // startup selection and --list-models see a usable catalogue on first install.
      try {
        await opened.provider.refreshModels?.({
          allowNetwork: !['1', 'true', 'yes'].includes((process.env.PI_OFFLINE ?? '').toLowerCase()),
          signal: AbortSignal.timeout(connection.timeoutMs + 6000),
          async publish({ update }) { update?.(); return true; },
        });
      } catch { /* Health retains a redacted code; no invented fallback models. */ }
      pi.registerProvider(opened.provider);
      gateways.push({ id, health: opened.health });
    }
  } catch (error) { startupError = safeFailure(error); }

  pi.registerCommand('cpa-setup', {
    description: 'Configure CPA connections or edit validated YAML overrides (no server writes)',
    handler: async (_args, ctx) => {
      try {
        if (await runSetup(ctx, bundledPath, localPath)) ctx.ui.notify('CPA config saved. Use /reload to activate.', 'info');
      } catch (error) { ctx.ui.notify(`CPA setup: ${safeFailure(error)}`, 'error'); }
    },
  });
  pi.registerCommand('cpa-admin', {
    description: 'Optional Manager Plus price status, approved apply and rollback (never at startup)',
    handler: async (_args, ctx) => {
      try {
        const current = await readLayers(bundledPath, localPath);
        await runAdministration(ctx, current.config, join(dirname(localPath), 'admin-state'), async () => {
          const latest = await readLayers(bundledPath, localPath);
          if (latest.fingerprint !== current.fingerprint) throw new ProxyFault('admin_config_changed_since_preview');
        });
      } catch (error) { ctx.ui.notify(`CPA admin: ${safeFailure(error)}`, 'error'); }
    },
  });
  pi.registerCommand('cpa-server-profiles', {
    description: 'Opt-in CPA OAuth alias publication and rollback (no compatible primary/fallback)',
    handler: async (_args, ctx) => {
      try {
        const current = await readLayers(bundledPath, localPath);
        await runServerProfileCommand(ctx, current.config, join(dirname(localPath), 'profile-state'), async () => {
          const latest = await readLayers(bundledPath, localPath);
          if (latest.fingerprint !== current.fingerprint) throw new ProxyFault('profile_config_changed_since_preview');
        });
      } catch (error) { ctx.ui.notify(`CPA server profiles: ${safeFailure(error)}`, 'error'); }
    },
  });
  pi.registerCommand('cpa-status', {
    description: 'Show credential-free CPA catalogue/config health',
    handler: async (_args, ctx) => {
      const text = startupError ? `CPA startup: ${startupError}` : !configured ? 'CPA not configured. Use /cpa-setup.' :
        gateways.map(({ id, health }) => `${id}: ${health.source}; omitted=${health.omitted}; missingProfiles=${health.missingProfiles}; error=${health.error ?? 'none'}; cache=${health.cacheError ?? 'ok'}`).join('\n') || 'CPA has no configured connections.';
      ctx.ui.notify(text, startupError ? 'error' : 'info');
    },
  });
  pi.registerCommand('cpa-refresh-models', {
    description: 'Refresh configured CPA catalogues without changing server routing',
    handler: async (_args, ctx) => {
      try {
        await ctx.waitForIdle();
        const result = await ctx.modelRegistry.refresh({ providers: gateways.map(({ id }) => id), force: true });
        const errors = [...result.errors.values()].map(safeFailure);
        ctx.ui.notify(errors.length ? `CPA refresh: ${errors.join(', ')}` : result.aborted ? 'CPA refresh cancelled' : 'CPA catalogues refreshed', errors.length ? 'error' : 'info');
      } catch (error) { ctx.ui.notify(`CPA refresh: ${safeFailure(error)}`, 'error'); }
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.hasUI && (startupError || !configured)) ctx.ui.notify(startupError ? `CPA config: ${startupError}` : 'CPA: run /cpa-setup to configure.', startupError ? 'error' : 'info');
  });
}
