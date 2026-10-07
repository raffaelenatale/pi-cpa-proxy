import { isContextOverflow, type AssistantMessage, type FetchFunction } from '@earendil-works/pi-ai';
import { logStreamEvent } from './logger.ts';

/** OpenAI SDK parsers log malformed raw SSE frames. Reject them before parsing, without global console hooks. */
export function protectedFetch(upstream: FetchFunction = globalThis.fetch): FetchFunction {
  return async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    logStreamEvent('INFO', 'HTTP_REQUEST', {
      url: urlStr,
      method: init?.method ?? 'GET',
    });
    let response: Response;
    try {
      response = await upstream(input, { ...init, redirect: 'error' });
    } catch (netErr) {
      logStreamEvent('ERROR', 'HTTP_NETWORK_ERROR', {
        url: urlStr,
        error: netErr instanceof Error ? { message: netErr.message, stack: netErr.stack } : String(netErr),
      });
      throw netErr;
    }
    if (!response.ok) {
      let privateText = '';
      const reader = response.body?.getReader();
      if (reader) {
        try {
          const chunks: Uint8Array[] = []; let size = 0;
          for (;;) {
            const next = await reader.read(); if (next.done) break;
            size += next.value.length; if (size > 64000) break;
            chunks.push(next.value);
          }
          privateText = Buffer.concat(chunks).toString('utf8');
        } catch { /* Only a safe code is returned, including on truncated/error bodies. */ }
        finally { await reader.cancel().catch(() => {}); }
      }
      logStreamEvent('ERROR', 'HTTP_ERROR_RESPONSE', {
        url: urlStr,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        rawResponseBody: privateText,
      });
      const overflow = isContextOverflow({ stopReason: 'error', errorMessage: privateText } as AssistantMessage);
      // Keep status and retry headers, never hand an untrusted error body to the SDK.
      const message = overflow ? 'cpa_context_length_exceeded' : 'cpa_http_failed';
      return new Response(JSON.stringify({ error: { message, type: 'cpa_http_failed', code: `http_${response.status}` } }), {
        status: response.status, headers: response.headers,
      });
    }
    if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) return response;
    const decoder = new TextDecoder(), encoder = new TextEncoder();
    let pending = '';
    const filter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        if (Buffer.byteLength(pending) > 2000000) {
          logStreamEvent('ERROR', 'STREAM_FRAME_TOO_LARGE', { size: Buffer.byteLength(pending) });
          throw new Error('cpa_stream_frame_too_large');
        }
        let split: RegExpMatchArray | null;
        while ((split = pending.match(/\r?\n\r?\n/))) {
          const frame = pending.slice(0, split.index);
          pending = pending.slice(split.index! + split[0].length);
          const fields = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, ''));
          const data = fields.join('\n');
          if (data && data !== '[DONE]') {
            try { JSON.parse(data); } catch (jsonErr) {
              logStreamEvent('ERROR', 'STREAM_FRAME_INVALID_JSON', { rawFrame: frame });
              throw new Error('cpa_stream_frame_invalid');
            }
          }
          controller.enqueue(encoder.encode(frame + '\n\n'));
        }
      },
      flush() {
        pending += decoder.decode();
        // A partial terminal frame cannot be interpreted safely or logged verbatim.
        if (pending.trim()) {
          logStreamEvent('ERROR', 'STREAM_FRAME_TRUNCATED', { pending });
          throw new Error('cpa_stream_frame_truncated');
        }
      },
    });
    return new Response(response.body.pipeThrough(filter), { status: response.status, headers: response.headers });
  };
}
