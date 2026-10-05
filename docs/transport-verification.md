# Native transport coverage and security boundary

Tested locally with Pi 1.0.2's host packages on macOS / Node 26. No SDK source or community fixture is copied. The extension continues to use native Pi wire implementations; original tests send minimal protocol-shaped events from a synthetic HTTP server.

| Behavior | Chat Completions | Responses | Anthropic | Google |
|---|---|---|---|---|
| Alias-specific URL/auth | yes | yes | yes | yes |
| Tool call → tool result → text | yes | yes | yes | yes |
| Input/output/cache usage | yes | yes | yes | yes |
| Image data serialization | yes | yes | yes | yes |
| HTTP errors / malformed / truncated stream fail | yes | yes | yes | yes |
| Pending stream aborted | yes | yes | yes | yes |
| Safe error result + overflow classification | yes | yes | yes | yes |
| Protected fetch/body boundary | yes | yes | yes | no |
| Cross-origin redirect refused | yes | yes | yes | pending |

Images are synthetic 1px PNG data, not evidence of vision understanding. Tool fixtures prove native serialization and replay for one function. The separate packed-package `scripts/probe-pi.ts` runs real Pi CLI against synthetic Chat Completions, executes its built-in `read` tool on a temporary fixture, verifies the returned result and text deltas, then resumes persisted tool/text history. This establishes basic Pi agent integration, not concurrent tools or deployed-CPA behavior.

## Two distinct network legs — Google is not broken

The normal topology is **Pi/native SDK → CPA gateway → upstream provider**. CPA owns upstream Google authentication, translation, quotas, priorities, cooldowns and affinity. The SDK in Pi only speaks the configured client-facing protocol to CPA; it does not independently connect to Google when the gateway origin is configured.

Custom fetch is not required for Google features or CPA routing. Our scoped custom fetch on supported SDKs is additional **Pi→CPA** error/frame/redirect hygiene after tests showed raw errors/frame logs. Google's SDK lacks that injection point; its native path already passes synthetic stream/tool/image-payload/cancellation tests. The remaining transport-hardening caveat is not a functional failure, prerequisite for all users, or reason to build a parallel Google router. A CPA-hosted Google backend can also be presented through CPA's Chat Completions protocol when that is the selected server/client contract.

## Confirmed defects and fixes

A mock HTTP 400 echoed the synthetic request key in its message. All three newly tested native adapters originally passed it to the final assistant error. The extension's `guardedStreams` boundary now removes arbitrary failure text/diagnostics from public stream events and results, mapping to safe codes. The host's `isContextOverflow` classifier is used before redaction so Pi compaction detection remains usable. Rate-limit wording is not mislabeled as overflow.

Malformed OpenAI SSE caused the SDK to log the raw invalid frame before creating a final error. The protected fetch validates each full SSE data frame as JSON (or `[DONE]`) before handing it to those parsers. No global console/fetch monkey patch is used. Fragmented UTF-8, CRLF and multiline data are covered. An incomplete trailing frame is rejected, as is a frame/buffer over 2MB. HTTP error bodies are bounded to 64k for private overflow classification and replaced with safe codes, preserving status/retry headers.

OpenAI/Anthropic requests use this custom fetch and `redirect: error`. A second mock origin receives zero requests on tested 307 redirection. Google native API explicitly refuses custom fetch and retains its own network path; final failure events are normalized, but transport logs, redirects and body/frame bounds are not claimed hardened.

## Scope and remaining risks

- Safe failure diagnostics do not sanitize successful generated text, tool arguments or reasoning. Never ask a model to process credentials.
- Caller-supplied payload/response/provider-event hooks and host debug behavior remain separate data handling boundaries.
- Google Pi→CPA raw internal error/log/redirect behavior remains unverified for additional hardening. It is not a blocker for the demonstrated functionality; keep the native SDK, do not replace it or duplicate CPA upstream work. Do not claim universal no-secret logging.
- Normal completion transport does not currently add its own server timeout policy: native caller timeout/signal handling applies. Discovery/admin timeouts are independent.
- Retries, 429 cooldown, session affinity and actual served-backend billing remain server/native concerns; mock success does not prove CPA failover.
- Multiple/interleaved function calls, reasoning signatures, long streams, constrained sampling, unsupported finish types, session replay across models and actual image preprocessing lack expanded coverage. These are deferred robustness work, not newly required adapter features; fix specific defects if observed.
- Input limits and context metadata cannot establish a real million-token capacity.

Evidence is the original `tests/transports.test.ts` and `tests/stream-boundary.test.ts`, plus the full `npm test` run. Current total is **152 tests**; `npm run check`, packed Pi CLI probe and public/private Git update probe also pass after these changes.
