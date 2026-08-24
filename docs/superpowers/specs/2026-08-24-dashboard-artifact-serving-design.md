# Dashboard Artifact Serving

## Goal

Every non-API `GET /dashboard/*` request is answered from the dashboard build output (`packages/dashboard/dist` in directory mode, the same file map when embedded). Public files such as `favicon.svg` use the same lookup as hashed `/dashboard/static/*` files.

## Background

Rsbuild emits:

- `dist/index.html` with `<link rel="icon" href="/dashboard/favicon.svg">`
- `dist/favicon.svg` copied from `packages/dashboard/public/favicon.svg`
- hashed JS/CSS under `dist/static/`

The proxy used to treat only `/dashboard/static/*` as files. `/dashboard/favicon.svg` fell through to the SPA handler and returned `index.html`. `bun run dev` served public files at `/favicon.svg` because `server.base` defaulted to `/`, so the same href was a real 404 on port 3000.

`DashboardAssets` already accepts any relative path. `listAssetPaths()` already walks the whole dist tree. The gap is the HTTP mapping, not the file loaders.

## URL contract

Strip the `/dashboard/` prefix (or map `/dashboard` and `/dashboard/` to `index.html`). Look that key up in dashboard assets.

| Request | Asset key | If present | If missing |
|---|---|---|---|
| `GET /dashboard` | `index.html` | that file | 404 |
| `GET /dashboard/` | `index.html` | that file | 404 |
| `GET /dashboard/favicon.svg` | `favicon.svg` | that file | `index.html` |
| `GET /dashboard/static/js/app.js` | `static/js/app.js` | that file, immutable cache | 404 |
| `GET /dashboard/providers` | `providers` | that file | `index.html` |
| `GET /dashboard/api/config` | n/a | dashboard API | dashboard API |
| `GET /dashboard/api/missing` | n/a | 404 from API router | 404 from API router |

Rules:

1. `/dashboard/api` and `/dashboard/api/*` are never artifacts.
2. A missing key under `static/` is 404. Hashed URLs must not SPA-fallback.
3. Any other missing GET key returns `index.html` so TanStack routes keep working.
4. `static/*` hits set `cache-control: public, max-age=31536000, immutable`.
5. Other artifact hits do not set that header.
6. `directoryDashboardAssets` keeps its existing path-traversal guard. Do not reimplement it in the router.

## Runtime modes

- `aio-proxy run` / compiled binary: `directoryDashboardAssets(dist)` or `embeddedDashboardAssets(files)`. Both use the same asset keys.
- `bun run dev`: CLI `dashboardAssets` stays `() => null`. The browser uses `http://127.0.0.1:3000/dashboard/`. Rsbuild must set `server.base: '/dashboard/'` so `public/` files are served at `/dashboard/favicon.svg`. The API proxy stays `/dashboard/api` → the proxy port.

## Non-goals

- Serving dist from the proxy during `bun run dev` (that would kill HMR).
- Moving `favicon.svg` into `dist/static/` as a workaround.
- History-fallback for missing hashed `/dashboard/static/*` files.
- Changing dashboard auth, loopback, or `/dashboard/api/*` handlers.
- New asset pipeline, CDN prefix, or extra cache policy beyond the `static/` immutable header.

## Verification

- `GET /dashboard/favicon.svg` returns the SVG bytes, not `index.html`.
- `GET /dashboard/static/missing.js` stays 404.
- `GET /dashboard/providers` still returns `index.html`.
- `GET /dashboard/api/config` still returns JSON.
- `listAssetPaths` includes root public files such as `favicon.svg`.
- Dev `server.base` is `/dashboard/`.
