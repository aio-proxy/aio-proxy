# zod-compiler Integration Design

## Goal

Compile Zod validators in the two shipped application artifacts without changing
schemas or adding runtime compilation to the proxy server.

## Scope

- Dashboard builds use `zod-compiler/rsbuild` and automatically process only
  `packages/dashboard/src/**`.
- CLI binary builds use `zod-compiler/bun` through the existing `Bun.build()`
  call. Workspace packages bundled into the executable are eligible too.
- `bun src/main.ts` and `bun --watch src/main.dev.ts` remain plain Zod. The Bun
  plugin does not run for direct source execution, and no JIT compiler is added.

## Changes

1. Add `zod-compiler` to the root workspace catalog and declare it as a build
   dependency of `@aio-proxy/dashboard` and `@aio-proxy/cli`.
2. Add the Rsbuild plugin to `packages/dashboard/rsbuild.config.ts`, scoped to
   the Dashboard source directory.
3. Add the Bun plugin to the `Bun.build()` options in
   `packages/cli/scripts/build-binary.ts`.

No Zod schema source changes, application startup changes, or JIT imports are
in scope.

## Verification

- The Dashboard build succeeds with the Rsbuild plugin enabled.
- The host-platform CLI binary builds and its existing smoke test runs outside
  the workspace.
- `bun run check` remains clean apart from existing warnings.

## Risks

Automatic compilation evaluates schema modules during build. Scoping the
Dashboard plugin to its `src` directory limits that discovery; the CLI plugin
only runs during explicit binary builds. Direct execution stays on Zod's native
runtime path if a module cannot be compiled.
