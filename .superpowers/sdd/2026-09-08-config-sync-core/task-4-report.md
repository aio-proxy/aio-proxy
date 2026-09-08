# Task 4 implementation report

## Result

Implemented pure, backend-neutral projection of committed authored configuration and local overlays. The projection uses persisted `LocalEntity` object IDs, never allocates identities, and keeps source revision metadata local to the caller.

## Files

- `packages/core/src/sync/projection/index.ts`: export-only projection barrel.
- `packages/core/src/sync/projection/projection.ts`: committed source projection, provider/account selection, plugin dependency and secret projection, service access, routing defaults, and local raw fragments.
- `packages/core/src/sync/projection/model-overlays.ts`: model policy filtering and preservation of excluded structured provider references.
- `packages/core/src/sync/projection/local-overrides.ts`: JSON validation/cloning, raw object merging, and nested local override application/removal.
- `packages/core/src/sync/projection/projection.test.ts`: regression coverage for selected secrets/accounts, excluded proxies, model references, service/routing values, environment templates, API provider keys, nested/root overrides, authored plugin string/tuple/array options, missing OAuth accounts/dependencies, local-only providers, AI SDK package secrets, and invalid secret values.
- `packages/core/src/sync/index.ts`: exports the projection interfaces and functions.
- `packages/core/src/sync/test-support.ts`: adds the requested `includedEntity` and `storedAccount` fixtures.

## Behavior

- Selected OAuth providers carry their global provider entity, dedicated account row keyed by global object ID, required plugin dependency, and plugin business secret. Excluded provider accounts and proxy URLs remain local.
- API provider keys, server API keys/password, retry settings, and raw environment templates are shared as authored. Top-level/provider proxies and local server settings stay in `Projection.local`.
- Model entities retain only selected provider references in the shared body; excluded references remain in local overlays and are restored by `overlayLocal`.
- Plugin dependencies use persisted plugin-business identities and installed versions. Explicit business plugin configuration and selected OAuth plugin secrets are carried at package granularity. AI SDK executable package dependencies do not receive a plugin secret unless the package is explicitly enabled as a business plugin.
- JSON-bound unknown values are validated before projection. Missing dependency identity/version causes the dependent entity to be omitted, leaving pending-state handling to the sync coordinator rather than allocating an unstable ID.
- Local JSON-pointer overrides support nested replacement, array replacement, and explicit `undefined` deletion during local import. Filtering a provider/model/plugin does not create a cloud deletion.
- Plugin overrides operate on the normalized `{ packageName, options }` view and are written back as the original authored string or tuple representation. Root overrides replace that plugin entry or remove it when their value is `undefined`; option paths retain nested and array semantics. Selected OAuth providers without a committed account row are omitted together with their account payload, leaving activation pending instead of creating a runnable credential-less provider.

## Verification

- `bun test packages/core/src/sync` — 31 passed, 0 failed.
- `bunx tsc -p packages/core/tsconfig.json --noEmit` — passed.
- `bunx oxlint packages/core/src/sync/projection packages/core/src/sync/index.ts packages/core/src/sync/test-support.ts` — passed.
- `bunx oxfmt --check packages/core/src/sync/projection packages/core/src/sync/index.ts packages/core/src/sync/test-support.ts` — passed.
- `bun run --filter @aio-proxy/core build` — passed.
- `git diff --check` — passed.

## Concerns

The projection API has no pending-condition result field. When a persisted dependency identity/package version or selected OAuth account is missing, it deliberately omits the dependent entity; the later sync coordinator must translate that absence into its explicit pending activation state.
