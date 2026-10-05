import { isContextOverflow, type AssistantMessage, type FetchFunction } from '@earendil-works/pi-ai';

/** OpenAI SDK parsers log malformed raw SSE frames. Reject them before parsing, without global console hooks. */
export function protectedFetch(upstream: FetchFunction = globalThis.fetch): FetchFunction {
  return async (input, init) => {
    const response = await upstream(input, { ...init, redirect: 'error' });
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
        if (Buffer.byteLength(pending) > 2000000) throw new Error('cpa_stream_frame_too_large');
        let split: RegExpMatchArray | null;
        while ((split = pending.match(/\r?\n\r?\n/))) {
          const frame = pending.slice(0, split.index);
          pending = pending.slice(split.index! + split[0].length);
          const fields = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, ''));
          const data = fields.join('\n');
          if (data && data !== '[DONE]') {
            try { JSON.parse(data); } catch { throw new Error('cpa_stream_frame_invalid'); }
          }
          controller.enqueue(encoder.encode(frame + '\n\n'));
        }
      },
      flush() {
        pending += decoder.decode();
        // A partial terminal frame cannot be interpreted safely or logged verbatim.
        if (pending.trim()) throw new Error('cpa_stream_frame_truncated');
      },
    });
    return new Response(response.body.pipeThrough(filter), { status: response.status, headers: response.headers });
  };
}
