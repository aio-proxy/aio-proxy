# Provider Schemas Rsbuild Plugin Design

## Goal

Make the Rslib/Rsbuild transform the only provider-schema generation path. Generation participates in Rspack's module and watch graphs, emits schema data only into `dist`, and keeps build tooling outside the runtime dependency boundary.

## Architecture

`pluginProviderSchemas()` is registered from `rslib.config.ts` as a build-only plugin. It derives project-owned paths from `api.context.rootPath`:

- transform target: `src/schema-module.ts`;
- generator module: `scripts/provider-schemas-build.ts`.

The physical schema module exports an empty typed `PROVIDER_OPTIONS_SCHEMAS` record. The transform loads the generator through transform-context `importModule()`, generates and deterministically renders the schemas, registers every consumed provider manifest and declaration through `addDependency`, and always returns the rendered source. Rspack compiles that transformed module into `dist`; normal builds never write generated data into `src`.

The package exports only `./dist/index.d.ts` and `./dist/index.js`. There is no generation script, committed generated artifact, freshness comparison, or supported source-import consumer path.

Source-mode consumers therefore require an initial provider-schemas build. The package exposes `dev` through Rslib watch, Turbo completes upstream builds before persistent dev/serve tasks, and direct CLI `start`/`build:binary` commands run the provider-schemas build prerequisite before loading source consumers.

## Error Handling and Watch Behavior

- Missing packages, invalid declaration entrypoints, parser limits, and schema conversion failures fail the transform and therefore the build.
- Dependencies are registered as they are discovered, including before a generation failure, so watch mode can recover when an input changes.
- Optional unsupported types continue to produce warnings; required unsupported types continue to produce unavailable entries.

## Testing

- Verify a non-default `api.context.rootPath` controls both the transform target and generator load path.
- Verify the transform returns generated source and registers provider manifests and declarations.
- Verify package exports point to `dist`, source remains an empty placeholder, and a real build emits the schemas.
- Verify a clean provider-schemas `dist` is rebuilt by the supported CLI start prerequisite before package resolution.
- Preserve deterministic rendering, failure-path dependency, watch, server integration, runtime leakage, and preflight checks.

## Non-Goals

- No custom virtual-module plugin or new dependency.
- No change to the allowlist, schema format, server APIs, dashboard behavior, or standalone binary contents.
