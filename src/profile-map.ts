import { deriveCatalogue } from './catalogue.ts';
import { effortLevels, type Gateway } from './schema.ts';

export interface ProfileMapRow { profile: string; default: string; fallback: string; context: string; efforts: string; usage: string }

/** Display name of a member model: configured name, else its id. */
function modelLabel(gateway: Gateway, id: string): string { return gateway.models[id]?.name ?? id; }

/** 1000000 -> "1.000.000" (Italian grouping, independent of the runtime ICU data). */
function groupThousands(value: number): string { return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }

function describeEfforts(map: Partial<Record<(typeof effortLevels)[number], string | null>> | undefined, reasoning: boolean): string {
  if (!reasoning) return 'nessuno';
  // A level is selectable unless explicitly mapped to null; a missing key means the identity mapping.
  const levels = effortLevels.filter((level) => map?.[level] !== null);
  if (!levels.length) return 'nessuno';
  const values = new Set(levels.map((level) => map?.[level] ?? level));
  if (levels.length > 1 && values.size === 1) return `solo ${[...values][0]} (effort fisso)`;
  return levels.join(', ');
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
      context: model ? groupThousands(model.contextWindow) : 'n/d',
      efforts: model ? describeEfforts(model.thinkingLevelMap as never, model.reasoning) : 'n/d',
      usage: profile.description ?? '',
    };
  });
}

const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function renderProfileMap(rows: ProfileMapRow[]): string {
  if (!rows.length) return 'Nessun profilo configurato.';
  const head = '| Profilo | Default | Fallback | Contesto | Effort possibili | Quando usarlo |\n|---|---|---|---|---|---|';
  return [head, ...rows.map((row) => `| ${[row.profile, row.default, row.fallback, row.context, row.efforts, row.usage].map(cell).join(' | ')} |`)].join('\n');
}
