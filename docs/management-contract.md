# Recorded management HTTP contract

This is an independently implemented client adapter, not copied upstream code. Only wire contracts and behavior were examined.

## Sources

CPA Manager Plus upstream snapshot inspected:
`fb3e8f501f47a29b0fa66a5bf31f0f36739750d3`.

- https://github.com/seakee/CPA-Manager-Plus/blob/fb3e8f501f47a29b0fa66a5bf31f0f36739750d3/apps/manager-server/internal/http/controller/modelprice/handler.go
- https://github.com/seakee/CPA-Manager-Plus/blob/fb3e8f501f47a29b0fa66a5bf31f0f36739750d3/apps/manager-server/internal/service/modelprice/service.go
- https://github.com/seakee/CPA-Manager-Plus/blob/fb3e8f501f47a29b0fa66a5bf31f0f36739750d3/apps/manager-server/internal/repository/modelprice/repository.go
- https://github.com/seakee/CPA-Manager-Plus/blob/fb3e8f501f47a29b0fa66a5bf31f0f36739750d3/apps/manager-server/internal/model/model_price.go
- https://github.com/seakee/CPA-Manager-Plus/blob/fb3e8f501f47a29b0fa66a5bf31f0f36739750d3/apps/manager-server/internal/model/model_price_rules.go
- https://github.com/seakee/CPA-Manager-Plus/blob/fb3e8f501f47a29b0fa66a5bf31f0f36739750d3/apps/docs/en/manual/model-prices.md

The existing operational pricing helper uses direct SQLite; that was not transplanted into this public extension. This HTTP adapter requires compatible Manager Plus, not plain CLIProxyAPI or arbitrary CPAPlus installations.

## Verified from sources

- GET `/v0/management/model-prices` returns `{prices: {...}}`.
- PUT at the same path accepts `{prices: {...}}` and returns the resulting table.
- Panel authorization is required; the client uses its separately configured admin Bearer key.
- PUT replaces the whole table, including advanced rules, inside the repository's database transaction.
- No HTTP ETag/If-Match or compare-and-swap implementation was identified in this inspected handler/service path.
- Context tiers use `thresholdTokens`, activate strictly above the threshold and support explicit configured flags for zero prices.
- Service tiers and source/raw metadata are part of table entries and must be preserved for unrelated rows.
- Server updates entry timestamps; Go omitempty can omit optional zero/false/empty fields. Client comparison normalizes these representations, not rates or pricing structure.
- Structural changes can return HTTP 409 when retained pricing history cannot rebuild rollups. The adapter does not bypass this server safeguard.

## Our adapter behavior

- Configured operations are limited to this fixed price endpoint.
- GET validates supported fields strictly; unknown contract fields block mutation instead of being discarded.
- Read-only status proves only this GET contract, not PUT permissions or every management capability.
- Prices to manage are an explicit map, separate from client catalogue costs. No removal or takeover of unknown rows.
- A scoped change is assembled into a full-table before/after snapshot. Exact preview hash and current config must match approval before apply.
- Mutations require operator exclusive-writer assertion plus interactive confirmation; without this no PUT is sent.
- Local lock and fresh before-snapshot comparison provide client-side safeguards, not a distributed/server atomic lock.
- Pre-write journal and read-back verification; uncertain network effects are reported and block the next apply until recovered.
- Rollback latest transaction only, with full-table conflict checks and retry-safe acknowledgment recovery. Archived snapshots remain for diagnosis, not arbitrary old rollback via the UI.
- No automatic rollback on ambiguity, which could overwrite a concurrent server change.

## Evidence and remaining work

Tests run against an original synthetic HTTP server exercising this recorded shape. The real installed Manager was not read or written during this milestone. Live compatibility must be checked read-only first, then with an isolated instance/image before production write support is promoted.

Still pending: plain CPA configuration/profile adapter, keys/aliases/cooldowns, quota adapters, multi-resource journal, capability/version identification beyond the known price GET shape, headless approved-plan protocol, journal retention, and distributed concurrency support if upstream adds a suitable contract.
