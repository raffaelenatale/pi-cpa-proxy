# pi-cpa-proxy delivery plan

## Release intent

One original, generic public engine and one complete private distribution assembled from that engine plus approved YAML. No copied community implementation, personal model list, server topology or credentials in the public repository. Private configuration uses external credential references too.

The owner authorized publishing the public development repository and committing/pushing the current alpha. **npm publication and the complete private repository release are authorized after implementation and release gates are completed**, not as part of the initial development push. Version `0.1.0-alpha.1` remains unreleased on npm.

The private artifact is installed instead of the public/legacy engine, not alongside it. Public settings live outside the package; private bundled YAML updates with the package and persistent overrides stay outside it. Use Pi's `pi update --extensions`; no background updater.

## Milestones completed locally

- [x] Original TypeScript/native Pi provider foundation, package manifest, MIT and strict YAML v1.
- [x] Env/protected-file/Keychain references, deterministic config layers, atomic writes, backups and conflict checks.
- [x] Authenticated discovery, raw private cache/offline mode, exact/explicit metadata enrichment, unknown model exclusion.
- [x] Conservative role capabilities/context/output/pricing tiers and effort maps; server remains routing owner.
- [x] Connection setup/advanced YAML editor, status and refresh; no implicit server writes.
- [x] Private assembler with identical runtime, validated bundled YAML, provenance and accidental npm-publication protection.
- [x] Opt-in Manager Plus price adapter: separate admin credential, read-only default, preview/approved apply, journal/uncertainty and latest rollback. Synthetic source-contract tests only.
- [x] Narrow OAuth alias/context server adapter: ownership, collisions, single scoped PATCH, explicit layout consent, verification and rollback. Native CLIProxyAPI v8.0.13 tested in isolated loopback process.
- [x] Four native transports tested with synthetic HTTP stream/tool-result, image payload, usage, errors, truncation, abort and overflow handling.
- [x] Safe stream diagnostic boundary; supported OpenAI/Anthropic fetch hardening with redirect refusal and bounded SSE validation. Google keeps its native path; this is extra client hygiene, not an upstream router or functional requirement.
- [x] Actual Pi packed-package loading and public/private Git updates with external config/default preservation.
- [x] Tag/commit pins, unavailable remote, invalid-manifest installation failure and runtime-defect rollback tested with isolated real Pi commands.
- [x] Local TypeScript check and 136 tests on macOS/Node 26/Pi 1.0.2 (commit `c91fe4b`; later verification tracked in development status).

## Repository delivery

- [x] Move development checkout into the owner's personal code workspace.
- [x] Audit initial source content and tarball for secrets/private topology; run local gates.
- [x] Create public `raffaelenatale/pi-cpa-proxy`.
- [x] Initial commit and push on `main` (`89aeb15`, development alpha).
- [x] Observe Linux/macOS Node 22/24 CI and fix confirmed failures; verified green across matrix on run 37357533737.

## Remaining implementation and certification

- Inventory of legacy operational logic skipped at the owner's request; versioned feature research remains incomplete and is not a certification claim.
- [x] Separately enabled alias/context mapping for `compatibleGroups` on existing OAuth channels, with ownership and no upstream-key download. Primary/fallback labels do not configure routing order.
- [ ] Secure connector for actual compatible API-key provider groups and priorities, if required for release; current OAuth mappings do not implement or certify this capability.
- [ ] Certify Manager Plus adapter against an isolated real version/image; keep full-table/no-CAS limitation explicit. `test:manager` is a synthetic loopback probe only, not completion of this gate.
- [x] Decide scoped quota/key/alias/cooldown capabilities and document alpha exclusions in `docs/admin-scope.md`: alias/context supported, secret-bearing usage/listing and non-reversible cooldown actions excluded.
- [ ] Richer provenance/diagnostics, optional external catalogue enrichment, schema migration and machine-preset selection.
- [ ] Complete setup connection checks/discovery guidance and manual TUI usability checks.
- [ ] Additional stream signatures/interleaved tools/retries/long streams, input-limit and session replay/reload coverage; real Keychain checks.
- [ ] Interrupted installation, process/disk failures and multiple-package partial-update recovery; real private Git authentication and registry install/update checks.
- [ ] Supported platform/version matrix based on actual CI/probes, not assumed compatibility.

## Release and private distribution gates

- [ ] Reconcile and approve real private role/preset mappings from final source of truth; preserve existing provider/model IDs/defaults.
- [ ] Choose definitive private repository/package name and build a complete artifact from the public engine, without second maintained source.
- [ ] Security/content review, dependency/license checks, tarball allowlist and clean reproducible release tests.
- [ ] Verify npm identity and name availability without exposing tokens; publish only after implementation completion.
- [ ] Create and push private distribution repository with approved bundled YAML references and verified authentication/update channel.
- [ ] Publish immutable release tags and document pinned rollback, public versus private config behavior and required `/reload`.
- [ ] Controlled per-machine migration with backup, duplicate-registration prevention, effective runtime gates and rollback; no automatic production mutation.

## Operational boundaries

Server CPA owns primary/fallback, quotas/cooldowns and session affinity. Client member metadata does not implement routing. Management commands require opt-in, separate credentials and explicit approval; never run at startup/setup/refresh/update. Snapshot checks and local locks do not substitute for server CAS. Native alias rollback restores scoped semantic lists, not layout/comments. Engine rollback does not reverse administrative server changes.

Mock/native listing tests do not prove effective million-token context, actual upstream tools/images/failover or dynamic served-backend billing. Google functionality is tested; additional Pi→CPA transport hardening remains a documented gap rather than a reason to replace CPA or the SDK.

## Evidence and tracking

Current state: `docs/development-status.md`. Bounded evidence and caveats: `docs/management-contract.md`, `docs/server-profile-contract.md`, `docs/transport-verification.md`, `docs/update-recovery.md`, `docs/feature-research.md`. Synthetic probe outputs are local `.artifacts/` files and intentionally excluded from Git/npm.

Update this plan after each milestone. Keep private deployment details and credentials out of this public plan.
