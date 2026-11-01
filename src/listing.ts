import { z } from "zod";
import type { ListingEntry } from "./catalogue.ts";
import { ProxyFault } from "./configuration.ts";
import type { Gateway } from "./schema.ts";

export async function requestListing(gateway: Gateway, key: string, signal: AbortSignal): Promise<ListingEntry[]> {
  let response: Response;
  try {
    response = await fetch(`${gateway.endpoint.replace(/\/$/, '')}/v1/models`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(gateway.timeoutMs)]),
    });
  } catch { throw new ProxyFault(signal.aborted ? 'catalogue_aborted' : 'catalogue_network_failed'); }
  if (!response.ok) { await response.body?.cancel(); throw new ProxyFault(`catalogue_http_${response.status}`); }
  // Bound the response during streaming, not after buffering an untrusted server body.
  const reader = response.body?.getReader();
  if (!reader) throw new ProxyFault('catalogue_body_missing');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > 2_000_000) throw new ProxyFault('catalogue_too_large');
      chunks.push(item.value);
    }
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const decoded = z.object({ data: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/).max(256) })).max(10000) }).safeParse(raw);
    if (!decoded.success) throw new ProxyFault('catalogue_shape_invalid');
    return decoded.data.data.map(({ id }) => ({ id }));
  } catch (error) { throw error instanceof ProxyFault ? error : new ProxyFault('catalogue_body_invalid'); }
  finally { await reader.cancel().catch(() => {}); }
}
