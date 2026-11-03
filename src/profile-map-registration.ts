import type { Type as TypeBuilder } from '@earendil-works/pi-ai';
import { readLayers, safeFailure } from './configuration.ts';
import { profileMapRows, profileMapText, type ProfileMapRow } from './profile-map.ts';

export interface ProfileMapDetails { connections?: { id: string; rows: ProfileMapRow[] }[]; error?: string }
export interface ProfileMapResult { content: { type: 'text'; text: string }[]; details: ProfileMapDetails }

/**
 * Model-callable `cpa_profile_map` tool: lets the LLM read the profile table when it has to choose a model.
 * Shared by the Pi and omp entries: both hosts take the same name/description/schema/execute shape, so the
 * behaviour cannot drift between them. The configuration is re-read on every call.
 */
export function profileMapToolDefinition(Type: typeof TypeBuilder, paths: { bundled: string; local: string }) {
  return {
    name: 'cpa_profile_map',
    label: 'CPA profile map',
    description: 'Table of the CPA role profiles (profile-*): default model, fallback, context window, selectable effort levels and when to use each. Call it before choosing a model for a task, subagent or delegation, then use the exact profile id as `<provider>/<profile>`.',
    promptSnippet: 'cpa_profile_map: table of the CPA profile-* models (default, fallback, context, effort, when to use); consult it before choosing a model',
    promptGuidelines: ['When you must choose or recommend a model (subagent, delegation, switching model), call cpa_profile_map first and choose by its "Quando usarlo" column. Never pick a profile whose text says "Da non usare".'],
    parameters: Type.Object({}),
    async execute(): Promise<ProfileMapResult> {
      try {
        const layers = await readLayers(paths.bundled, paths.local);
        const connections = Object.entries(layers.config?.connections ?? {});
        const text = connections.length ? profileMapText(connections, true) : 'CPA non configurato: nessun profilo disponibile.';
        return { content: [{ type: 'text', text }], details: { connections: connections.map(([id, gateway]) => ({ id, rows: profileMapRows(id, gateway) })) } };
      } catch (error) {
        return { content: [{ type: 'text', text: `CPA profile map: ${safeFailure(error)}` }], details: { error: safeFailure(error) } };
      }
    },
  };
}
