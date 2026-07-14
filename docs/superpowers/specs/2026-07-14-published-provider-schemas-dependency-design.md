# Published Provider Schemas Dependency Design

## Goal

Replace the in-repository `@aio-proxy/provider-schemas` workspace package with the published `@aio-proxy/provider-schemas@0.1.1` package.

## Dependency boundary

`packages/server` is the only runtime consumer and declares the published package as an exact dependency. The existing imports and dashboard schema API remain unchanged because the published package preserves `providerOptionsSchema`, `hasProviderOptionsSchema`, and `PROVIDER_OPTIONS_SCHEMAS`.

The version is declared directly in `packages/server/package.json` rather than through a workspace catalog. This keeps the dependency visible to Dependabot and makes each provider-schema release an explicit repository update.

## Removed workspace implementation

Delete `packages/provider-schemas` completely, including its generator, npm tarball cache, Rslib plugin, tests, and placeholder/generated source. Remove the package-specific Turbo build override and the CLI binary build prerequisite that existed only to materialize the workspace package's `dist` directory.

Delete the eight superseded specs and plans for the dashboard schema workspace package, Rslib transform, npm tarball cache, and Bun archive implementation. This design replaces those documents.

## Installation and security

Regenerate `bun.lock` with Bun 1.3.14 and the explicit public registry `https://registry.npmjs.org/`. The lockfile must resolve `@aio-proxy/provider-schemas` to version `0.1.1` and contain no workspace entry for `packages/provider-schemas`.

## Verification

- The server provider-options schema route test passes against the installed npm package.
- No active source, package, Turbo, CLI, or lockfile reference points at `packages/provider-schemas` or `workspace:*` for this dependency.
- Repository formatting and unit-test preflight pass.
- The CLI binary build no longer performs a provider-schemas prebuild and still succeeds.

## Constraints

- Do not introduce a compatibility workspace wrapper.
- Do not use a version range for the published package.
- Do not commit or push unless explicitly requested.
