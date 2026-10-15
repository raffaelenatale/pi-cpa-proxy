import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProxyFault, readLayers, safeFailure, userConfigPath } from './configuration.ts';
import { openGateway, type GatewayHealth } from './gateway.ts';
import { runSetup } from './setup.ts';
import { syncPiWebAccess } from './integrations.ts';
import { runAdministration } from './admin-command.ts';
import { runServerProfileCommand } from './profile-command.ts';
import { profileMapRows, profileMapText, profileShortcuts, type ProfileMapRow } from './profile-map.ts';
import { DEFAULT_SEARCH_DESCRIPTION, runSearch, type SearchSource } from './search-tools.ts';
import type { SearchTool } from './schema.ts';

export default async function attachProxy(pi: ExtensionAPI): Promise<void> {
  const bundledPath = fileURLToPath(new URL('../config.yaml', import.meta.url));
  const localPath = userConfigPath();
  const gateways: { id: string; health: GatewayHealth }[] = [];
  let startupError: string | undefined;
  let configured = false;
  let webSearchStatus: string | undefined;
  const profileCommands: { suffix: string; connection: string; profile: string }[] = [];
  const searchTools: [string, SearchTool][] = [];
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
    // Optional, local-only: point pi-web-access at CPA's Gemini endpoint. A failure never blocks startup or providers.
    const web = layers.config?.integrations?.piWebAccess;
    if (web && layers.config) {
      try {
        const outcome = await syncPiWebAccess(web, layers.config.connections[web.connection]);
        webSearchStatus = outcome.status === 'unchanged' ? 'ok' : `${outcome.status} (effective from the next session; /reload may be needed)`;
      } catch (error) { webSearchStatus = `error=${safeFailure(error)}`; }
    }
    searchTools.push(...Object.entries(layers.config?.integrations?.searchTools ?? {}));
  } catch (error) { startupError = safeFailure(error); }

  // integrations.searchTools: model-callable search served by a connection model (e.g. a CPA alias that
  // CPA forwards to a grounded upstream). Names and presence are fixed at startup; settings are re-read per call.
  for (const [name, startupTool] of searchTools) {
    try {
      pi.registerTool(defineTool({
        name,
        label: startupTool.label ?? name,
        description: startupTool.description ?? DEFAULT_SEARCH_DESCRIPTION,
        promptSnippet: `${name}: ${startupTool.description ?? DEFAULT_SEARCH_DESCRIPTION}`,
        parameters: Type.Object({
          query: Type.String({ description: 'Question or search query, self-contained (include names, versions, dates).' }),
          language: Type.Optional(Type.String({ description: 'Answer language, e.g. "Italian". Default: the language of the query.' })),
        }),
        async execute(_id, params, signal): Promise<{ content: { type: 'text'; text: string }[]; details: { model?: string; connection?: string; sources?: SearchSource[]; error?: string } }> {
          try {
            const layers = await readLayers(bundledPath, localPath);
            const tool = layers.config?.integrations?.searchTools?.[name];
            const gateway = tool && layers.config?.connections[tool.connection];
            if (!tool || !gateway) throw new ProxyFault('search_tool_not_configured');
            const answer = await runSearch(tool, gateway, params.query, { language: params.language, signal });
            return {
              content: [{ type: 'text' as const, text: `${answer.text}\n\n(${answer.sources.length} sources; model ${answer.model} via ${tool.connection})` }],
              details: { model: answer.model, connection: tool.connection, sources: answer.sources },
            };
          } catch (error) {
            return { content: [{ type: 'text' as const, text: `${name}: ${safeFailure(error)}` }], details: { error: safeFailure(error) } };
          }
        },
      }));
    } catch { /* name collision with another extension's tool: skip */ }
  }

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
        [...gateways.map(({ id, health }) => `${id}: ${health.source}; omitted=${health.omitted}; missingProfiles=${health.missingProfiles}; error=${health.error ?? 'none'}; cache=${health.cacheError ?? 'ok'}`),
          ...(webSearchStatus ? [`pi-web-access: ${webSearchStatus}`] : []),
          ...searchTools.map(([name, tool]) => `search tool ${name}: ${tool.connection}/${tool.model}`)].join('\n') || 'CPA has no configured connections.';
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
