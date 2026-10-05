# CPA server alias adapter — verified scope

## Immutable sources

CLIProxyAPI v8.0.13, commit `d7914afdedca7af95ee974a42453dc49fc1388ce`:

- https://github.com/router-for-me/CLIProxyAPI/blob/d7914afdedca7af95ee974a42453dc49fc1388ce/docs/management-api-v8.md
- https://github.com/router-for-me/CLIProxyAPI/blob/d7914afdedca7af95ee974a42453dc49fc1388ce/internal/api/handlers/management/config_v8.go
- https://github.com/router-for-me/CLIProxyAPI/blob/d7914afdedca7af95ee974a42453dc49fc1388ce/internal/config/config_types.go
- https://github.com/router-for-me/CLIProxyAPI/blob/d7914afdedca7af95ee974a42453dc49fc1388ce/internal/config/config_v8.go

This is original client code and original fixtures; protocol fields, not upstream implementation, are used.

## Narrow contract

- GET `/v8/management/config/oauth/model-alias`: plain channel → alias-entry list map.
- GET `/v8/management/config/oauth/settings`: plain channel → context-setting list map.
- PATCH `/v8/management/config`: one JSON object containing only `oauth.model-alias` and `oauth.settings` maps for touched channels. Arrays replace, maps merge.
- GET `/v1/models`: client authentication and model ID discovery.

No full config/YAML GET, upstream-provider/key read, credential download or arbitrary request path is allowed. Remote alias/setting entries are strict and unsupported fields fail closed. Responses echoing either configured client/admin credential are rejected before persistence.

Read-only v8 projection does not migrate the file. Successful writes may canonicalize/migrate the entire persisted layout, preserving semantics but not promising byte/comment identity. Server-side parse/validation precedes saving; reload is asynchronous. No server CAS/If-Match contract was identified.

The adapter sends alias and context changes together rather than issuing two separate writes. This reduces partial-operation risk but does not make the disk save/reload a distributed transaction. Unexpected partial results remain uncertain and recovery refuses snapshots other than exact before/after.

## Supported behavior

- Generic OAuth channel alias with `fork: true` to retain the original model, and explicit alias-specific context metadata.
- Compatible-provider primary/fallback groups: mapped via scoped primary/fallback rows on existing channels with `fork: true` without client transmission or persistence of upstream credentials.
- Explicit server configuration block, separate from Pi `profiles` metadata and Manager prices.
- Only channels already present in both alias/settings maps. Missing map/channel initialization is an explicit operator task; the adapter refuses rather than creating keys it cannot exactly undo.
- Source must be present in the client catalogue and not another known OAuth alias. A catalogue alone does not prove provider/channel membership or completion capability. No fuzzy owner inference or alias-chain support.
- Unowned existing aliases, even identical, are refused; collisions in the overall model listing are also refused. No implicit takeover.
- Successfully applied aliases are owned through the private latest journal. Further changes require their rows to match the recorded state. Removing an owned alias from desired config is not an implicit delete; use explicit latest rollback.
- Existing unrelated alias rows, context settings and channels are preserved. Provider priorities, native cooldowns, affinity and payload rules are untouched.
- A local target lock, before/after snapshot journal, approval/config hash and config re-read immediately before UI writes.
- Snapshot is read twice to detect changes across the two secret-free resources. There is still a TOCTOU window. Operator exclusive-writer consent is mandatory; different machines are not coordinated.
- Apply verifies config and polls for owned aliases AND original source IDs in runtime discovery. This proves publication/listing, not effective 1M context, tools, effort, image support, completions or fallback.
- Latest rollback restores touched channel arrays, with exact full alias/context snapshot conflict checks. Writes to any alias/context channel after publication can block rollback. Changes to other config sections are outside the snapshot and are preserved by the narrow PATCH.
- Acknowledgment-lost apply/rollback is journaled and retry-safe when the observed state matches expected snapshots. No unconditional overwrite, automatic compensation or takeover from corrupted/missing journals.
- Rollback currently verifies configuration; the native probe separately waits for runtime alias removal. Rollback does not restore old layout/comments.

## Deliberate exclusions

Upstream API keys and raw provider credential sections (`api-keys.openai-compatibility[].api-key`) live exclusively on the server and are never downloaded, modified or persisted into client journals. The compatible group adapter operates strictly on channel model mappings and context boundaries, preserving server-side routing, affinities and cooldowns without handling upstream tokens.

Fixed server effort/payload rules (`requests.payload`) and dynamic server priorities remain managed directly by the server configuration, outside client runtime metadata.

A future connector for remote file manipulation or SSH orchestration is intentionally excluded from the client engine: no SSH command is accepted from YAML and no arbitrary command runner is exposed.

## Native verification

`npm run test:server-profiles` downloads the public Darwin arm64 v8.0.13 release into a temporary directory and checks SHA256:
`652a192e3e38520253e330c4a094fa8916728370c3f213f127dbc56e35be7938`.

It starts a loopback-only process with a synthetic OAuth credential, synthetic client/admin keys and isolated HOME/auth/config paths. It does not send completion requests or use real accounts. Read-only projection, single PATCH, canonical migration, client key/routing preservation, 1M alias metadata, native alias listing and runtime rollback are exercised. Evidence: `.artifacts/server-profile-probe.json` (local/gitignored).

The probe can accept an explicitly supplied binary on other platforms; such a run is labeled operator-supplied, not checksum-certified. A downloaded executable is upstream software, not our runtime code. No macOS container runtime was started: the local `docker` command resolves to Apple container tooling and does not expose Docker `info`.

This test certifies the narrow API on this specific native release/platform, not Manager forwarding compatibility, production safety, provider routing success or all CPA versions. Strict 404 on absent resources is an unsupported/readiness state, not a reason to auto-initialize server config.
