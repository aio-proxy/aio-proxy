# Provider Schema Tarball Cache Design

## Goal

Generate embedded option schemas for the expanded public provider allowlist without declaring every provider package as a workspace dependency. Rslib's transform remains the only schema-generation path, and provider packages and build tooling must not enter the runtime binary.

## Decisions

- The schema source allowlist remains `{ packageName, factoryName }`; it does not pin package versions.
- Every one-shot `rslib build` resolves each package through its npm `latest` dist-tag.
- `rslib --watch` scans cached registry observations newest to oldest and reuses the newest source whose completion manifest and extracted files fully validate. It fetches `latest` only when no usable observation remains.
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

The completion-manifest cache format lives below `packages/provider-schemas/node_modules/.cache/provider-schemas/v2`. It is ignored, build-only state and is not a Turbo output. The format-version directory leaves older cache layouts untouched.

For each allowlisted source:

1. In one-shot build mode, fetch the package's public npm metadata and read `dist-tags.latest`.
2. In watch mode, scan immutable registry-observation records by descending canonical npm `time.modified` revision. Each observation contains `{ revision, version, integrity }`; select the first source that fully validates, falling back past corrupt or missing newer sources before fetching metadata.
3. Look for a complete cache entry keyed by package name and resolved version.
4. On a miss, fetch the exact version metadata, then download its `dist.tarball`.
5. Verify the tarball against npm's `dist.integrity` using Node's crypto implementation before extraction.
6. Extract only `package/package.json` and `*.d.ts`/`*.d.mts`/`*.d.cts` entries into a temporary sibling directory with the build-only `tar` package. Reject absolute paths, traversal paths, archive links, more than 65 extracted files, and compressed responses larger than 32 MiB. Directories do not consume the file limit.
7. Validate the extracted `package.json` name and version against the resolved package and version.
8. Hash every extracted manifest/declaration with SHA-256 and atomically create a completion manifest inside the unpublished version root. It records package name, version, registry tarball integrity, and a sorted exact file list with size and digest.
9. Validate the completion identity, registry integrity, exact file set, sizes, and digests, then atomically rename the temporary directory to its final versioned cache location.
10. Canonicalize npm `time.modified` with `new Date(value).toISOString()` and atomically publish an immutable `{ revision, version, integrity }` observation keyed by that revision. Publishing identical metadata is idempotent; the same revision with a different version or integrity is an inconsistent-registry error.
11. Return the absolute extracted package root to the existing generator.

Concurrent cache misses may race. Atomic version-directory rename is the package-source seam: one writer wins, and another writer discards its temporary directory after validating the completed destination. Corrupt shared version roots are never deleted or repaired in place. Immutable observation publication prevents stale writers from replacing newer observations across processes, and watch mode can fall back to an older fully valid observation without mutating the corrupt source.

One-shot builds fail when registry refresh, download, integrity verification, extraction, or metadata validation fails. Watch builds with a usable cache do not access the registry. Watch builds without a cache fail with the same actionable package-specific error.

## Rslib Integration

`provider-schemas-plugin.ts` keeps its existing `api.transform` target and build-only `importModule()` loader graph. It adds an `onBeforeBuild` callback solely to update a closure containing `isWatch` before compilation.

The generator entry receives the source-resolution mode and cache root from the plugin. Every extracted `package.json` and traversed declaration remains registered through the existing dependency callback, so changes in the cached package source participate in Rspack's module/watch graph.

The root Turbo configuration gives `@aio-proxy/provider-schemas#build` an explicit `cache: false` override while repeating the generic build dependencies, inputs, and outputs because root `package#task` entries replace rather than inherit task configuration. This ensures Turbo does not reuse schema output across changes to npm `latest`.

No explicit `generate` command, standalone writer, committed generated schema artifact, or source freshness comparison is introduced.

## Dependency and Runtime Boundary

Provider packages removed from `@aio-proxy/provider-schemas` devDependencies are no longer installed into the workspace solely for schema extraction. Packages needed elsewhere in the repository remain declared by their actual runtime consumers.

The `tar` archive library is a direct devDependency of `@aio-proxy/provider-schemas`. Registry, archive, parser, TypeBox, generator, and plugin modules remain build-only and must not appear in `packages/provider-schemas/dist` or the CLI binary.

## Testing

- Source resolver unit tests use an in-process HTTP fixture serving npm metadata and tarballs.
- A cache-miss test verifies `latest` resolution, integrity checking, safe extraction, package metadata validation, and the returned package root.
- Cache-hit tests verify completion identity, registry integrity, exact file set, sizes, and SHA-256 digests; corrupt shared cache state is preserved.
- Watch tests verify no registry request occurs with a usable source and that a corrupt newest observation falls back to an older valid source.
- A one-shot build test verifies metadata is checked on every build and a changed `latest` downloads a new version.
- Failure tests cover registry errors, missing dist-tags, integrity mismatch, unsafe archive paths, and package name/version mismatch.
- Plugin tests verify `onBeforeBuild({ isWatch })` only selects resolution policy and that schema generation still occurs exclusively inside `api.transform`.
- Hermetic `test:unit` keeps the independent literal 42-pair catalog and dependency-boundary assertions but uses only local HTTP/package fixtures.
- Explicit `test:integration` performs the live 42-package npm-latest catalog check, clean-dist source-mode setup, and actual provider-dist/CLI runtime leakage scan. It is intentionally outside normal unit/preflight discovery.

A clean `preflight` may perform one latest-refreshing provider build because downstream tests consume `provider-schemas` output from `dist`. The provider unit tests themselves remain hermetic. CI runs `preflight` as the unit graph and must not invoke `test:unit` a second time.

## Non-Goals

- Runtime or on-demand schema generation.
- Installing provider dependencies into the application runtime cache during build.
- Private npm registries, registry authentication, or user-configurable registry mirrors.
- A separate schema catalog package or schema publishing pipeline.
- Reproducible schema output across changes to npm `latest`.
