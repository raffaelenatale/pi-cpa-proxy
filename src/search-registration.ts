import type { Type as TypeBuilder } from '@earendil-works/pi-ai';
import { ProxyFault, readLayers, safeFailure } from './configuration.ts';
import { DEFAULT_SEARCH_DESCRIPTION, runSearch, type SearchSource } from './search-tools.ts';
import type { SearchTool } from './schema.ts';

export interface SearchToolDetails { model?: string; connection?: string; sources?: SearchSource[]; error?: string }
export interface SearchToolResult { content: { type: 'text'; text: string }[]; details: SearchToolDetails }

/**
 * Model-callable tool for one `integrations.searchTools` entry. Shared by the Pi and omp entries: both hosts
 * take the same name/description/schema/execute shape, so the behaviour cannot drift between them.
 * Name and presence are fixed at startup; connection, model and timeout are re-read from the configuration on each call.
 */
export function searchToolDefinition(name: string, startup: SearchTool, Type: typeof TypeBuilder, paths: { bundled: string; local: string }) {
  const description = startup.description ?? DEFAULT_SEARCH_DESCRIPTION;
  return {
    name,
    label: startup.label ?? name,
    description,
    promptSnippet: `${name}: ${description}`,
    parameters: Type.Object({
      query: Type.String({ description: 'Question or search query, self-contained (include names, versions, dates).' }),
      language: Type.Optional(Type.String({ description: 'Answer language, e.g. "Italian". Default: the language of the query.' })),
    }),
    async execute(_id: string, params: { query: string; language?: string }, signal: AbortSignal | undefined, onUpdate: ((update: SearchToolResult) => void) | undefined): Promise<SearchToolResult> {
      try {
        const layers = await readLayers(paths.bundled, paths.local);
        const tool = layers.config?.integrations?.searchTools?.[name];
        const gateway = tool && layers.config?.connections[tool.connection];
        if (!tool || !gateway) throw new ProxyFault('search_tool_not_configured');
        let progress = '';
        const onProgress = (text: string) => {
          progress = (progress + text).slice(-4000);
          onUpdate?.({ content: [{ type: 'text', text: progress }], details: { connection: tool.connection } });
        };
        const answer = await runSearch(tool, gateway, params.query, { language: params.language, signal, onProgress });
        return {
          content: [{ type: 'text', text: `${answer.text}\n\n(${answer.sources.length} sources; model ${answer.model} via ${tool.connection})` }],
          details: { model: answer.model, connection: tool.connection, sources: answer.sources },
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `${name}: ${safeFailure(error)}` }], details: { error: safeFailure(error) } };
      }
    },
  };
}
