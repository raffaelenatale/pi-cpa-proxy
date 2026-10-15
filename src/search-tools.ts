import { ProxyFault } from "./configuration.ts";
import { resolveSecret } from "./credentials.ts";
import type { Gateway, SearchTool } from "./schema.ts";

export const DEFAULT_SEARCH_DESCRIPTION =
  "Search the web through a CPA model with built-in web grounding and return a sourced answer. Use it for current or external facts.";
const MAX_RESPONSE_BYTES = 4_000_000;
const MAX_QUERY_CHARS = 4000;

export interface SearchSource { title: string; url: string }
export interface SearchAnswer { text: string; sources: SearchSource[]; model: string }

/** Instructions sent with every query: the answer must carry its own sources as Markdown links. */
export function searchPrompt(query: string, language?: string): string {
  return [
    "Search the web and answer the question below. Base the answer on current web results, not on memory alone.",
    "Format: 1. a direct, concise answer; 2. a 'Sources' list of Markdown links ([title](https://...)) for every claim.",
    language ? `Answer in ${language}.` : "Answer in the language of the question.",
    "",
    `Question: ${query}`,
  ].join("\n");
}

/** Unique http(s) Markdown links and bare URLs found in the answer, in order of appearance. */
export function extractSources(text: string): SearchSource[] {
  const seen = new Map<string, SearchSource>();
  const add = (url: string, title: string) => {
    const clean = url.replace(/[).,;:\]]+$/, "");
    try { if (!["http:", "https:"].includes(new URL(clean).protocol)) return; } catch { return; }
    if (!seen.has(clean)) seen.set(clean, { title: title.trim() || clean, url: clean });
  };
  for (const match of text.matchAll(/\[([^\]\n]{0,300})\]\((https?:\/\/[^)\s]+)\)/g)) add(match[2], match[1]);
  for (const match of text.matchAll(/(?<![(\[])\bhttps?:\/\/[^\s<>()\]]+/g)) add(match[0], "");
  return [...seen.values()];
}

async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_RESPONSE_BYTES) throw new ProxyFault("search_response_too_large");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Raw prompt for agents that plan their own research (e.g. Deep Research): the query plus an optional language. */
export function rawPrompt(query: string, language?: string): string {
  return language ? `${query}\n\n(Answer in ${language}.)` : query;
}

function abortCode(callerSignal: AbortSignal | undefined, signal: AbortSignal, error: unknown): ProxyFault {
  if (callerSignal?.aborted) return new ProxyFault("search_aborted");
  if (signal.aborted) return new ProxyFault("search_timeout");
  return error instanceof ProxyFault ? error : new ProxyFault("search_network_failed");
}

/** Reads an OpenAI SSE stream: content is accumulated, reasoning lines are reported as progress. */
async function readStream(response: Response, onProgress?: (text: string) => void): Promise<{ text: string; model?: string }> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProxyFault("search_response_invalid");
  const decoder = new TextDecoder();
  let pending = "", text = "", model: string | undefined, size = 0;
  const handle = (frame: string) => {
    const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") return;
    let event: { model?: unknown; error?: { code?: unknown; type?: unknown }; choices?: { delta?: { content?: unknown; reasoning_content?: unknown } }[] };
    try { event = JSON.parse(data); } catch { throw new ProxyFault("search_response_invalid"); }
    if (event.error) {
      const code = typeof event.error.type === "string" && /^[a-z0-9_]{1,64}$/.test(event.error.type) ? event.error.type : "upstream_error";
      throw new ProxyFault(`search_stream_${code}`);
    }
    if (typeof event.model === "string") model = event.model;
    const delta = event.choices?.[0]?.delta;
    if (typeof delta?.content === "string") text += delta.content;
    if (typeof delta?.reasoning_content === "string" && delta.reasoning_content.trim()) onProgress?.(delta.reasoning_content);
  };
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_RESPONSE_BYTES) throw new ProxyFault("search_response_too_large");
      pending += decoder.decode(next.value, { stream: true });
      let split: RegExpMatchArray | null;
      while ((split = pending.match(/\r?\n\r?\n/))) {
        handle(pending.slice(0, split.index));
        pending = pending.slice(split.index! + split[0].length);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) handle(pending);
  } finally { await reader.cancel().catch(() => {}); }
  return { text, model };
}

/**
 * One Chat Completions request to the connection with the configured model (streamed when `tool.stream`).
 * Errors carry fixed codes only: upstream bodies are never surfaced.
 */
export async function runSearch(tool: SearchTool, gateway: Gateway, query: string, options: { language?: string; signal?: AbortSignal; fetchImpl?: typeof fetch; onProgress?: (text: string) => void } = {}): Promise<SearchAnswer> {
  const trimmed = query.trim();
  if (!trimmed) throw new ProxyFault("search_query_empty");
  if (trimmed.length > MAX_QUERY_CHARS) throw new ProxyFault("search_query_too_long");
  const signal = AbortSignal.any([AbortSignal.timeout(tool.timeoutMs), ...(options.signal ? [options.signal] : [])]);
  const key = await resolveSecret(gateway.credential, signal);
  if (!key) throw new ProxyFault("credential_missing");
  const content = tool.prompt === "raw" ? rawPrompt(trimmed, options.language) : searchPrompt(trimmed, options.language);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${gateway.endpoint.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: tool.model, stream: tool.stream, messages: [{ role: "user", content }] }),
    });
  } catch (error) { throw abortCode(options.signal, signal, error); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ProxyFault(`search_http_${response.status}`);
  }
  let text = "", model: string | undefined;
  try {
    if (tool.stream) ({ text, model } = await readStream(response, options.onProgress));
    else {
      let parsed: unknown;
      try { parsed = JSON.parse(await readBounded(response)); }
      catch (error) { throw error instanceof ProxyFault ? error : new ProxyFault("search_response_invalid"); }
      const message = (parsed as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
      text = typeof message === "string" ? message : "";
      const reported = (parsed as { model?: unknown }).model;
      if (typeof reported === "string") model = reported;
    }
  } catch (error) { throw error instanceof ProxyFault ? error : abortCode(options.signal, signal, error); }
  text = text.trim();
  if (!text) throw new ProxyFault("search_response_empty");
  return { text, sources: extractSources(text), model: model ?? tool.model };
}
