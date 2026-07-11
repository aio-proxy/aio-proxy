# Provider Schema Tarball Cache Design

## Goal

Generate embedded option schemas for the expanded public provider allowlist without declaring every provider package as a workspace dependency. Rslib's transform remains the only schema-generation path, and provider packages and build tooling must not enter the runtime binary.

## Decisions

- The schema source allowlist remains `{ packageName, factoryName }`; it does not pin package versions.
- Every one-shot `rslib build` resolves each package through its npm `latest` dist-tag.
- `rslib --watch` reuses the newest locally cached package source and avoids registry requests during incremental rebuilds. A watch build fetches `latest` only when no cached version exists for a package.
- The resolved version is recorded in cache metadata and in the generated schema entry's `packageVersion`.
- The same repository commit may produce different schema output after an npm `latest` dist-tag changes. This non-reproducibility is an accepted consequence of following `latest`.
- Only public npm packages are supported initially. Private registries and authentication are out of scope.

## Architecture

Introduce one build-only module with a narrow interface:

```ts
type ProviderSchemaSource = {
  readonly packageName: string;
  readonly factoryName: string;
};

type ResolveProviderSourceOptions = {
  readonly refreshLatest: boolean;
  readonly cacheRoot: string;
  readonly onDependency?: (path: string) => void;
};

resolveProviderSource(
  source: ProviderSchemaSource,
  options: ResolveProviderSourceOptions,
): Promise<string>; // absolute package root
```

The existing generator consumes the returned package root and remains unaware of npm metadata, HTTP, integrity verification, archives, and caching. Existing declaration traversal, safety limits, TypeBox conversion, normalization, deterministic rendering, and runtime lookup remain unchanged.

The Rsbuild plugin registers `api.onBeforeBuild` only to capture `isWatch` for the current compilation. It does not generate schemas or write source files in this hook. The `api.transform` handler remains the sole generation entry and passes `refreshLatest: !isWatch` into the generator/source resolver.

## Registry and Cache Flow

The cache lives below `packages/provider-schemas/node_modules/.cache/provider-schemas`. It is ignored, build-only state and is not a Turbo output.

For each allowlisted source:

1. In one-shot build mode, fetch the package's public npm metadata and read `dist-tags.latest`.
2. In watch mode, read the package's cached `latest.json` pointer. If it is absent, fetch metadata and resolve `latest` once.
3. Look for a complete cache entry keyed by package name and resolved version.
4. On a miss, fetch the exact version metadata, then download its `dist.tarball`.
5. Verify the tarball against npm's `dist.integrity` using Node's crypto implementation before extraction.
6. Extract only `package/package.json` and `*.d.ts`/`*.d.mts`/`*.d.cts` entries into a temporary sibling directory with the build-only `tar` package. Reject absolute paths, traversal paths, and archive links. Reject compressed responses larger than 32 MiB.
7. Validate the extracted `package.json` name and version against the resolved package and version.
8. Write cache metadata, atomically rename the temporary directory to its final versioned cache location, then atomically update the package's `latest.json` pointer.
9. Return the absolute extracted package root to the existing generator.

Concurrent cache misses may race. Atomic rename is the seam: one writer wins, and another writer discards its temporary directory after observing the completed destination. No persistent lock protocol is needed for this build-only cache.

One-shot builds fail when registry refresh, download, integrity verification, extraction, or metadata validation fails. Watch builds with a usable cache do not access the registry. Watch builds without a cache fail with the same actionable package-specific error.

## Rslib Integration

`provider-schemas-plugin.ts` keeps its existing `api.transform` target and build-only `importModule()` loader graph. It adds an `onBeforeBuild` callback solely to update a closure containing `isWatch` before compilation.

The generator entry receives the source-resolution mode and cache root from the plugin. Every extracted `package.json` and traversed declaration remains registered through the existing dependency callback, so changes in the cached package source participate in Rspack's module/watch graph.

No explicit `generate` command, standalone writer, committed generated schema artifact, or source freshness comparison is introduced.

## Dependency and Runtime Boundary

Provider packages removed from `@aio-proxy/provider-schemas` devDependencies are no longer installed into the workspace solely for schema extraction. Packages needed elsewhere in the repository remain declared by their actual runtime consumers.

The `tar` archive library is a direct devDependency of `@aio-proxy/provider-schemas`. Registry, archive, parser, TypeBox, generator, and plugin modules remain build-only and must not appear in `packages/provider-schemas/dist` or the CLI binary.

## Testing

- Source resolver unit tests use an in-process HTTP fixture serving npm metadata and tarballs.
- A cache-miss test verifies `latest` resolution, integrity checking, safe extraction, package metadata validation, and the returned package root.
- A cache-hit watch test verifies no registry request occurs.
- A one-shot build test verifies metadata is checked on every build and a changed `latest` downloads a new version.
- Failure tests cover registry errors, missing dist-tags, integrity mismatch, unsafe archive paths, and package name/version mismatch.
- Plugin tests verify `onBeforeBuild({ isWatch })` only selects resolution policy and that schema generation still occurs exclusively inside `api.transform`.
- An integration test generates a schema for one allowlisted provider that is not present in workspace `node_modules`.
- Runtime leakage checks continue to reject registry, archive, Babel, TypeBox, generator, and plugin modules from the built runtime graph.

## Non-Goals

- Runtime or on-demand schema generation.
- Installing provider dependencies into the application runtime cache during build.
- Private npm registries, registry authentication, or user-configurable registry mirrors.
- A separate schema catalog package or schema publishing pipeline.
- Reproducible schema output across changes to npm `latest`.
