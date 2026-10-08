# Development status — alpha foundation

Version: `0.1.0-alpha.1`. Public development source is available at https://github.com/raffaelenatale/pi-cpa-proxy (initial commit `89aeb15`); npm publication and a complete private distribution follow implementation and release gates in [PLAN.md](../PLAN.md). No npm or private distribution release exists yet.

## Implemented and tested locally

- Strict YAML configuration, deterministic public/private overlay, restricted atomic writes and external credential references.
- Native provider discovery, raw cache, exact/explicit built-in catalogue enrichment, explicit API routing and conservative role metadata.
- Price tiers/ceilings, compatibility flag merge and system-role safeguard, inherited/fixed effort and image preprocessing bounds.
- Setup wizard with explicit protocol selection, advanced editor, optional read-only GET `/v1/models` check with redacted counts/guidance before final save, status and targeted refresh. No admin/cache/completion activity during the check; see `setup-verification.md`.
- Private artifact assembly from byte-identical runtime sources.
- Optional Manager Plus price administration: read-only contract check, preview, hash-bound interactive approval, full-table apply with journal, uncertainty handling and latest-transaction rollback tested against a synthetic loopback server via `scripts/probe-manager.ts`. This does not certify a real Manager image/version.
- Optional CPA v8 OAuth alias and compatible-provider group publication: strict secret-free scoped reads, one PATCH, journal ownership, collision checks, snapshot verification and latest rollback. `compatibleGroups` publishes alias/context rows on existing OAuth channels without downloading upstream credentials; primary/fallback labels do not configure priorities or certify compatible API-key provider-group failover.
- All four native transport adapters tested end-to-end against synthetic HTTP: tool call/result, image input serialization, usage, paths/auth, malformed/truncated SSE, errors, cancellation and overflow classification.
- Stream diagnostic boundary prevents arbitrary upstream error text entering Pi events/results; protected OpenAI/Anthropic fetch blocks redirects, bounds/validates SSE frames and prevents malformed-frame raw logs. Failed calls are mapped to fixed labels that keep transient failures (HTTP 429/529/503/500/502/504, `overloaded_error`, `rate_limit_error`, `api_error`) retryable by Pi's `isRetryableAssistantError` without provider text in history; quota/billing exhaustion and 4xx stay neutral. Google custom fetch is unsupported, so additional Pi→CPA transport/log/redirect hardening there remains unverified but does not block its demonstrated native functionality; Google error bodies are classified from their numeric code/status strings. CPA still handles the upstream leg; no replacement Google transport is planned.
- TypeScript check and **203 tests**, including stream iteration without removing cancellation tests and zero-network rejection of excluded administration endpoints/flags.
- Native CLIProxyAPI v8.0.13 isolated probe with checksum-verified Darwin arm64 release: read projection, single PATCH, layout migration, client key/routing preservation, alias 1M context/listing and runtime rollback.
- Actual Pi CLI loading from a packed public tarball, streaming text, executing the built-in `read` tool and resuming a persisted conversation with prior tool/text history against a synthetic gateway. Unavailable configured admin credentials are never resolved/contacted.
- Actual Pi Git install/update of public/private synthetic releases, tags/commit pins, default-branch recovery, unavailable remote, invalid root manifest and throwing extension factory recovery. Config/defaults preserved; install failure is non-atomic and runtime defect can still return CLI exit 0. See `update-recovery.md`.

Evidence: `.artifacts/pi-probe.json`, `.artifacts/update-probe.json`, `.artifacts/server-profile-probe.json`, `.artifacts/manager-probe.json` (local and gitignored; Manager probe is synthetic).

Host tested: macOS, Node 26.10.0, Pi 1.0.2. Git update remotes are local bare repositories with URL rewriting. No production requests, live credentials or global Pi configuration are used.

## Essential completion, not feature expansion

The owner narrowed scope to a simple local Pi→CPA adapter. Core implementation and isolated tests are complete locally. Keep existing opt-in extras, but do not expand them or make their certification a core blocker.

Remaining: current-commit CI confirmation (flash monitors; hosted runner provisioning outages are infrastructure), one explicitly approved isolated Pi→deployed-CPA smoke test, and release content/dependency/license checks. No production request, migration or publication is implied by the development checks.

Manager real-image certification, real compatible API-key group routing, remote enrichment, machine presets, schema migration and advanced recovery/signature campaigns are deferred outside essential delivery. Their missing evidence remains explicit. Manual TUI and real Keychain checks are targeted only when those paths are selected. Private mapping/name/authentication approval and machine migration remain separate distribution steps; see `PLAN.md`.

Earlier CI for Linux (ubuntu-latest) and macOS (macos-latest) across Node 22 and Node 24 passed (run `37357533737`); current-commit CI must be confirmed separately and is not inferred from that earlier run. Server routing remains outside the client metadata implementation; no automatic server writes exist. The isolated CLI probe configures both Manager and server admin with unavailable credentials and verifies zero management requests during startup. Native alias certification is limited to the tested v8.0.13 platform/contract and is not production routing certification. See `server-profile-contract.md` for migration, concurrency and rollback limitations.
