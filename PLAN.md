# pi-cpa-proxy — essential adapter delivery

## Agreed scope

A simple local adapter: **Pi → native Pi transport → CPA → upstream providers**.

The owner narrowed delivery to essential adapter behavior. Keep useful implemented features that do not add automatic work; do not expand administration or turn optional research/certification into core completion gates. CPA owns routing, primary/fallback, account authentication, quotas, cooldowns and affinity. The client consumes exposed model IDs and supplies accurate Pi metadata; it does not duplicate server operations.

Public engine and optional private YAML distribution share one runtime. No community implementation, personal model list, server topology or credentials in the public repository. Credentials remain external references.

## Essential implementation — complete locally

- [x] Native provider registration and explicit client-facing protocol selection.
- [x] Authenticated `/v1/models` discovery, bounded requests, cancellation and safe failure codes.
- [x] Conservative context/output/capability/pricing metadata from explicit overrides or unambiguous Pi catalogue entries; unknown models omitted rather than guessed.
- [x] Four native transports: text streaming, tool-call/result round-trip, usage, malformed/truncated/error handling and cancellation against synthetic HTTP.
- [x] Local config, external env/protected-file/Keychain references, validated atomic saves and persistent public/private overrides.
- [x] Setup, status and refresh; optional setup discovery check never contacts administration or changes Pi defaults.
- [x] Raw offline catalogue cache and preservation of the last usable snapshot after refresh failure.
- [x] Real Pi CLI loads the public tarball, executes a built-in `read` tool, receives stream deltas/final text and resumes persisted tool/text history against a synthetic gateway.
- [x] Package update/pin/rollback basics and config/default preservation with isolated real Pi commands.
- [x] Local TypeScript check, 152 unit/contract tests and integration probes. Actual evidence: `docs/development-status.md`.

No additional core feature is currently identified as missing. Fix concrete failures found in final checks rather than growing the feature list.

## Essential final checks

- [ ] Confirm the current commit on Linux/macOS Node 22/24 CI. Earlier matrix run `37357533737` passed; subsequent runner-provisioning outages are infrastructure blocks, not inferred code failures. Run checks delegated to flash.
- [ ] One operator-approved Pi→CPA completion/tool/cancellation smoke test in an isolated Pi home, using the intended client-facing protocol and known model metadata. No production management writes or installation migration; synthetic fixtures do not prove deployed gateway compatibility. Real credentials/requests require explicit approval.
- [ ] Security/content, dependency/license and tarball allowlist check for the intended release. No need to certify excluded administration to release the adapter core.

Manual TUI/real Keychain checks are targeted when those installation/credential paths are selected; they are not a demand to test every optional route before local env/file use.

## Existing optional features — retained, not core blockers

- Conservative role/profile metadata and price ceilings; these do not configure CPA routing or exact backend billing.
- Private assembler with byte-identical runtime, validated YAML, provenance and accidental npm publication protection.
- Manager Plus price administration: separately configured, read-only default, approval/journal/verification/latest rollback. Synthetic source-contract tests only; real-image certification pending **for promoting this optional adapter**, not for completing the core.
- OAuth alias/context administration and `compatibleGroups` alias rows on existing OAuth channels. Native single-alias v8.0.13 probe; group labels do not implement API-key provider groups, priorities or failover order.

Optional administration remains unused unless separately configured and invoked. Startup/setup/refresh/update never contact its endpoints. Keep current safeguards and regression tests; do not add quota/key/cooldown commands. See `docs/admin-scope.md`.

## Explicitly deferred / outside this delivery

No legacy inventory (owner declined), mandatory feature-research expansion, actual API-key group routing connector, external catalogue fetching, richer provenance UI, machine presets, speculative schema migration, advanced stream-signature/interleaved-tool campaigns, disk-full/process-killed/multi-package recovery campaign or administrative real-image certification as core gates. Existing evidence and caveats remain documented; none is relabeled as tested.

## Publication and private installation — separate actions

Public development repository `raffaelenatale/pi-cpa-proxy` and alpha commits/pushes are authorized. Version `0.1.0-alpha.1` remains unpublished on npm. npm/private-distribution release authorization is conditional on the essential release checks and approved private mappings/name, not permission to publish while gates are open.

- [ ] Approve real private YAML mappings and package/repository name if private distribution is wanted; preserve provider/model IDs/defaults.
- [ ] Verify intended npm identity/name and private Git authentication before those releases.
- [ ] Publish immutable tags/packages only after essential release checks; document pinned rollback and `/reload`.
- [ ] Explicitly approved per-machine installation/migration with backup and duplicate-registration prevention. Never alter existing installations automatically.

## Evidence and boundaries

See `docs/development-status.md`, `docs/setup-verification.md`, `docs/transport-verification.md`, `docs/update-recovery.md`, `docs/admin-scope.md` and the optional admin contracts. Local `.artifacts/` evidence is excluded from Git/npm.

Tests do not prove actual million-token capacity, upstream vision, failover or dynamic billing. Google keeps its native SDK path; additional redirect/log/body hardening is unverified, not a reason to replace the SDK or CPA. Snapshot/local locks do not establish server CAS; admin rollback does not undo unrelated server operations or layout/comments. Package rollback does not reverse server administration.
