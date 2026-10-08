/**
 * Fixed, whitelisted labels for failed provider calls. Provider text never reaches Pi history:
 * the raw message is only classified here and kept in stream.log.
 *
 * Pi decides retry from the label text via isRetryableAssistantError (@earendil-works/pi-ai).
 * Tests assert each label against that real function; do not copy its patterns here.
 */
export const STREAM_FAILED = 'cpa_stream_failed';
export const STREAM_FAILED_LABELS = {
  overloaded: 'cpa_stream_failed: overloaded',
  rateLimit: 'cpa_stream_failed: rate limit',
  serverError: 'cpa_stream_failed: server error',
} as const;

/** Fixed error types written into the sanitized HTTP body (transport-fetch). */
export const SANITIZED_HTTP_TYPES = {
  overloaded: 'overloaded_error',
  rateLimit: 'rate_limit_error',
  serverError: 'api_error',
  other: 'cpa_http_failed',
} as const;

/**
 * Quota, billing and subscription exhaustion are not transient even when they arrive as 429.
 * Checked on the original provider text, before the body is replaced.
 */
const LIMIT_EXHAUSTION = /insufficient_quota|quota|billing|usage.?limit|available.?balance|out of budget|subscription_sharing/i;

export function isLimitExhaustion(text: string | undefined): boolean {
  return LIMIT_EXHAUSTION.test(text ?? '');
}

/** Type for the sanitized HTTP body, derived only from the status code. */
export function sanitizedHttpType(status: number, originalText: string | undefined): string {
  if (isLimitExhaustion(originalText)) return SANITIZED_HTTP_TYPES.other;
  if (status === 429) return SANITIZED_HTTP_TYPES.rateLimit;
  if (status === 529 || status === 503) return SANITIZED_HTTP_TYPES.overloaded;
  if (status === 500 || status === 502 || status === 504) return SANITIZED_HTTP_TYPES.serverError;
  return SANITIZED_HTTP_TYPES.other;
}

/**
 * Maps a raw provider failure (SDK message, SSE error JSON, sanitized HTTP body) to a fixed label.
 * Anything not clearly transient maps to the neutral, non-retryable STREAM_FAILED.
 */
export function classifyFailure(raw: string | undefined): string {
  const text = raw ?? '';
  if (isLimitExhaustion(text)) return STREAM_FAILED;
  // Status: SDK prefix ("529 {...}"), sanitized body ("http_529"), or Google's JSON body ("code": 429), since its SDK exposes no fetch hook.
  const status = Number(/\bhttp_(\d{3})\b/.exec(text)?.[1] ?? /^(\d{3})\s/.exec(text)?.[1] ?? /"code":\s*(\d{3})\b/.exec(text)?.[1] ?? NaN);
  if (/\boverloaded_error\b/.test(text) || status === 529 || status === 503 || /overloaded/i.test(text)) return STREAM_FAILED_LABELS.overloaded;
  if (/\brate_limit_error\b/.test(text) || status === 429 || /"RESOURCE_EXHAUSTED"/.test(text)) return STREAM_FAILED_LABELS.rateLimit;
  if (/\bapi_error\b/.test(text) || status === 500 || status === 502 || status === 504 || /"INTERNAL"/.test(text)) return STREAM_FAILED_LABELS.serverError;
  return STREAM_FAILED;
}

const KNOWN_LABELS = new Set<string>([STREAM_FAILED, ...Object.values(STREAM_FAILED_LABELS), 'cpa_request_aborted', 'cpa_context_length_exceeded', 'cpa_http_failed']);

/** True when a message was already normalized by us, so a second pass must not overwrite the label. */
export function isNormalizedError(message: string | undefined): boolean {
  return message !== undefined && KNOWN_LABELS.has(message);
}
