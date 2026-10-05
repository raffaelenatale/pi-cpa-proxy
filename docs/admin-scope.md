# Administrative scope and deliberate exclusions

The alpha supports two separately configured administration adapters: Manager Plus prices and CLIProxyAPI v8 OAuth model-alias/context publication. Neither runs at startup, setup, discovery, refresh or package update. Credentials are external references; server mutations require explicit UI approval, a private journal, verification and latest-transaction rollback within the documented scope.

## Capability decisions

| Capability | Alpha scope | Reason / boundary |
| --- | --- | --- |
| Manager Plus model prices | Implemented; recorded-source and synthetic HTTP tests | Full-table PUT, no server CAS. Real isolated Manager image/version certification remains pending. |
| OAuth aliases and alias-specific context | Implemented; native v8.0.13 probe for single-alias publication | Scoped reads and one PATCH, ownership and latest rollback. |
| `compatibleGroups` | Alias/context rows on existing OAuth channels only | The `primary`/`fallback` labels do not set provider priorities or establish failover order. No upstream API-key group configuration is implemented or certified by these rows. |
| Quota/balance widgets and polling | Deliberately excluded | No certified secret-free quota projection. Passive observations are not a complete quota balance or scheduler availability contract. |
| API-key usage endpoint | Deliberately excluded, including GET | In the inspected handler, entries are keyed by `base_url + "|" + api_key`: even a read would download upstream credentials. |
| Credential listing and cooldown status | Deliberately excluded, including GET | The listing is broader than a secret-free status projection: it can include `account` from `AccountInfo()`, account identifiers, email, paths and arbitrary status messages. Removing these fields after download does not satisfy the upstream-key boundary. |
| Cooldown reset | Deliberately excluded | One-credential POST exists, but clears mutable routing state with no inverse/rollback contract in the inspected handler. A repeat could clear a newly established restriction; acknowledgment loss is not proof a retry is safe. |
| Client/upstream key CRUD, credential upload/download/status/fields/refresh, OAuth flows | Deliberately excluded | Outside alias/price scope; these operations can expose credentials or change account/routing state. |
| Authenticated arbitrary upstream calls, plugin administration/quota actions, logs and complete config/YAML | Deliberately excluded | Broad, unverified privilege and sensitive-output surface. No arbitrary endpoint or command runner is accepted. |
| Fixed server effort/payload rules, provider priorities and session affinity | Server/operator managed | Client metadata and alias labels do not configure routing. |

These are alpha support exclusions, not claims that CLIProxyAPI lacks these capabilities. Use the server's own administration tooling outside this extension. Do not add unsupported YAML flags: the strict schema rejects them.

## Inspected upstream evidence

CLIProxyAPI v8.0.13, immutable commit `d7914afdedca7af95ee974a42453dc49fc1388ce`:

- [Management API v8](https://github.com/router-for-me/CLIProxyAPI/blob/d7914afdedca7af95ee974a42453dc49fc1388ce/docs/management-api-v8.md): public configuration and operational endpoint surface.
- [v8 route registration](https://github.com/router-for-me/CLIProxyAPI/blob/d7914afdedca7af95ee974a42453dc49fc1388ce/internal/api/server_management_v8.go): credential listing, usage and cooldown reset handler mappings.
- [API-key usage handler](https://github.com/router-for-me/CLIProxyAPI/blob/d7914afdedca7af95ee974a42453dc49fc1388ce/internal/api/handlers/management/api_key_usage.go): `GetAPIKeyUsage` and secret-bearing composite keys.
- [Credential listing](https://github.com/router-for-me/CLIProxyAPI/blob/d7914afdedca7af95ee974a42453dc49fc1388ce/internal/api/handlers/management/auth_files.go): `buildAuthFileEntryLocked`, `AccountInfo()` projection and broader status metadata.
- [Cooldown reset handler](https://github.com/router-for-me/CLIProxyAPI/blob/d7914afdedca7af95ee974a42453dc49fc1388ce/internal/api/handlers/management/quota.go): `ResetQuota` accepts `{auth_index}` and replies with `{status, auth_index, models}`; no restoring operation is provided by that handler.
- [Cooldown view](https://github.com/router-for-me/CLIProxyAPI/blob/d7914afdedca7af95ee974a42453dc49fc1388ce/sdk/cliproxy/auth/cooldown_view.go): an empty timer view does not establish overall credential availability.

Only contracts were examined; no upstream implementation or fixtures were copied. No production management endpoint was contacted. Source inspection is not runtime certification.

## Enforcement and reopening criteria

`src/admin-http.ts` retains its fixed four-path allowlist: the two OAuth projections, scoped config PATCH and client model discovery. Manager prices use their separate fixed endpoint. Tests reject the excluded endpoint families before any network request, as well as unsupported quota/key/cooldown configuration fields.

A future scope expansion needs a version-pinned, server-side secret-free projection, separate opt-in permissions, verified response sanitization, bounded output and explicit handling of ambiguous effects. A non-reversible routing action also needs an operator-approved exception to the rollback requirement; it must not be smuggled into the price/alias consent. Existing alpha flags grant no such permission.
