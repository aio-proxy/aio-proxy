# Task 5 Report: Remove import-time server state and order logging boot

## Status

Implemented. The server package is now factory-only, CLI logging configuration finishes before server state creation begins, and focused regression coverage is green. The server suite passes; the CLI suite has one reproducible, unrelated pre-existing plugin fixture failure described below.

## Changes

### Server initialization

- Removed the top-level `createServerState`/`createRoutes` call from `packages/server/src/server.ts`.
- Removed the eager `app`, `bunServer`, and default exports. Repository dependents were searched; the only value dependent was the server configuration test, which was updated to use the supported `createServer` factory contract.
- Defined `AppType` without executing initialization: `ReturnType<typeof createRoutes>`.
- Kept `createServer` as the production entrypoint and retained `serverDefaults`.
- Added a subprocess regression test proving that importing `src/server.ts` creates no files in `AIO_PROXY_HOME`.

### CLI boot ordering

- Added `@aio-proxy/logger` as a CLI workspace dependency and updated `bun.lock`.
- Added `bootProxyServer`, which:
  1. parses the raw config for logging settings;
  2. resolves the default log directory to `join(aioHome(), "logs")`;
  3. awaits `configureLogging` completely;
  4. only then invokes `createServer`.
- Kept the raw config passed to `createServer`, preserving its existing parsing contract and avoiding a parsed-provider-array double-parse.
- Wired `serve` through this helper before calling `Bun.serve`.

## TDD evidence

### Red

The boot-order test was created before the helper implementation:

```text
bun test ./_test/logging-boot-order.test.ts
SyntaxError: Export named 'bootProxyServer' not found in module '.../packages/cli/src/main.ts'.
0 pass / exit 1
```

### Green

After implementation:

```text
bun test --preload=./_test/setup.ts ./_test/logging-boot-order.test.ts
1 pass, 0 fail, 2 expect() calls
```

The test records `configure:start`, awaits an asynchronous boundary, records `configure:end`, and asserts `createServer` occurs afterward. It also verifies the fully resolved logging configuration, including the default home-relative log directory.

The import-side-effect regression and affected server configuration tests also pass:

```text
bun test --preload=./packages/server/_test/setup.ts   packages/server/_test/server-import.test.ts   packages/server/_test/server-config.test.ts
7 pass, 0 fail, 17 expect() calls
```

## Verification

- `packages/server: bun run test:unit` — pass (exit 0).
- `packages/cli: bun run test:unit` — 159 pass, 1 unrelated failure.
- Focused Task 5 tests — 8 pass, 0 fail total.
- Changed-file `oxlint` — pass.
- `git diff --check` — pass.
- `packages/dashboard: bun run build` — pass, validating the `AppType` consumer against the type-only export.

### Unrelated repository issues observed

The full CLI suite has one reproducible failure in `src/plugin-commands/plugin/remove.test.ts`. Its generated plugin fixture declares `apiVersion: 1`, while current plugin validation reports that version as incompatible; the assertion expects the fixture to be listed as configured. This test and plugin behavior are outside Task 5.

Standalone package TypeScript checks are also blocked by existing configuration/type issues unrelated to this change:

- CLI: `Bun.SpawnSyncReturns` is absent from the installed Bun type namespace in `_test/cli-test-helpers.ts`.
- Server: test pipeline helper files are included outside the configured `rootDir` (`src`).

## Files changed

- `bun.lock`
- `packages/cli/package.json`
- `packages/cli/src/main.ts`
- `packages/cli/_test/logging-boot-order.test.ts`
- `packages/server/src/server.ts`
- `packages/server/src/index.ts`
- `packages/server/_test/server-config.test.ts`
- `packages/server/_test/server-import.test.ts`
