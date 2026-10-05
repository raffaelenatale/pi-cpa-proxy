# Setup connection checks — verified scope

`/cpa-setup` requires an interactive UI and idle session. Its connection wizard records the chosen native protocol (`openai-completions`, `openai-responses`, `anthropic-messages` or `google-generative-ai`) explicitly. Existing model-specific API overrides remain unchanged; changing the connection default does not rewrite those overrides. Editing a Keychain reference pre-fills its existing service/account, not its value.

Before final save, both the wizard and advanced editor offer:

- **Save without connection check**: default first choice; no network or credential resolution.
- **Check connection before saving**: resolve the selected connection's external client credential and issue authenticated GET `/v1/models` on its configured origin. The wizard checks the edited connection; the advanced editor asks which connection when several exist.

The check is implemented by `checkSetupConnection` in `src/setup-check.ts`, reusing the runtime `requestListing` validator and `deriveCatalogue` resolver. It does not create a provider, write a cache/journal, call a completion API, access an admin credential, change Pi defaults or mutate CPA. Credential resolution and request have bounded deadlines; redirects are refused and the response is bounded to 2 MB and 10,000 IDs by the discovery validator.

## Results and guidance

The UI reports only unique listed IDs as a count, executable model count, omitted metadata count and missing-profile count. It does not print the key, response body or model IDs. Missing credentials, HTTP failures, invalid bodies and connectivity/timeout failures produce redacted error codes.

Unknown/incomplete models require explicit metadata/source overrides in the advanced editor. A missing profile must be published by the server; setup never synthesizes an executable server alias. Successful listing is not verification of the selected completion protocol, tools, image support, priorities/fallback or effective context size. A successful check with zero usable models is reported as such, not as a working completion configuration.

The final save still requires a separate confirmation. A failed check does not automatically write anything or discard the user's edits: the operator may deliberately save an unverified/offline configuration. Cancelling the check selection or final save leaves the existing local configuration unchanged. Saving uses the existing validated atomic/conflict-checked local-layer writer; active provider changes require `/reload`.

## Evidence and limitations

`tests/setup.test.ts` and `tests/setup-check.test.ts` use UI mocks and loopback-only synthetic servers. Tests cover all protocol selections, counts, missing credentials, cancellation, 401, malformed response, redirect refusal, timeout, skip-with-zero-requests, config preservation and zero administration requests even when admin references are configured.

These tests do not certify manual TUI usability, live gateway completion behavior or a real Keychain lookup. Those release checks remain open. The setup check is not triggered at startup, refresh or package update.
