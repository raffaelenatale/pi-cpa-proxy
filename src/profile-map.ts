import { deriveCatalogue } from './catalogue.ts';
import { effortLevels, type Gateway } from './schema.ts';

export interface ProfileMapRow { profile: string; default: string; fallback: string; efforts: string; role: string }

/** Display name of a member model: configured name, else its id. */
function modelLabel(gateway: Gateway, id: string): string { return gateway.models[id]?.name ?? id; }

function describeEfforts(map: Partial<Record<(typeof effortLevels)[number], string | null>> | undefined, reasoning: boolean): string {
  if (!reasoning) return 'nessuno';
  // A level is selectable unless explicitly mapped to null; a missing key means the identity mapping.
  const levels = effortLevels.filter((level) => map?.[level] !== null);
  if (!levels.length) return 'nessuno';
  const values = new Set(levels.map((level) => map?.[level] ?? level));
  if (levels.length > 1 && values.size === 1) return `fisso \`${[...values][0]}\``;
  return levels.map((level) => `\`${level}\``).join(', ');
}

/** One row per configured profile, in configuration order. Pure: no network, no server state. */
export function profileMapRows(provider: string, gateway: Gateway): ProfileMapRow[] {
  const ids = Object.keys(gateway.profiles);
  const derived = new Map(deriveCatalogue(provider, gateway, ids.map((id) => ({ id }))).models.map((model) => [model.id, model]));
  return ids.map((id) => {
    const profile = gateway.profiles[id];
    const model = derived.get(id);
    const fallback = profile.fallback ?? profile.members[1];
    return {
      profile: id,
      default: modelLabel(gateway, profile.members[0]),
      fallback: fallback ? modelLabel(gateway, fallback) : 'nessuno',
      efforts: model ? describeEfforts(model.thinkingLevelMap as never, model.reasoning) : 'n/d',
      role: profile.description ?? '',
    };
  });
}

const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function renderProfileMap(rows: ProfileMapRow[]): string {
  if (!rows.length) return 'Nessun profilo configurato.';
  const head = '| Profilo | Default | Fallback | Effort possibili | Ruolo |\n|---|---|---|---|---|';
  return [head, ...rows.map((row) => `| \`${cell(row.profile)}\` | ${cell(row.default)} | ${cell(row.fallback)} | ${cell(row.efforts)} | ${cell(row.role)} |`)].join('\n');
}
