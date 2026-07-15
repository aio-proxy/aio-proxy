# Task 8 Report: Account Login Transaction and Crash Recovery

## Status

Implemented Task 8 from `.superpowers/sdd/task-8-brief.md` without changing
`packages/cli/src/main.ts` or the live vendor command dispatch. The generic
provider login action is staged for the Task 11 cutover.

## Delivered

- Added deterministic Provider ID normalization and allocation, including
  namespaced fingerprint reuse, stable SHA-256 collision suffixes, and
  collision protection for configured and orphan/pending account IDs.
- Added transactional OAuth account create, explicit re-login, and delete
  staging with config-file locking, repository markers, conditional
  compensation, runtime-revision checks, and stable provider digests.
- Added discovery before persistence with bounded cancellation, schema-checked
  in-memory credentials, single-flight refresh, catalog validation, redacted
  failure logging, and last-known-good catalog preservation.
- Added CLI/server crash recovery for create, update, delete, and orphan rows,
  including marker TTLs, server drain gating, orphan grace, supersession, and
  bounded retry scheduling.
- Added generic capability resolution for canonical references, unambiguous
  short IDs, interactive selection, and explicit `--provider` re-login.
- Bound ConfigSpec prompts, OAuth login, authorization, discovery, and the
  manual-only confirmation prompt to the login cancellation/deadline signal.
- Treated only missing `providers` as empty. Scalar, null, and array-like
  malformed values are never overwritten; recovery preserves repository data
  and returns a five-second retry deadline.
- Cleared `CREDENTIAL_REFRESH_FAILED` inside account-operation staging and
  retained conditional compensation so an un-superseded rollback restores the
  prior diagnostic state.

## RED / GREEN Evidence

### Initial RED

The required focused command was run before the Task 8 modules existed:

```text
bun test packages/core/_test/plugins/provider-id.test.ts packages/core/_test/plugins/account-login.test.ts packages/cli/_test/provider-plugin-login.test.ts
```

It failed because Provider ID allocation, the account transaction/recovery
module, and generic provider login did not exist.

### Review-driven RED

After the first green implementation, four regression areas were tested before
their fixes. The combined focused run reported 36 passed, 5 failed, and 1
module-export error:

- an orphan account ID was incorrectly considered free;
- two concurrent discovery refreshes executed two exchanges;
- login overwrote a scalar `providers` value;
- recovery deleted an apparent orphan under malformed config and returned no
  retry deadline;
- the manual-only signal helper did not yet exist.

The expected failure values included `work` instead of the hashed Provider ID,
two exchanges instead of one, a resolved malformed-config login, and
`nextRunAt: undefined` instead of `now + 5_000`.

### GREEN

The final focused run passed 49 tests with 145 assertions. It specifically
proved:

- orphan account Provider IDs participate in allocation collisions;
- same-revision discovery refreshes share one exchange and both observe
  revision 1;
- a stale revision returns `superseded` without another exchange;
- malformed config prevents login and delete staging without changing bytes;
- malformed-config recovery retains the account and returns `now + 5_000`;
- manual-only confirmation receives the exact login signal.

## Verification

- Core Rslib build and declaration generation: passed.
- Isolated strict CLI typecheck for `provider-login.ts`: passed.
- Focused Provider ID/account login/generic CLI suite: 49 passed, 0 failed.
- Full Core unit suite: 425 passed, 0 failed, 1,071 assertions.
- Full CLI unit suite: 123 passed, 0 failed, 339 assertions.
- Scoped Biome check: passed with 37 expected `useLiteralKeys` information
  notices required by index-signature access typing and no warnings/errors.
- `git diff --check`: passed.

An earlier attempt ran Core build, declaration-dependent CLI typechecking, and
multiple test suites concurrently. That attempt was not accepted as evidence:
the typecheck raced partially regenerated declarations, and a Core npm-lock
test timed out under parallel load. After the build completed, the strict
typecheck passed; the complete Core suite then passed in isolation, including
the previously timed-out npm-lock test.

A later final Core run also hit the existing five-second timeout in
`AtomicConfigFile > serializes concurrent stale-lock recovery without deleting
a replacement owner` (424 passed, 1 failed). No lock implementation changed in
this task. The failing test then passed three isolated repetitions, and the
following complete Core run passed all 425 tests.

## Self-review

- Verified the implementation does not modify `packages/cli/src/main.ts` or
  `packages/cli/src/provider-commands.ts`.
- Verified same-protocol/live vendor dispatch remains unchanged until Task 11.
- Verified account secrets and credential leaves are supplied to error
  redaction and are not asserted in diagnostics or logs.
- Verified all config/repository compensation paths are conditional on the
  operation's applied revision and preserve newer credential/runtime data.
- Verified create duplicate checks and Provider ID allocation are repeated
  under the config lock, including orphan and pending account identities.
- Verified malformed provider containers return before recovery mutates any
  pending marker, account, catalog, secret, or diagnostic row.

## Files Outside the Brief's Short List

- `packages/core/src/plugins/repository.ts` and its test were minimally changed
  because Step 6 requires staging to clear `CREDENTIAL_REFRESH_FAILED` in the
  same SQLite transaction and compensation to restore it conditionally.
- `packages/cli/src/plugin-commands/index.ts` exports the staged generic command
  for direct consumers and tests; it does not register it with Commander.

## Concerns

- The generic command intentionally remains unreachable from the public CLI
  until Task 11 wires the config parser and runtime materializer atomically.
- No changes were pushed.

## Formal Review Fix Report

The formal task reviewer returned four Important findings and one Minor
finding. All five were addressed before Task 8 was closed:

- The login deadline signal now guards config-lock acquisition, recovery-fence
  waits, preflight mutation, asynchronous account/credential schema parsing,
  final staging, and the last pre-write transaction checks. A staged operation
  created immediately before cancellation is conditionally compensated.
- Core login failures expose typed errors with stable safe codes and fields;
  the CLI maps them to `packages/i18n` messages. Capability prompts and both
  English and Simplified Chinese host copy are localized.
- Non-interactive ambiguity errors now include every canonical
  `plugin#capability` reference in the final user-visible message.
- Deterministic post-callback config write failures now prove that create
  compensation removes the staged account and ordinary update compensation
  restores account options, secrets, credential, catalog, and diagnostics.
  Superseded and uncertain-commit characterizations remain covered.
- Default dependency creation closes its SQLite handle when registry loading
  or plugin setup fails before the dependency object can be returned.

### Formal Review RED

The Core review tests initially reported 32 passing and 3 expected failures:

- abort during the final config-lock wait still committed;
- an already-aborted re-login preflight still cancelled a delete marker;
- abort during asynchronous account schema validation still reached adapter
  login.

The CLI review tests initially failed module loading because the new localized
prompt and default-dependency helpers did not yet exist. The definite create
and update compensation tests were added at the same time and characterized
the already-correct conditional repository compensation behavior.

### Formal Review GREEN and Final Verification

- Focused Task 8 suite: 60 passed, 0 failed, 181 assertions.
- Full Core suite: 433 passed, 0 failed, 1,100 assertions.
- Full CLI suite: 126 passed, 0 failed, 346 assertions.
- `bun run i18n:compile`: passed.
- `bun run --filter @aio-proxy/core build`: passed, including declaration
  generation.
- `bunx tsc -p packages/cli/tsconfig.json --noEmit --pretty false`: passed.
- Scoped Biome check: passed with informational `useLiteralKeys` notices only.
- `git diff --check`: passed.

## Re-review Addendum: Provider ID Collision Localization

The final re-review identified one remaining host-facing Core error. The
exhausted deterministic Provider ID collision now uses the stable Core code
`PROVIDER_ID_COLLISION`, retains the safe typed `providerId` field, and is
localized by the CLI through English and Simplified Chinese i18n messages.

### RED / GREEN

- RED: the direct CLI regression test reported 11 passed and 1 failed because
  the final message was the Core string `Unable to allocate a unique Provider
  ID` instead of localized copy containing the safe candidate.
- GREEN after i18n compilation: the same file passed 12 tests with 24
  assertions, including `person-deadbeef` interpolation.

### Re-review Verification

- Focused Task 8 suite: 61 passed, 0 failed, 182 assertions.
- `bun run i18n:compile`: passed.
- Core Rslib build and declaration generation: passed.
- Full CLI TypeScript no-emit check: passed.
- Scoped Biome: passed with 9 pre-existing `useLiteralKeys` information notices
  and no warnings/errors.
- `git diff --check`: passed.

### Re-review Self-review

- Only collision error coding/localization, its direct CLI regression test,
  message catalogs, and this report changed.
- Third-party error strings remain opaque and no public CLI wiring changed.
