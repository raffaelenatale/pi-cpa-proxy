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
- Stream diagnostic boundary prevents arbitrary upstream error text entering Pi events/results; protected OpenAI/Anthropic fetch blocks redirects, bounds/validates SSE frames and prevents malformed-frame raw logs. Google custom fetch is unsupported, so additional Pi→CPA transport/log/redirect hardening there remains unverified but does not block its demonstrated native functionality. CPA still handles the upstream leg; no replacement Google transport is planned.
- TypeScript check and **152 tests**, including stream iteration without removing cancellation tests and zero-network rejection of excluded administration endpoints/flags.
- Native CLIProxyAPI v8.0.13 isolated probe with checksum-verified Darwin arm64 release: read projection, single PATCH, layout migration, client key/routing preservation, alias 1M context/listing and runtime rollback.
- Actual Pi CLI loading from a packed public tarball.
- Actual Pi Git install/update of public/private synthetic releases, tags/commit pins, default-branch recovery, unavailable remote, invalid root manifest and throwing extension factory recovery. Config/defaults preserved; install failure is non-atomic and runtime defect can still return CLI exit 0. See `update-recovery.md`.

Evidence: `.artifacts/pi-probe.json`, `.artifacts/update-probe.json`, `.artifacts/server-profile-probe.json`, `.artifacts/manager-probe.json` (local and gitignored; Manager probe is synthetic).

Host tested: macOS, Node 26.10.0, Pi 1.0.2. Git update remotes are local bare repositories with URL rewriting. No production requests, live credentials or global Pi configuration are used.

## Next work

1. Versioned feature research remains incomplete; legacy inventory skipped at the owner's request. Administrative support/exclusions are explicit in `admin-scope.md`; no quota/key/cooldown commands are exposed.
2. Secure connector for actual compatible API-key provider groups/priorities if required for release. Existing `compatibleGroups` rows are OAuth alias/context mapping, not routing-order administration. Fixed effort/payload changes and broader administration are excluded from the alpha. OAuth alias publication is implemented on already-initialized channels; no automatic key/provider-group reading, missing-channel initialization or takeover. Manager Plus prices are implemented against a recorded source contract and synthetic server only; isolated real-image certification is pending. Full-table PUT has no server CAS and requires exclusive-writer consent.
3. Catalogue provenance and diagnostics, remote enrichment, schema migrations and machine preset selection.
4. Live gateway certification, effective image/model behavior, session-handoff, thinking/signature variants, Google transport security, multiple simultaneous tool calls, retries/long streams and input-limit/overflow edge cases. Current image tests prove serialization only.
5. Process-killed/disk-full and interrupted install recovery, multiple-package partial failures, real private GitHub/npm authentication, already-running session reload and manual TUI verification. Ordinary tag/commit pins and injected Git/install/runtime failures now covered.
6. Approved private real-world configuration and release pipeline; public/private remote repositories and npm release after the corresponding checks.
7. Controlled migration of existing installations with backup and rollback.

CI for Linux (ubuntu-latest) and macOS (macos-latest) across Node 22 and Node 24 is passing (run `37357533737`). Server routing remains outside the client metadata implementation; no automatic server writes exist. The isolated CLI probe configures both Manager and server admin with unavailable credentials and verifies zero management requests during startup. Native alias certification is limited to the tested v8.0.13 platform/contract and is not production routing certification. See `server-profile-contract.md` for migration, concurrency and rollback limitations.
