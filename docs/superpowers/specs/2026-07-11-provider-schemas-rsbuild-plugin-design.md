# Provider Schemas Rsbuild Plugin Design

## Goal

Replace the current `onBeforeBuild` file-writing wrapper with a module-aware Rsbuild plugin. Schema generation must participate in Rspack's module and watch graphs while preserving the committed deterministic `src/generated.ts` artifact and the standalone runtime dependency boundary.

## Current Problem

The current plugin is structurally an `RsbuildPlugin`, but its only behavior is calling `writeGeneratedProviderSchemas()` from `onBeforeBuild`. Rsbuild does not know which declaration files were consumed, watch mode cannot invalidate from those inputs, and a normal build silently mutates the working tree.

## Architecture

Create an exported `pluginProviderSchemas()` Rsbuild plugin and register it from `rslib.config.ts`.

The plugin uses `api.transform` to match the absolute `src/generated.ts` module. Its transform handler:

1. resolves each allowlisted provider package;
2. records every consumed package manifest and declaration file;
3. generates and deterministically renders the provider schema module;
4. registers each consumed file with `addDependency`;
5. compares the rendered module with the committed input source; and
6. throws an actionable stale-artifact error when they differ, otherwise returning the generated source.

The plugin uses the scoped name `aio-proxy:provider-schemas` and Rsbuild's logger for generation diagnostics. It is build-only because this package is produced through Rslib build/watch rather than an application dev server.

## Generated Artifact Workflow

`src/generated.ts` remains committed for reviewability, direct source imports, declaration generation, and deterministic freshness tests. Builds never write it.

Add an explicit package script that runs the generator's write function when provider declarations or the allowlist change. The stale build error tells contributors to run this command.

## Dependency Tracking

Declaration parsing returns the absolute declaration files it traversed. Generation also records each provider package's `package.json` because package version and declaration entry metadata affect output. The transform registers these paths with `addDependency`, allowing Rspack watch rebuilds to react to the real generator inputs without watching entire package directories.

The allowlist and generator modules are already part of the build configuration dependency graph; the transform explicitly tracks only external provider inputs.

## Error Handling

- Missing packages, invalid declaration entrypoints, parser limits, and schema conversion failures fail the transform and therefore the build.
- A stale committed artifact fails with the regeneration command instead of modifying the worktree.
- Optional unsupported types continue to produce warnings inside generated schema entries; required unsupported types continue to produce unavailable entries.

## Testing

- Unit-test that the plugin registers an `api.transform` handler for `src/generated.ts` rather than an `onBeforeBuild` callback.
- Invoke the registered transform with real generation and assert it returns deterministic source and registers provider manifests/declaration files.
- Assert stale source produces the actionable regeneration error.
- Preserve parser, normalization, exact allowlist, freshness, build, runtime bundle leakage, and preflight tests.

## Non-Goals

- No custom Rspack virtual-module plugin.
- No new runtime dependency.
- No change to the schema allowlist, schema format, server APIs, dashboard behavior, or standalone binary contents.
- No broad directory watches or plugin-to-plugin exposed API.
