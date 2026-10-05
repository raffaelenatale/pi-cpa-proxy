# Package updates, pins and recovery — Pi 1.0.2

Verified with real Pi CLI commands in isolated homes, synthetic public/private Git repositories, local bare remotes reached via process-scoped URL rewriting. No live repository credentials, production models or global configuration were used.

## Observed matrix

| Scenario | Observed result |
|---|---|
| Default-branch update | Engine advances; public user YAML stays byte-identical; private bundled YAML updates; override stays byte-identical |
| Install same repository at `@probe-v1` | Existing checkout reconciles to release one; one package declaration, not duplicate registrations |
| Update a tag-pinned package | Remains at the tag; does not advance to main |
| Install/update exact commit pin | Checkout remains at that commit |
| Remote temporarily unavailable | Pi update exits **1**; previous checkout/settings retained; primed offline model cache still loads |
| Invalid root package.json in new release | Pi update exits **1**, but checkout has already advanced; dependencies cleaned; incomplete-update marker remains |
| Reinstall known-good commit after install failure | Git/dependencies repaired, incomplete marker removed; models available again |
| Corrected default branch | Explicitly restoring unpinned source advances to corrected release |
| Valid package with throwing extension factory | Package update exits **0**; `--list-models` also exits **0** with expected model absent |
| Pin known-good commit after runtime defect | Expected models available again |

Both distributions preserve their external config and selected defaults (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`) throughout these scenarios.

An update is **not an atomic runtime deployment**. Pi resets the checkout before installing dependencies. Package installation does not execute our functional gates and is not an extension health verdict. This extension does not modify Pi's updater or add a background installer.

## Choosing the update channel

- `git:.../repository` follows the configured/default branch on package reconciliation.
- `git:.../repository@tag` selects that ref; update does not advance to newer tag names. Treat release tags as immutable by repository policy. Pi does not prove a tag cannot be moved by its owner.
- `git:.../repository@COMMIT` selects an exact commit and is the preferred reproducible rollback point.
- Repository identity ignores the ref, so switching refs should replace the declaration, not install the public and private engine together.
- Tests cover default branch, ordinary tag and full commit refs on Pi 1.0.2. Do not generalize to other versions, branch pins, signed-tag verification or registry updates.

## Explicit rollback procedure

Use the same installed repository source and a previously verified ref. These are placeholders, not published releases:

```sh
# Select known-good engine/preset; Pi reconciles the existing installation.
pi install git:https://github.com/OWNER/REPOSITORY@KNOWN_GOOD_COMMIT

# Verify actual expected models, not just command exit status.
pi --no-context-files --no-skills --no-prompt-templates --list-models YOUR_PROVIDER

# Already-open sessions:
/reload
```

Confirm the expected provider/model IDs, limits and costs in the listing/status, and run the release-specific isolated smoke gates before relying on the new code. A model listing alone does not prove completions or routing.

Private rollback also restores that release's packaged YAML. Local overrides still win; if they mask the rolled-back value, inspect and explicitly reconcile them rather than deleting them automatically. Public config never rolls back with the engine. Admin journals are outside the package; engine rollback does not reverse server changes.

When the default branch is corrected, explicitly select the unpinned source again:

```sh
pi install git:https://github.com/OWNER/REPOSITORY
pi update --extensions
# Then health checks and /reload for existing sessions.
```

No failed-update recovery should blindly remove the config, credentials or journals. Do not edit files inside the managed checkout as a recovery strategy: Pi can reset/clean them.

## Evidence and limits

`npm run test:update` writes `.artifacts/update-probe.json`, including actual subprocess exit statuses, synthetic failure output, snapshot checks and good commit references. `commandOutcome` preserves stdout/stderr/status separately so failure assertions do not infer results from exception strings.

The deterministic install failure is invalid **root** JSON. Missing/malformed `file:` link dependencies proved unsuitable as failure injectors: npm accepted them. These were test-fixture corrections, not Pi updater defects. Runtime defects are checked by absence of the expected model; Pi listing did not print the thrown factory detail in the tested path.

Not verified: real private GitHub authentication, npm publication/update, remote CI platforms, already-running session reload/handoff, process-killed/disk-full recovery, interruption within dependency installation, concurrent/multiple-package partial updates. No automated compensating updater or transactional multi-machine release is claimed.
