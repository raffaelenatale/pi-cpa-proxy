# Feature research ledger

Implementation is independently authored. No source file, function name, code block or fixture from community repositories was used in this package. Required SDK method names and protocol names are interoperability contracts.

This ledger distinguishes verified documentation from candidates still requiring research. It is not a claim of feature parity with these packages.

| Source | Evidence available | Independent requirement | State |
|---|---|---|---|
| `victormilk/pi-proxy-models` README, https://github.com/victormilk/pi-proxy-models | README read in the planning conversation: discovery, env/file config, status/models/refresh, per-family APIs, context/output overrides and fallback list | Configured transport, refresh and diagnostics; explicit override support | Implemented with native Pi provider and no model-name guessing; no copied partitioning architecture |
| `pi-cliproxyapi-provider`, https://www.npmjs.com/package/pi-cliproxyapi-provider | Search/package description: discovery and models.dev enrichment | Enrichment with provenance and caching | Pi bundled catalogue implemented; external models.dev fetch pending verification |
| `pi-cliproxyapi`, https://www.npmjs.com/package/pi-cliproxyapi | Search/package description: centralized endpoint/key setup and management | Setup, config and observability | Original reference-based setup implemented; broader UX/admin research pending |
| `Villoh/pi-cliproxy-usage`, https://github.com/Villoh/pi-cliproxy-usage | Search description: account usage meters | Optional quota display | Deferred until management adapters are verified |
| `Zigerry/cliproxy-usage`, https://github.com/Zigerry/cliproxy-usage | Search description: OAuth quota and provider balances | Optional read-only quota/balance adapters | Deferred; server support and permissions unverified |

No immutable refs or fresh full audits of the last four projects have been captured yet. Record exact versions and testable behavior before implementing dependent features. Do not treat a fork's claimed behavior as the original package's verified behavior.

## Official Pi contracts

The design uses Pi's documented native `Provider`, `createProvider`, API implementations, `refreshModels` publication contract, and package manifest. The catalogue is obtained from the host, not maintained as a list of particular models in this repository.

The first isolated CLI probe found that native provider registration is initially refreshed cache-only in Pi 1.0.2. Accordingly the awaited extension factory primes discovery before registration unless offline, making first-install `--list-models` usable. The code and regression probe are our own.

The Git update probe exercises two synthetic release versions of the real runtime, not a status-only mock of the package manager. Private config is a bundled package resource; public/local overrides live outside the checkout.
