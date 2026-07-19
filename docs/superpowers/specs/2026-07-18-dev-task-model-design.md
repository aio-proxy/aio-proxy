# Development Task Model Design

## Context

The current root `dev` task mixes four responsibilities in one Turbo graph:

- one-shot package builds;
- long-running library and code-generation watchers;
- the Rsbuild Dashboard development server;
- the CLI-backed API runtime.

The generic `dev -> ^build` dependency causes Turbo to schedule both
`@aio-proxy/core#build` and `@aio-proxy/core#dev`. Both Rslib processes use the
same Rspack persistent cache, which can panic with a state-lock mismatch.

The graph also has incomplete development behavior: plugin packages are built
but not watched, the CLI runtime does not restart when imported files change,
and the CLI serves `dashboard/dist` while a separate Dashboard development
server provides the live frontend.

## Goals

- `bun run dev` starts a complete full-stack development environment.
- The Dashboard uses Rsbuild HMR on a stable development URL.
- Backend, library, plugin, schema, and i18n changes take effect without a
  manual restart.
- One-shot builds never overlap a watcher for the same package.
- Package scripts have one clear responsibility.

## Non-goals

- Changing the production binary or embedded Dashboard behavior.
- Replacing Rslib, Rsbuild, Turbo, or Bun.
- Converting every workspace package to the same export strategy.
- Introducing a new process-management dependency.

## Package interfaces

Packages that use Rslib as their artifact interface expose their root entry
from `dist` and provide both one-shot and watch scripts:

| Package | Root interface | Development producer |
| --- | --- | --- |
| `@aio-proxy/types` | `dist/index.js` and `dist/index.d.ts` | Rslib watch |
| `@aio-proxy/plugin-sdk` | `dist/index.js` and `dist/index.d.ts` | Rslib watch |
| `@aio-proxy/plugin-github-copilot` | `dist/index.js` and `dist/index.d.ts` | Rslib watch |
| `@aio-proxy/plugin-openai-chatgpt` | `dist/index.js` and `dist/index.d.ts` | Rslib watch |
| `@aio-proxy/core` | `dist/index.js` and `dist/index.d.ts` | Rslib watch |

`@aio-proxy/types` also emits `dist/config.schema.json` from its Rslib plugin.
Its root export moves from `src/index.ts` to `dist` so the JavaScript,
declarations, and generated JSON Schema share one artifact lifecycle.

Source-oriented application packages retain their existing interfaces:

- `@aio-proxy/server` and `@aio-proxy/cli` are executed from source by Bun.
- `@aio-proxy/dashboard` is compiled from source by Rsbuild.
- `@aio-proxy/i18n` exports generated source under `src`; its development task
  runs the Paraglide generator in watch mode.

## Task vocabulary

- `build`: produce artifacts once and exit.
- `dev`: run a package-owned compiler, generator, or HMR server continuously.
- `serve:dev`: run an application process continuously for development.
- root `dev:prepare`: create the minimum artifact baseline required before
  persistent tasks start.
- root `dev`: run preparation, then launch all persistent development tasks.

Persistent tasks do not depend on `build`. Readiness is handled once at the
root lifecycle seam rather than repeated throughout the Turbo graph.

## Root lifecycle

The root scripts become:

```json
{
  "dev:prepare": "turbo run build --filter=@aio-proxy/core",
  "dev": "bun run dev:prepare && turbo run dev serve:dev --filter=!@aio-proxy/infra"
}
```

Building `@aio-proxy/core` also builds its transitive workspace dependencies,
including types, plugin SDK, built-in plugins, and i18n. This gives every
artifact-first package a valid initial `dist` before the CLI or Dashboard can
resolve it.

After preparation, Turbo starts these persistent tasks in parallel:

```text
@aio-proxy/types#dev
@aio-proxy/plugin-sdk#dev
@aio-proxy/plugin-github-copilot#dev
@aio-proxy/plugin-openai-chatgpt#dev
@aio-proxy/core#dev
@aio-proxy/i18n#dev
@aio-proxy/dashboard#dev
@aio-proxy/cli#serve:dev
```

Rslib watchers may perform their own initial compilation after preparation.
That duplicate work is accepted because it is sequential, cacheable, and
keeps readiness orchestration simple and deterministic.

## Turbo configuration

The generic persistent tasks have no build dependencies:

```json
{
  "dev": {
    "persistent": true,
    "cache": false,
    "outputs": []
  },
  "serve:dev": {
    "persistent": true,
    "cache": false,
    "outputs": []
  }
}
```

The package-specific `@aio-proxy/cli#dev` sidecar task and the
`@aio-proxy/cli#serve:dev -> ^build` dependency are removed. The root command
names both persistent task kinds directly.

## Backend development runtime

The CLI development runtime uses Bun's hard-restart watch mode:

```json
{
  "serve:dev": "AIO_PROXY_HOME=../../.aio-proxy-dev bun --watch src/main.dev.ts serve"
}
```

Bun tracks imported files and restarts the process when source files or Rslib
outputs change. Hard restart is preferred over `--hot` because the server owns
ports, database handles, watchers, and other process-lifetime state.

`src/main.dev.ts` is a small development adapter over the existing `main(deps)`
seam. It disables static Dashboard assets and supplies the Rsbuild Dashboard
URL. Production and compiled entry points keep their existing embedded or
directory-backed Dashboard adapters.

`CliDeps` gains an optional Dashboard URL resolver. When absent, the current
same-origin `/dashboard` URL remains the default, preserving production and
compiled-entry behavior.

## Dashboard development runtime

Rsbuild remains the only live Dashboard producer. Its development server uses
a stable port:

```ts
server: {
  port: 3000,
  strictPort: true,
  proxy: {
    "/dashboard/api": {
      target: "http://127.0.0.1:22078",
    },
  },
}
```

The development Dashboard URL is
`http://127.0.0.1:3000/dashboard/`. The CLI uses this URL in startup output,
configuration bootstrap messaging, and `--open` behavior. The CLI development
adapter does not require `dashboard/dist`.

## Failure behavior

- If `dev:prepare` fails, `&&` prevents persistent tasks from starting.
- If port 3000 is occupied, Rsbuild fails instead of silently choosing a URL
  that disagrees with CLI output.
- The existing CLI port check continues to fail clearly when port 22078 is
  occupied.
- Bun watch restarts the API process after an imported-file change or crash.
- Turbo reports a persistent task failure rather than hiding it behind another
  package's build task.

## Verification

1. Run a Turbo dry-run and verify that the persistent task graph contains no
   `build` tasks.
2. Run `dev:prepare` from a clean artifact state and verify the required Rslib
   outputs and `types/dist/config.schema.json` are created.
3. Start `bun run dev` and verify the API on port 22078 and Dashboard on port
   3000 become ready.
4. Make a reversible source change in types, plugin SDK, each built-in plugin,
   core, i18n, server, CLI, and Dashboard; verify the corresponding Rslib
   rebuild, code generation, Bun restart, or Rsbuild HMR occurs.
5. Verify no Rspack state-lock panic occurs across repeated starts.
6. Run `bun run preflight`.

If Rsbuild does not observe changed workspace `dist` files automatically,
diagnose its resolved paths and watch set before changing configuration. Do
not add `source.include` or watch overrides preemptively.

## Alternatives rejected

### Make every `dev` depend on its own `build`

This serializes same-package build and watch tasks but leaves build readiness
as a hidden responsibility of every persistent task. It also preserves the
confusing virtual CLI task and unnecessary build graph expansion.

### Use separate Rspack cache directories

This prevents the cache lock panic but leaves duplicate processes writing the
same package outputs. It treats the symptom rather than the task-graph cause.

### Export all workspace packages from source

This could remove some Rslib watchers but changes the artifact interface of
the plugin and core packages and weakens verification of their published-style
outputs. It is a larger migration than the development workflow requires.

### Use `turbo watch build`

This can rerun one-shot builds, but combining it with Rsbuild HMR, Paraglide
watch, and a persistent Bun server requires more task kinds and restart rules
than the explicit two-phase lifecycle.
