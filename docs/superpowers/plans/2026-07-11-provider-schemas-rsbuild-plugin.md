# Provider Schemas Rsbuild Plugin Implementation Plan

## Goal

Use the Rslib/Rsbuild transform as the sole provider-schema generation path and emit generated data only into `dist`.

## Final Shape

- `src/schema-module.ts` is a small physical transform input containing an empty typed record.
- `src/index.ts` imports and re-exports that module.
- `provider-schemas-plugin.ts` resolves the target and generator module from `api.context.rootPath`.
- The transform loads `provider-schemas-build.ts` with `importModule()`, tracks all consumed inputs, and returns deterministic generated source without comparing or writing source files.
- Package exports resolve `dist/index.d.ts` and `dist/index.js`.
- Turbo build inputs include `scripts/**`.
- No explicit generation command or committed generated schema artifact remains.

## Implementation

1. Update focused tests for the placeholder module, non-default root path, transform return value, dependency tracking, dist exports, and real built output. Remove freshness and stale-source expectations.
2. Confirm RED against the former committed-artifact workflow.
3. Replace `src/generated.ts` with `src/schema-module.ts`, delete the generation CLI, update the plugin and package exports, and add generator scripts to Turbo inputs.
4. Update provider-schema design and implementation documentation to describe the dist-only workflow.
5. Run provider-schema tests, package build, server tests after dependency build, runtime leakage checks, and repository preflight.

## Constraints

- Preserve deterministic rendering, dependency registration on success and failure, real watch behavior, and the runtime dependency boundary.
- Do not change the allowlist, schemas, server APIs, dashboard behavior, or add dependencies/abstractions.
- Use `rtk` for verification and include `Co-authored-by: Codex <noreply@openai.com>` in the commit.
