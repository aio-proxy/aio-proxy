# Task 3 Report: Expanded npm-latest provider catalog

## Status

Complete. The user's 42-entry `{ packageName, factoryName }` catalog is preserved without versions. Every entry resolved from public npm `latest` and generated successfully; there were no package-name or factory-export mismatches.

## RED

- Added `generates the exact allowlist from npm latest without provider dependencies`.
- The focused test failed because allowlisted provider packages were still declared in `@aio-proxy/provider-schemas` devDependencies (`Received: "catalog:"`).
- Added a core metadata test for bundled runtime versions. It first failed because `BUNDLED_PROVIDER_VERSIONS` did not exist.
- After the first expanded build, the focused server test exposed a real version-semantics regression: bundled runtime status incorrectly reported schema-source latest `3.0.7` instead of the actual bundled `@ai-sdk/openai-compatible` version `3.0.2`.

## GREEN

- Removed all eight provider-only devDependencies from `packages/provider-schemas/package.json` and updated `bun.lock`; retained only build tooling and `tar`.
- Adopted all 42 user-authored allowlist entries exactly, with no version field and no skipped failures.
- Added exact-key, non-empty resolved-version, and dependency-boundary assertions.
- Exported an explicit eight-package `BUNDLED_PROVIDER_VERSIONS` map from core, verified it against installed package manifests, and changed bundled package status to use runtime versions. Options-schema `packageVersion` remains the independent npm-latest schema-source version.
- Updated the active design and plan to document versionless latest resolution, watch-cache behavior, accepted latest non-reproducibility, and runtime-version/schema-version separation.

## Network and catalog result

- Clean-cache build: `provider schemas: 42 generated`.
- All 42 npm metadata/tarball resolutions succeeded on the first clean-worktree build.
- No retry loop was used.
- No npm package mismatch, missing factory export, or silently unavailable entry occurred.
- Representative resolved latest versions: `@ai-sdk/gateway@4.0.16`, `@ai-sdk/openai-compatible@3.0.7`, `@ai-sdk/openai@4.0.11`, and `@openrouter/ai-sdk-provider@3.0.0`.

## Clean-worktree verification

- Created detached `/tmp/aio-proxy-provider-cache-verify` from Task 2 HEAD.
- Applied only the tracked Task 3 patch.
- `bun install --frozen-lockfile` succeeded.
- A naturally empty provider source cache built all 42 entries into `dist` successfully.
- Inspected the built runtime export and confirmed all catalog keys had non-empty latest versions.
- Removed and pruned the temporary worktree afterward.

## Watch-cache verification

- Started real `rslib --watch --no-clean` with the cache populated by the clean build.
- First watch build succeeded.
- In the temporary worktree only, changed the cache module's default fetch to always reject with `registry accessed during watch smoke`.
- The generator-module edit triggered a second build: `provider schemas: 42 generated`, completed successfully in 0.27s.
- This proves the watch rebuild used cached observations and did not access the registry.

## Final verification

- Provider schemas: 76 passed, 0 failed.
- Core bundled-provider loader: 4 passed, 0 failed.
- Focused server tests: 12 passed, 0 failed.
- Provider build: 42 generated; 4 dist files, 66.3 kB.
- Runtime leakage scan: no Babel, TypeBox, tar, registry/cache, generator, build-entry, or plugin matches in provider dist or the 3.1 MB CLI bundle.
- `bun run preflight`: 13/13 Turbo tasks successful. Only the pre-existing dashboard `noNonNullAssertion` warning remained.

## Files

- `packages/provider-schemas/src/allowlist.ts`
- `packages/provider-schemas/package.json`
- `packages/provider-schemas/_test/schema-generator.test.ts`
- `packages/core/src/provider/ai-sdk-loader.ts`
- `packages/core/src/index.ts`
- `packages/core/_test/provider/ai-sdk-loader.test.ts`
- `packages/server/src/dashboard-routes/provider-package-metadata.ts`
- `packages/server/_test/dashboard-provider-options-schema.test.ts`
- `docs/superpowers/specs/2026-07-11-dashboard-json-editor-provider-schema-design.md`
- `docs/superpowers/plans/2026-07-11-dashboard-json-editor-provider-schema.md`
- `bun.lock`

## Self-review

- Catalog entries were preserved exactly and remain versionless.
- Provider generation has no provider package dependency fallback and fails closed on any future package/factory mismatch.
- The integration fix keeps runtime bundled versions independent from npm-latest schema versions.
- `output/` and the existing safety stash were not touched.

## Commit

- `feat(provider-schemas): generate expanded catalog from npm` (this report is included in the task commit; the resulting hash is returned to the parent agent).
