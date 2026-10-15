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

/**
 * One non-streaming Chat Completions request to the connection, with the configured model.
 * Errors carry fixed codes only: upstream bodies are never surfaced.
 */
export async function runSearch(tool: SearchTool, gateway: Gateway, query: string, options: { language?: string; signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<SearchAnswer> {
  const trimmed = query.trim();
  if (!trimmed) throw new ProxyFault("search_query_empty");
  if (trimmed.length > MAX_QUERY_CHARS) throw new ProxyFault("search_query_too_long");
  const signal = AbortSignal.any([AbortSignal.timeout(tool.timeoutMs), ...(options.signal ? [options.signal] : [])]);
  const key = await resolveSecret(gateway.credential, signal);
  if (!key) throw new ProxyFault("credential_missing");
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${gateway.endpoint.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: tool.model,
        stream: false,
        messages: [{ role: "user", content: searchPrompt(trimmed, options.language) }],
      }),
    });
  } catch (error) {
    if (options.signal?.aborted) throw new ProxyFault("search_aborted");
    if (signal.aborted) throw new ProxyFault("search_timeout");
    throw error instanceof ProxyFault ? error : new ProxyFault("search_network_failed");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ProxyFault(`search_http_${response.status}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await readBounded(response)); }
  catch (error) { throw error instanceof ProxyFault ? error : new ProxyFault("search_response_invalid"); }
  const choice = (parsed as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0];
  const content = choice?.message?.content;
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) throw new ProxyFault("search_response_empty");
  const model = typeof (parsed as { model?: unknown }).model === "string" ? (parsed as { model: string }).model : tool.model;
  return { text, sources: extractSources(text), model };
}
