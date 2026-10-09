import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProxyFault, readLayers, safeFailure, userConfigPath } from './configuration.ts';
import { openGateway, type GatewayHealth } from './gateway.ts';
import { runSetup } from './setup.ts';
import { runAdministration } from './admin-command.ts';
import { runServerProfileCommand } from './profile-command.ts';
import { profileMapRows, profileMapText, profileShortcuts, type ProfileMapRow } from './profile-map.ts';

export default async function attachProxy(pi: ExtensionAPI): Promise<void> {
  const bundledPath = fileURLToPath(new URL('../config.yaml', import.meta.url));
  const localPath = userConfigPath();
  const gateways: { id: string; health: GatewayHealth }[] = [];
  let startupError: string | undefined;
  let configured = false;
  const profileCommands: { suffix: string; connection: string; profile: string }[] = [];
  try {
    const layers = await readLayers(bundledPath, localPath);
    configured = !!layers.config;
    profileCommands.push(...profileShortcuts(Object.entries(layers.config?.connections ?? {})));
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

  // /<suffix> model shortcuts: profile-high -> /high selects profile-high for this session.
  for (const { suffix, connection, profile } of profileCommands) {
    try {
      pi.registerCommand(suffix, {
        description: `Switch model to ${profile} (${connection})`,
        handler: async (_args, ctx) => {
          try {
            const layers = await readLayers(bundledPath, localPath);
            if (!layers.config?.connections[connection]?.profiles[profile]) throw new ProxyFault('profile_not_found');
            const model = ctx.modelRegistry.getModelOfType('chat', connection, profile);
            if (!model) { ctx.ui.notify(`/${suffix}: ${profile} not in the catalogue. Try /cpa-refresh-models.`, 'error'); return; }
            await ctx.waitForIdle();
            const switched = await pi.setModel(model);
            ctx.ui.notify(switched ? `Model: ${model.provider}/${model.id}` : `/${suffix}: authentication not configured for ${connection}.`, switched ? 'info' : 'error');
          } catch (error) { ctx.ui.notify(`/${suffix}: ${safeFailure(error)}`, 'error'); }
        },
      });
    } catch { /* name collision with another command: skip this suffix */ }
  }

  // Transcript-only rendering (entries never reach the model). Falls back to a notification if the host lacks the UI modules.
  let entryRendered = false;
  try {
    const [{ Box, Markdown }, { getMarkdownTheme }] = await Promise.all([import('@earendil-works/pi-tui'), import('@earendil-works/pi-coding-agent')]);
    pi.registerEntryRenderer<{ text: string }>('cpa-profile-map', (entry, _options, theme) => {
      const box = new Box(1, 1, (text: string) => theme.bg('customMessageBg', text));
      box.addChild(new Markdown(entry.data?.text ?? '', 0, 0, getMarkdownTheme()));
      return box;
    });
    entryRendered = true;
  } catch { /* notify fallback below */ }
  // Model-callable: lets the LLM read the same table when it has to choose a model. Reads the configuration on every call.
  pi.registerTool(defineTool({
    name: 'cpa_profile_map',
    label: 'CPA profile map',
    description: 'Table of the CPA role profiles (profile-*): default model, fallback, context window, selectable effort levels and when to use each. Call it before choosing a model for a task, subagent or delegation, then use the exact profile id as `<provider>/<profile>`.',
    promptSnippet: 'cpa_profile_map: table of the CPA profile-* models (default, fallback, context, effort, when to use); consult it before choosing a model',
    promptGuidelines: ['When you must choose or recommend a model (subagent, delegation, switching model), call cpa_profile_map first and choose by its "Quando usarlo" column. Never pick a profile whose text says "Da non usare".'],
    parameters: Type.Object({}),
    async execute(): Promise<{ content: { type: 'text'; text: string }[]; details: { connections?: { id: string; rows: ProfileMapRow[] }[]; error?: string } }> {
      try {
        const layers = await readLayers(bundledPath, localPath);
        const connections = Object.entries(layers.config?.connections ?? {});
        const text = connections.length ? profileMapText(connections, true) : 'CPA non configurato: nessun profilo disponibile.';
        return { content: [{ type: 'text' as const, text }], details: { connections: connections.map(([id, gateway]) => ({ id, rows: profileMapRows(id, gateway) })) } };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `CPA profile map: ${safeFailure(error)}` }], details: { error: safeFailure(error) } };
      }
    },
  }));
  pi.registerCommand('profile-map', {
    description: 'Show the role profiles: default model, fallback, selectable effort levels and purpose',
    handler: async (_args, ctx) => {
      try {
        const layers = await readLayers(bundledPath, localPath);
        const connections = Object.entries(layers.config?.connections ?? {});
        if (!connections.length) { ctx.ui.notify('CPA not configured. Use /cpa-setup.', 'info'); return; }
        const text = profileMapText(connections);
        if (ctx.hasUI && entryRendered) pi.appendEntry('cpa-profile-map', { text });
        else ctx.ui.notify(text, 'info');
      } catch (error) { ctx.ui.notify(`CPA profile map: ${safeFailure(error)}`, 'error'); }
    },
  });
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
    description: 'Opt-in CPA OAuth alias/context mapping and rollback (server routing unchanged)',
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
