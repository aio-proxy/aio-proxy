# Provider Schemas Bun Archive Design

## Goal

Remove the build-only `tar` dependency and the `providerSchemasRequire` module-resolution workaround by making the provider-schema build explicitly Bun 1.3.14+ only.

## Runtime Boundary

`@aio-proxy/provider-schemas` builds only under Bun 1.3.14 or newer. Node compatibility for this build path is not required. Runtime packages and the compiled CLI remain independent of provider-schema build tooling.

## Archive Processing

The source resolver downloads the npm `dist.tarball` with the existing 32 MiB compressed-response limit and verifies `dist.integrity` before opening it with `Bun.Archive`.

The resolver uses `Bun.Archive.files()` rather than `Archive.extract()`. It selects `package/package.json` plus `.d.ts`, `.d.mts`, and `.d.cts` files, then validates the complete selected set before writing anything:

- every path must remain under `package/` and must not be absolute or contain traversal segments;
- at most 65 selected files are accepted, matching one manifest plus the parser's 64-declaration limit;
- every selected entry must have a safe non-negative size;
- selected declaration and manifest bytes must remain within the existing extracted-byte limit;
- directory, link, and unrelated archive entries are never written because only returned file blobs are materialized by application code.

After validation, the resolver strips the `package/` prefix, creates parent directories, and writes each selected file into the existing temporary version root. Manifest validation, completion-manifest hashing, atomic publication, cache validation, and cleanup remain unchanged.

## Module Loading

Delete `provider-schemas-require.ts`. Build modules use standard ESM imports for Bun/Node built-ins, `@babel/parser`, and `typebox`. `Bun.Archive` is referenced directly from the Bun global.

Rslib `api.transform().importModule()` remains the sole schema-generation loader. The existing real-Rslib-transform integration test is the acceptance boundary for removing the custom resolver. No alternate generator command, committed generated source, or test-specific generation path is added.

## Errors and Security

Package-scoped error wrapping remains unchanged. Archive parsing, unsafe selected paths, excessive file count, excessive extracted bytes, invalid package metadata, and integrity mismatch must fail before cache publication. Temporary extraction roots are removed on every failure.

`Bun.Archive.files()` parses the archive before application-level file and byte limits are evaluated and does not expose a per-entry abort callback. The existing 32 MiB compressed download limit remains the outer input bound. This intentionally replaces streaming early abort with validation of the complete `files()` result before any selected file is written.

Current Bun omits directory, symbolic-link, and hard-link entries from `files()`. Tests must verify that these entries are never materialized in the cache. If a future Bun release exposes them as ordinary files, the selected-path and file-set assertions must fail rather than silently writing them.

## Testing

- Add a Bun Archive regression that proves npm `.tgz` input exposes only the intended manifest/declaration files to the writer.
- Preserve failures for traversal paths, more than 65 selected files, and more than four MiB of selected content.
- Verify that symbolic links, hard links, and declaration-shaped directories are omitted and never materialized in the cache.
- Preserve cleanup, package identity, integrity, immutable observation, completion-manifest, and concurrency coverage.
- Run the provider unit suite, live provider integration suite, clean-dist smoke, runtime leakage smoke, real Rslib transform test, and repository preflight.
- Update leakage assertions and package metadata so `tar` and `provider-schemas-require` are absent from build and runtime artifacts.

## Non-Goals

- Supporting provider-schema builds under Node.
- General-purpose archive extraction.
- Changing npm latest resolution, cache publication, Rslib hooks, schema parsing, or runtime provider installation.
