# Dashboard Artifact Serving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every non-API `GET /dashboard/*` resolve against dashboard build artifacts, so public files such as `favicon.svg` are served the same way as hashed `/dashboard/static/*` files.

**Architecture:** Keep `DashboardAssets` as the only file loader. Collapse the dashboard GET routes onto one handler that strips `/dashboard/`, looks up that key, returns the file when it exists, 404s missing `static/*` keys, and otherwise returns `index.html`. Point the Rsbuild dev server at `server.base: '/dashboard/'` so `public/` matches the same URLs. Leave `/dashboard/api/*` on the existing Hono API router.

**Tech Stack:** TypeScript, Hono, Bun test runner, Rsbuild, existing `directoryDashboardAssets` / `embeddedDashboardAssets`.

**Spec:** [docs/superpowers/specs/2026-08-24-dashboard-artifact-serving-design.md](../specs/2026-08-24-dashboard-artifact-serving-design.md)

## Global Constraints

- User-visible serving contract: non-API `GET /dashboard/*` is dashboard dist, never a favicon-only special case.
- `/dashboard/api` and `/dashboard/api/*` stay the dashboard control plane and must not be answered from artifacts.
- Missing `/dashboard/static/*` stays 404. Do not SPA-fallback hashed URLs.
- `directoryDashboardAssets` already blocks path traversal. Do not copy that logic into the router.
- `bun run dev` keeps `dashboardAssets: () => () => null` in `packages/cli/src/main.dev.ts`. Do not serve dist from the proxy in that mode.
- No new dependencies. No new packages. Do not grow `packages/server/src/server/server.ts` past 500 lines (it is about 450 today).
- Changeset must list product package `aio-proxy` plus every internal package this change actually edits, all at `patch`. If both server and dashboard change, the note targets `@aio-proxy/server`, `@aio-proxy/dashboard`, and `aio-proxy`.
- Do not run `changeset version` or `changeset publish`.
- Workspace is already an isolated git worktree. Do not create another worktree.
- Every commit message must end with `Co-authored-by: Codex <noreply@openai.com>`.
- This worktree may already contain a draft of the favicon catch-all, `server.base`, and `.changeset/serve-dashboard-public-assets.md`. Reconcile that draft to the code blocks below. Do not add a second favicon test. Do not revert unrelated local files.

---

## File map

- `docs/superpowers/specs/2026-08-24-dashboard-artifact-serving-design.md` — URL contract. Already written. Do not rewrite unless a task below finds a contradiction.
- `packages/server/src/server/server.ts` — dashboard GET mount. Replace the split `/dashboard/static/*` plus SPA catch-all with one artifact handler.
- `packages/server/src/dashboard-assets.ts` — loader only (`DashboardAssets`, `directoryDashboardAssets`). Do not edit unless an import path breaks.
- `packages/server/__tests__/dashboard-static.test.ts` — HTTP contract for artifacts vs API vs SPA vs missing hashed files.
- `packages/cli/scripts/generate-compiled-entry.ts` — `listAssetPaths()` already walks the whole dist tree. Do not edit.
- `packages/cli/__tests__/generate-compiled-entry.test.ts` — lock that public root files are in the embed map.
- `packages/dashboard/rsbuild.config.ts` — `server.base: '/dashboard/'` so `public/` is served at `/dashboard/favicon.svg` in `bun run dev`.
- `packages/cli/src/main.dev.ts` — leave `dashboardAssets: () => () => null` and `dashboardUrl: () => 'http://127.0.0.1:3000/dashboard/'`.
- `.changeset/serve-dashboard-public-assets.md` — release note.

---

### Task 1: Proxy serves non-API /dashboard/* from artifacts

**Files:**
- Modify: `packages/server/__tests__/dashboard-static.test.ts`
- Modify: `packages/cli/__tests__/generate-compiled-entry.test.ts`
- Modify: `packages/server/src/server/server.ts` (the `if (dashboardAssets !== undefined)` block only)
- Test: `packages/server/__tests__/dashboard-static.test.ts`
- Test: `packages/cli/__tests__/generate-compiled-entry.test.ts`

**Interfaces:**
- Consumes: `DashboardAssets = (path: string) => Response | null | Promise<Response | null>` from `packages/server/src/dashboard-assets.ts`.
- Consumes: `directoryDashboardAssets(dir: string): DashboardAssets` from the same file. It joins `dir` + `path`, rejects keys that escape `dir`, and returns `new Response(Bun.file(full))` or `null`.
- Consumes: `createServer({ config, dashboardAssets, dbHome })` from `#server-test-lifecycle`.
- Consumes: `loopbackServer` from `packages/server/src/dashboard-auth/test-support.ts`.
- Consumes: `listAssetPaths(distDir: string): string[]` from `packages/cli/scripts/generate-compiled-entry.ts`.
- Produces: `GET /dashboard/<key>` returns the artifact for `key` when `dashboardAssets(key)` is a `Response`.
- Produces: missing `static/...` keys return 404. Other missing GET keys return `index.html`.
- Produces: `static/...` hits set `cache-control` to `public, max-age=31536000, immutable`. Other artifact hits do not set that header.
- Produces: `listAssetPaths` includes root files such as `favicon.svg`.

- [ ] **Step 1: Write the failing tests**

Replace `packages/server/__tests__/dashboard-static.test.ts` with this file. If the favicon test already exists, keep a single copy and add the cache and `listAssetPaths` assertions shown here.

```ts
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { directoryDashboardAssets } from '@aio-proxy/server';

import { createServer } from '#server-test-lifecycle';

import { loopbackServer } from '../src/dashboard-auth/test-support';

const config = { providers: {} } as const;

describe('dashboard static routes', () => {
  test('Given built dashboard assets When dashboard paths are requested Then static app and API are separated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-dashboard-'));
    mkdirSync(join(dir, 'static'));
    writeFileSync(join(dir, 'index.html'), '<div id="root"></div><script src="/dashboard/static/app.js"></script>');
    writeFileSync(join(dir, 'static', 'app.js'), "console.log('dashboard');");
    writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const app = await createServer({ config, dashboardAssets: directoryDashboardAssets(dir), dbHome: dir });

    try {
      const dashboard = await app.request('/dashboard', undefined, loopbackServer);
      const dashboardSlash = await app.request('/dashboard/', undefined, loopbackServer);
      const asset = await app.request('/dashboard/static/app.js', undefined, loopbackServer);
      const missingAsset = await app.request('/dashboard/static/missing.js', undefined, loopbackServer);
      const frontendRoute = await app.request('/dashboard/providers', undefined, loopbackServer);
      const favicon = await app.request('/dashboard/favicon.svg', undefined, loopbackServer);
      const api = await app.request('/dashboard/api/config', undefined, loopbackServer);
      const missingApi = await app.request('/dashboard/api/missing', undefined, loopbackServer);
      const retiredLogsApi = await app.request(['', 'dashboard', 'api', 'logs'].join('/'), undefined, loopbackServer);
      const oldApi = await app.request('/dashboard/config', undefined, loopbackServer);

      expect(dashboard.status).toBe(200);
      expect(await dashboard.text()).toContain('/dashboard/static/app.js');
      expect(dashboardSlash.status).toBe(200);
      expect(await dashboardSlash.text()).toContain('root');
      expect(asset.status).toBe(200);
      expect(await asset.text()).toContain('dashboard');
      expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(missingAsset.status).toBe(404);
      expect(frontendRoute.status).toBe(200);
      expect(await frontendRoute.text()).toContain('root');
      expect(favicon.status).toBe(200);
      expect(await favicon.text()).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      expect(favicon.headers.get('cache-control')).not.toBe('public, max-age=31536000, immutable');
      expect(api.status).toBe(200);
      expect(await api.json()).toMatchObject({ providers: expect.any(Array) });
      expect(missingApi.status).toBe(404);
      expect(retiredLogsApi.status).toBe(404);
      expect(oldApi.status).toBe(200);
      expect(await oldApi.text()).toContain('root');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

In `packages/cli/__tests__/generate-compiled-entry.test.ts`, change only the `listAssetPaths` fixture so it also writes a root public file:

```ts
    mkdirSync(join(dir, 'static', 'js'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), 'x');
    writeFileSync(join(dir, 'favicon.svg'), 'x');
    writeFileSync(join(dir, 'static', 'js', 'app.js'), 'x');
    try {
      expect(listAssetPaths(dir)).toEqual(['favicon.svg', 'index.html', 'static/js/app.js']);
```

Leave the `renderCompiledEntry` and `virtualCompiledEntry` tests unchanged.

- [ ] **Step 2: Run the new cases and confirm they fail**

Run:

```bash
bun test packages/server/__tests__/dashboard-static.test.ts packages/cli/__tests__/generate-compiled-entry.test.ts
```

Expected on a clean `main` (no artifact catch-all yet):

- `GET /dashboard/favicon.svg` returns the `index.html` body, so `toBe('<svg ...>')` fails.

Expected for `listAssetPaths` on clean `main`: FAIL with received `['index.html', 'static/js/app.js']`.

If this worktree already serves the SVG, the favicon body assertion will pass. The cache assertion still fails if `/dashboard/favicon.svg` is going through the hashed `static/*` handler. The `listAssetPaths` assertion still fails until that fixture is updated. Do not skip ahead until you have watched at least one new assertion fail for the right reason.

- [ ] **Step 3: Implement the single artifact GET handler**

In `packages/server/src/server/server.ts`, replace only the `if (dashboardAssets !== undefined) { ... }` block with:

```ts
  if (dashboardAssets !== undefined) {
    const serveDashboardArtifact = async (context: Context) => {
      const assetKey =
        context.req.path === '/dashboard' || context.req.path === '/dashboard/'
          ? 'index.html'
          : context.req.path.replace(/^\/dashboard\//u, '');
      const asset = await dashboardAssets(assetKey);
      if (asset !== null && asset !== undefined) {
        if (assetKey.startsWith('static/')) {
          asset.headers.set('cache-control', 'public, max-age=31536000, immutable');
        }
        return asset;
      }
      if (assetKey.startsWith('static/')) return context.notFound();
      const index = await dashboardAssets('index.html');
      return index ?? context.notFound();
    };
    routes
      .get('/dashboard', serveDashboardArtifact)
      .get('/dashboard/', serveDashboardArtifact)
      .get('/dashboard/*', serveDashboardArtifact)
      .all('/dashboard/static/*', (context) => context.notFound())
      .all('/dashboard/api', (context) => context.notFound())
      .all('/dashboard/api/*', (context) => context.notFound());
  }
```

Do not edit `createDashboardRoutes`, auth middleware, or `packages/server/src/dashboard-assets.ts`.

Do not edit `packages/cli/scripts/generate-compiled-entry.ts`. `listAssetPaths` already returns every file; only the test fixture was incomplete.

- [ ] **Step 4: Run the tests and confirm they pass**

Run:

```bash
bun test packages/server/__tests__/dashboard-static.test.ts packages/cli/__tests__/generate-compiled-entry.test.ts
```

Expected: all tests in those two files PASS. `GET /dashboard/favicon.svg` is the SVG. `GET /dashboard/static/missing.js` is 404. `GET /dashboard/providers` is `index.html`. `GET /dashboard/api/config` is JSON.

- [ ] **Step 5: Commit**

```bash
git add packages/server/__tests__/dashboard-static.test.ts packages/server/src/server/server.ts packages/cli/__tests__/generate-compiled-entry.test.ts
git commit -m "fix(dashboard): serve public artifacts under /dashboard

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Dev public files use the same /dashboard/ prefix

**Files:**
- Modify: `packages/dashboard/rsbuild.config.ts`
- Create: `.changeset/serve-dashboard-public-assets.md`

**Interfaces:**
- Consumes: the Task 1 URL contract. Dev and production must use the same `/dashboard/favicon.svg` href.
- Consumes: existing `output.assetPrefix: '/dashboard/'`. Keep it. Explicit `assetPrefix` must not inherit a doubled `/dashboard/dashboard/` prefix when `server.base` is set.
- Produces: Rsbuild `server.base` is `'/dashboard/'`, so `packages/dashboard/public/favicon.svg` is served at `http://127.0.0.1:3000/dashboard/favicon.svg`.
- Produces: `packages/cli/src/main.dev.ts` still uses `dashboardAssets: () => () => null` and `dashboardUrl: () => 'http://127.0.0.1:3000/dashboard/'`.

- [ ] **Step 1: Confirm the Task 1 HTTP contract still passes**

Do not add an rstest that imports `rsbuild.config.ts`. Dashboard tests run in happy-dom through `@rstest/adapter-rsbuild`; loading the bundler config from that suite would boot the whole frontend toolchain.

`server.base` is a config file. The product behavior it exists for is already locked by Task 1: HTML and the proxy both use `/dashboard/favicon.svg`.

Run:

```bash
bun test packages/server/__tests__/dashboard-static.test.ts
```

Expected: PASS from Task 1. If it fails, stop and fix Task 1. Do not edit Rsbuild yet.

- [ ] **Step 2: Set the dev base path**

In `packages/dashboard/rsbuild.config.ts`, keep `output.assetPrefix: '/dashboard/'` and set `server.base` inside the existing `server` object:

```ts
  output: {
    assetPrefix: '/dashboard/',
  },
  html: {
    title: 'AIO Proxy Dashboard',
  },
  server: {
    base: '/dashboard/',
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
    proxy: {
      '/dashboard/api': {
        target: apiUrl,
        on: {
          proxyReq: (proxyReq) => {
            proxyReq.setHeader('Origin', apiUrl);
          },
        },
      },
    },
  },
```

Do not change `packages/cli/src/main.dev.ts`.

Create `.changeset/serve-dashboard-public-assets.md` (overwrite the draft if it already exists) with:

```md
---
'@aio-proxy/server': patch
'@aio-proxy/dashboard': patch
'aio-proxy': patch
---

Serve dashboard public files such as `/dashboard/favicon.svg` from the built assets instead of the SPA fallback.
```

- [ ] **Step 3: Re-run the artifact tests after the config edit**

Run:

```bash
bun test packages/server/__tests__/dashboard-static.test.ts packages/cli/__tests__/generate-compiled-entry.test.ts
```

Expected: PASS. The Rsbuild edit does not change those tests; this is the regression check after touching the dashboard package.

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/rsbuild.config.ts .changeset/serve-dashboard-public-assets.md
git commit -m "fix(dashboard): serve public files under /dashboard in dev

Co-authored-by: Codex <noreply@openai.com>"
```

---

## Self-review

**Spec coverage**

- Non-API `GET /dashboard/*` to artifacts: Task 1 handler.
- Public `favicon.svg`: Task 1 HTTP assertion.
- Missing `static/*` stays 404: Task 1 `missingAsset`.
- SPA fallback for `/dashboard/providers`: Task 1 `frontendRoute`.
- `/dashboard/api/*` stays API: Task 1 `api` / `missingApi` / `retiredLogsApi`.
- Immutable cache only on `static/*`: Task 1 cache assertions.
- Embed map includes public root files: Task 1 `listAssetPaths`.
- Dev `server.base`: Task 2 config edit. No separate rstest; public URL is covered by Task 1.
- `bun run dev` does not serve dist from the proxy: Task 2 leaves `main.dev.ts` alone.

**Placeholder scan**

- No TBD/TODO. Test bodies, handler, Rsbuild snippet, and changeset text are inlined.

**Type consistency**

- Asset keys are strings relative to dist (`index.html`, `favicon.svg`, `static/js/app.js`).
- `DashboardAssets` still returns `Response | null | Promise<Response | null>`.
- Cache header value is exactly `public, max-age=31536000, immutable`.
