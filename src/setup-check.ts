import { deriveCatalogue } from './catalogue.ts';
import { ProxyFault, safeFailure } from './configuration.ts';
import { resolveSecret } from './credentials.ts';
import { requestListing } from './gateway.ts';
import type { Gateway } from './schema.ts';

export type SetupCheck =
  | { ok: true; listed: number; usable: number; omitted: number; missingProfiles: number }
  | { ok: false; code: string };

/** Explicit client discovery only: no provider registration, cache, completion or management request. */
export async function checkSetupConnection(id: string, connection: Gateway, signal: AbortSignal): Promise<SetupCheck> {
  try {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(connection.timeoutMs + 6000)]);
    const key = await resolveSecret(connection.credential, bounded);
    if (!key) throw new ProxyFault('credential_missing');
    const listing = await requestListing(connection, key, bounded);
    const catalogue = deriveCatalogue(id, connection, listing);
    bounded.throwIfAborted();
    return { ok: true, listed: new Set(listing.map((entry) => entry.id)).size,
      usable: catalogue.models.length, omitted: catalogue.omitted, missingProfiles: catalogue.missingProfiles };
  } catch (error) {
    return { ok: false, code: signal.aborted ? 'setup_check_aborted' : safeFailure(error) };
  }
}
export function setupCheckSummary(result: SetupCheck): string {
  if (!result.ok) return `Discovery check failed: ${result.code}. Check the external credential, CPA origin and connectivity. Saving unverified configuration remains optional.`;
  return `Discovery succeeded: listed=${result.listed}; usable=${result.usable}; omitted=${result.omitted}; missingProfiles=${result.missingProfiles}. ` +
    (result.usable ? '' : 'No executable model resolved. ') +
    'Unknown models need explicit metadata/source overrides in the advanced YAML editor; profiles must be published by the server. ' +
    'Listing does not certify the selected completion protocol, tools, images, routing or effective context.';
}
