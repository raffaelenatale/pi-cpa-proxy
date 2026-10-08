# pi-cpa-proxy

An original, configuration-driven CLIProxyAPI provider extension for Pi.

**v0.1.0 — sequential releases, npm publication pending.** Implementation and release gates are tracked in [PLAN.md](PLAN.md); public development source is separate from a completed release. Current verified host: Pi 1.0.2 on macOS / Node 26. Linux and additional Pi versions require their own test runs before support is declared. This is not an upstream CLIProxyAPI project or a fork of another extension.

## Essential scope

This is a local **Pi → CPA adapter**, not a CPA administration suite. Configure an origin and external client credential, discover exposed models, supply accurate Pi metadata and use native streaming. CPA remains responsible for upstream accounts, priorities/fallback, quotas and cooldowns. Setup/status/cache are conveniences; implemented administration is optional and never runs during startup, setup, refresh or updates. Optional admin certification and speculative feature expansion do not block completion of the adapter core.

## Implemented

- Native Pi provider registration, with built-in streaming implementations for Chat Completions, Responses, Anthropic Messages and Google Generative AI. All four have synthetic HTTP end-to-end coverage for stream/tool-result round-trip, image payload serialization, errors, truncation and cancellation; this is not live-backend certification.
- `/v1/models` discovery with authentication, abort/timeout, response-size bounds and redirect refusal.
- Optional enrichment from Pi's bundled catalogue. Ambiguous or incomplete metadata is omitted, not guessed at 128k or priced at zero. Configure overrides explicitly when necessary.
- Role profile metadata: shared input capabilities, minimum safe limits, component-wise price ceilings including tiers, inherited/fixed effort and protocol compatibility.
- Last-known raw catalogue cache outside the installed package, scoped to configuration identity, re-derived through the current metadata resolver. Failed refresh preserves the previous in-memory snapshot.
- Strict, versioned YAML configuration; environment/file/Keychain **credential references**, never literal keys in config.
- Public local configuration and private bundled configuration + persistent local overrides.
- `/cpa-setup` connection wizard with explicit native protocol selection, advanced validated YAML editor and optional read-only client discovery check before saving. Setup writes only local configuration, never CPA or Pi defaults, and requires UI.
- `/profile-map` prints a table of the configured role profiles (default model, fallback, context window, selectable effort levels, when to use). It reads only the local configuration: the first member is the default, `fallback` (or the second member) the fallback, `description` the "when to use" text; no server request is made.
- `/cpa-status`, `/cpa-refresh-models` and optional `/cpa-admin` for Manager Plus price status, preview, approved apply and latest-transaction rollback.
- `/cpa-server-profiles` for separately configured OAuth alias/context publication, ownership checks and latest rollback; single-alias behavior verified against an isolated native CLIProxyAPI v8.0.13 release. `compatibleGroups` adds alias/context rows on existing OAuth channels, not provider priorities or failover-order configuration.
- Private distribution assembler, without a second copy of the source implementation.

## Not implemented yet

Actual compatible API-key provider-group routing administration, models.dev fetching, richer diagnostics, schema migrations and machine-preset selection are outside the current essential delivery. Live installation migration is a separate explicitly approved operation. Server fixed-effort/payload changes, key/credential operations, cooldown reset and quota widgets are deliberately excluded from current scope; see [administrative scope and reasons](docs/admin-scope.md). Some upstream read endpoints return credentials, and cooldown reset lacks the required rollback contract. Manager Plus prices have a recorded-source contract and synthetic loopback probe (`npm run test:manager`), not real-image certification. Setup tests against UI mocks do not replace a manual TUI usability check. No production server changes have been performed during development.

## Installation (development)

Use a local package first:

```sh
pi -e /absolute/path/to/pi-cpa-proxy --list-models
# Persistent install only when you choose to migrate:
pi install /absolute/path/to/pi-cpa-proxy
```

The future public npm/Git source will be documented after publication. Do not install alongside a legacy extension registering the same provider ID or commands.

This package uses the current `@earendil-works` native provider API. It does not claim compatibility with older `@mariozechner` hosts.

## Configuration

Default user file: `~/.pi/agent/pi-cpa-proxy/config.yaml` (under `PI_CODING_AGENT_DIR` when overridden).
Set `CPA_PROXY_CONFIG` to an absolute path or `~/...` to select a different file. No project configuration is loaded automatically.

Run `/cpa-setup` or copy and edit `config.example.yaml`. The example uses synthetic model IDs; it is a schema demonstration, not a working model list.

The wizard asks which native completion protocol to use; discovery cannot infer it. Both setup modes offer an optional connection check before final save: only the external client credential and GET `/v1/models` are used, never admin endpoints, completions or cache writes. Counts show listed/usable/omitted models and missing profiles. Unknown models need explicit metadata overrides; listing alone does not certify completions. You can skip the check or deliberately save an offline/unverified config. See [setup checks and evidence limits](docs/setup-verification.md).

Network responsibilities are separate: **Pi → CPA** uses the selected native protocol; **CPA → upstream** owns Google/OpenAI/etc. authentication, translation, quotas and routing. Native Google operation is tested and does not require custom fetch. The custom fetch used for supported SDKs is extra client error/redirect hygiene, not a Google replacement or upstream router.

Each connection key is its Pi provider ID. `endpoint` is the CPA **origin** without `/v1`. Remote HTTPS is recommended. HTTP requires explicit `allowInsecureHttp: true`, even for localhost.

Supported credential references:

```yaml
credential: {kind: env, name: CPA_PROXY_API_KEY}
# OR
credential: {kind: file, path: ~/.config/pi-cpa/api-key}
# OR macOS only
credential: {kind: keychain, service: your-service, account: your-account}
```

Files must be owned by the current user, not symlinks, and inaccessible to group/others (use `chmod 600`). Keychain execution uses an argument array, not a shell. Credential lookup happens again for requests, so a new session is not required for key rotation.

The wizard asks for **references**, not API key values. Populate the selected secure store separately. No secret value is included in diagnostics or upstream error bodies displayed by this extension.

### Model metadata

`models` is a mapping from model ID to overrides. Define `contextWindow`, `maxTokens`, `input`, `reasoning` and all four `cost` rates for unknown models. Optional `source: {provider: ..., id: ...}` selects an exact Pi catalogue entry. `api` defaults to the connection's API; no inference from `owned_by` occurs.

Other fields: `name`, `enabled`, `thinkingLevelMap`, `inputLimits` (request size, image counts and resize options), and selected Chat Completions `compat` flags and the Anthropic `supportsMidConvoEffort`/`forceAdaptiveThinking` flags (set `supportsMidConvoEffort: false` on a managed-effort Claude model to let Pi send `thinking: disabled` for the `off` level). Compatibility beyond this initial schema is pending.

Prices are estimates in USD per million tokens. `tiers` uses Pi's `inputTokensAbove` convention, with strictly increasing thresholds. Missing rates are not inferred as free.

### Profiles

`profiles` maps a server alias to `members`, `effort` (`inherit` or a fixed level), and optional `metadata` overrides.

An alias must already be present in CPA discovery to appear in Pi. Members are metadata references, **not an executable client-side failover chain**. They do not need to appear separately in discovery if their metadata is explicitly configured or found in the catalogue.

The server remains responsible for priority, quota failover and session affinity. Profile context/output may be capped below member limits but cannot exceed them. Image support cannot be claimed if a member does not support it. Component-wise maximum prices are estimates, not exact served-backend billing. Profile image/request limits use the tightest explicitly known member or override bound; this does not establish unknown backend limits.

### Merge rules

Private bundled config → local user override. Maps merge recursively; arrays replace; `null` removes a map key except inside `thinkingLevelMap`, where it means unsupported. Unknown schema fields, duplicate YAML keys, custom tags, aliases and prototype keys are rejected. Overrides are validated after merging.

Config writes use a lock, expected-content check, restricted permissions, backup and atomic rename. Backups can contain private metadata; retain them privately. Symlink targets are rejected. Directory symlink hardening and stale lock recovery remain future work.

## Optional Manager Plus price administration

No admin credential is needed for normal model use. Admin is disabled unless an `admin` block is configured on a connection; the extension never contacts it at startup, refresh or package update.

```yaml
admin:
  kind: manager-plus
  endpoint: https://manager.example.invalid
  credential: {kind: env, name: CPA_MANAGER_ADMIN_KEY}
  allowPriceWrites: false
  exclusivePriceWriter: false
  prices:
    example-role:
      input: 2
      output: 8
      cacheRead: 0.2
      cacheWrite: 0
      tiers:
        - {inputTokensAbove: 200000, input: 4, output: 12, cacheRead: 0.4, cacheWrite: 0}
```

Use the advanced `/cpa-setup` YAML editor for this block. Admin price configuration is intentionally separate from client metadata; no implicit publication occurs when editing a model cost. These rates affect Manager's local usage estimates, not upstream billing or CPA primary/fallback routing.

`/cpa-admin` selects the connection and offers read-only status, preview/apply and rollback. Preview shows changed managed IDs and rates, including advanced-rule counts. Applying requires **both** `allowPriceWrites: true` and `exclusivePriceWriter: true`, plus explicit interactive approval of the exact preview. Headless mutations are not supported in current scope.

### Full-table replacement limitation

The recorded Manager API uses `GET/PUT /v0/management/model-prices` and replaces the entire table. It has no server compare-and-swap contract. **Stop all other price writers (including dashboard edits and sync jobs) during apply/rollback.** The exclusive-writer setting is an operator assertion, not an enforced server lock.

The extension preserves unrelated rows, checks the before-snapshot again immediately before PUT, and verifies the complete result with GET. This detects known conflicts, but cannot prevent a writer racing between that GET and PUT. No unconditional retry or automatic compensation is performed.

Managed row changes replace their service-tier/raw-source rules with the configured base/context prices. The preview warns about this. Unrecognized remote fields fail closed rather than disappearing on replacement. Context thresholds map to Manager's strictly-greater-than semantics. Zero cache rates remain explicitly configured even when omitted in JSON by the Go response encoder.

### Journal and recovery

Before PUT, the extension writes a private journal under the local config directory's `admin-state/`, with a before/after snapshot, target/config stamp and transaction ID. A local per-target operation lock prevents simultaneous operations in the same state directory. Locks do not coordinate different machines; stale lock cleanup must be performed only after confirming no operation is running.

If a response is lost or read-back fails, the journal reports **uncertain**, not success. New writes are blocked until the latest transaction is recovered. Rollback checks the current full table against the before/after snapshot; a conflicting third state is refused. If rollback was applied but its acknowledgment was lost, retry checks the before-snapshot and finishes without another PUT. No automatic overwrite of unrelated later changes is attempted.

A new successful transaction archives the preceding journal; the UI currently rolls back only the latest transaction. Archives and atomic-write backups are private metadata and must not be published. Journals have no configured credentials; a response echoing the configured admin credential is rejected before persistence. They do include server pricing metadata, so raw server metadata must be treated as private. Automated pruning/export and more advanced recovery are pending.

Source contract and caveats: `docs/management-contract.md` in the repository. This implementation does not use SSH, direct SQLite writes or arbitrary request paths from YAML.

## Optional CPA server OAuth alias publication

Client `profiles` metadata never silently configures routing. To explicitly publish a **single OAuth backend alias**, configure `serverAdmin` on the connection using a dedicated CPA management credential:

```yaml
serverAdmin:
  kind: cli-proxy-api-v8
  endpoint: https://gateway.example.invalid
  credential: {kind: env, name: CPA_SERVER_MANAGEMENT_KEY}
  allowProfileWrites: false
  exclusiveConfigWriter: false
  acceptLayoutMigration: false
  aliases:
    example-role:
      channel: codex
      model: example-native-model
      contextWindow: 1000000
```

Use `/cpa-server-profiles` for status, preview/publication or latest rollback. For writes all three consent flags must be `true`, with interactive confirmation. The existing connection's client credential is used separately to check runtime model listing. Server admin is never contacted at startup, discovery, refresh or update.

The adapter reads **only** the OAuth alias and setting maps; it does not read complete config, upstream keys or auth files. Unknown fields fail closed. It publishes alias/context arrays in one scoped root PATCH; other config sections, priorities, cooldowns, affinity and payloads remain untouched. `fork: true` retains original IDs. Source IDs must already be listed; this alone does not prove correct channel membership or that completions will work.

**Current scope:** channels must already exist in both server alias/settings maps. Missing maps/channels return unsupported rather than being auto-created. Existing unowned aliases and catalogue collisions are refused, even if identical. Ownership is stored in a private journal under `profile-state/`; losing it does not grant permission to take over server rows. Desired removal of owned aliases is refused; latest rollback is the explicit removal/restoration path.

**Stop all other config writers.** Server CAS is unavailable, and double-read snapshot checks/local locks cannot eliminate concurrent server races. A successful v8 write can migrate legacy configuration to the canonical v8 layout. You must accept that effect; rollback restores touched alias/context arrays, **not** the former layout/comments. Conflicting later alias/context edits block rollback. Changes to other sections are retained by the narrow PATCH.

Apply verifies saved alias/context state and waits for aliases plus original source IDs in discovery. On failed acknowledgment/verification the journal becomes uncertain and blocks subsequent writes until recovered. Unexpected partial server state is refused instead of blindly overwritten. Latest rollback verifies configuration; runtime reload is asynchronous. Discovery success is not evidence of effective 1M processing, tools, images, effort or fallback.

**Compatible-provider primary/fallback (for example GLM → OAuth backend) is not supported here.** Those provider groups contain upstream secrets and need a deliberate secure server-side connector. No priorities or failover are simulated by this OAuth adapter.

Details and immutable sources: `docs/server-profile-contract.md` in the repository.

## Updates and private distributions

Public config is outside the installed package; package updates do not modify it.

```sh
pi update --extensions
# In sessions already open:
/reload
```

`pi update` without `--extensions` updates Pi itself in the current CLI.

To assemble a complete private package from this engine:

```sh
npm run bundle:private -- /private/config.yaml /private/new-output pi-cpa-proxy-personal
```

The output includes the same runtime, the validated bundled `config.yaml`, a provenance manifest and `private: true` to prevent accidental npm publication. Do not publish this directory publicly. Secrets remain external even in a private repository.

Install the private package **instead of** the public package. Private setup writes only overrides outside the package. Updating the private package replaces its bundled config and runtime; local overrides survive. Overrides deliberately win and can therefore hide newly distributed values.

A Git source without a ref follows the repository's default branch. On tested Pi 1.0.2, a tag pin stays on that tag and an exact commit pin stays on that commit; `pi install` with a different ref reconciles the same package identity. Tags must be kept immutable by repository policy; commit pins are reproducible rollback points. Tests now cover unavailable remotes, invalid-manifest install failure and throwing runtime releases, plus explicit known-good commit recovery for public/private distributions. Updates are not atomic: Pi can advance the checkout before dependency installation fails. Even a runtime-broken release can produce update/listing exit 0, so check the expected model presence and health, not exit status alone. See `docs/update-recovery.md` in the repository. No background updater or install lifecycle script modifies home/config/server state.

## Development and verification

```sh
npm install --ignore-scripts --legacy-peer-deps
# Host-provided peer packages must be available to the development toolchain.
npm run check
npm test
npm run test:pi
npm run test:update
# Optional native release download/execution, synthetic isolated server:
npm run test:server-profiles
npm pack --dry-run
```

Pi supplies host peers when loading managed packages. For local development, make installed host packages available via local links or dev tooling; never bundle them in the published package.

The current suite has **152 passing tests** locally, including administrative conflict detection, lost acknowledgments, journal failures, rollback recovery and cancellation. The packed Pi probe also executes the real `read` tool, verifies streamed final text and resumes persisted tool/text history against a synthetic gateway. These tests do not establish deployed-CPA compatibility or compatibility with an arbitrary Manager version; optional Manager certification is not a core adapter release gate.

Pi/update probes use isolated homes, synthetic credentials and a mock gateway; they never call a production model or alter global Pi settings. The optional server-profile probe downloads a checksum-verified native CLIProxyAPI v8.0.13 Darwin arm64 binary and exercises its HTTP API locally with synthetic OAuth auth, no completions. Other platforms may supply a binary explicitly; this is labeled separately, not automatically certified. They retain concise JSON evidence under `.artifacts/` (gitignored). The update probe exercises Git package updates through local repositories; it does **not** authenticate to a real private GitHub repository.

## Security and limitations

Configuration is trusted local data, not a sandbox. No arbitrary shell commands or remote YAML includes are accepted. Discovery refuses redirects. OpenAI Completions/Responses and Anthropic streaming use a scoped protected fetch that refuses redirects, bounds individual SSE frames and rejects malformed/truncated frames before SDK parsing. Cross-origin refusal is tested. Google native streaming currently rejects custom fetch, so its transport-level redirect/body/log hardening is still unverified; no universal transport safety claim is made. Failed native stream diagnostics exposed to Pi are normalized to `cpa_stream_failed`, `cpa_request_aborted` or `cpa_context_length_exceeded`, preserving overflow detection without storing arbitrary server error bodies. Diagnostic stream events and HTTP errors are recorded in local logs (`~/.pi/agent/pi-cpa-proxy/logs/stream.log`) for detailed offline debugging. OpenAI/Anthropic HTTP error bodies are read only within a bounded classifier then replaced with safe codes before SDK parsing. Successful content/tool arguments are not sanitized; caller-supplied hooks, host debug policies and SDK-internal Google behavior require their own security review. No third-party catalogue requests or telemetry are performed by this extension; host Pi telemetry policy is controlled separately.

The extension retains no transcript or credential in its catalogue cache. Cache contains model IDs and can still be private metadata. Cache/journal pruning and richer provenance UI are pending. Price-table and narrow OAuth alias rollback are available; compatible-provider routing rollback is not yet implemented.

## License

MIT. Features may be inspired by public behavior in the CLIProxyAPI ecosystem; implementation and tests are independently authored. See `docs/feature-research.md` in the source repository for the bounded discovery notes.
