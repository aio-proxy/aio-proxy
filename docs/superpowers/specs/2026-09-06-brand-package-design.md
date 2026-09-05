# Brand Package Design

Date: 2026-09-06

## Problem

Brand artwork is duplicated and drifting across the repository.

- `packages/ui/src/components/aio-proxy-logo.tsx` renders the wordmark as inline SVG whose
  `Proxy` half is a live `<text>` element. It depends on the Lexend webfont having loaded, so
  the mark reflows or falls back to a different typeface before fonts settle, and it cannot be
  rasterized outside the app.
- The file also sits in a directory whose `AGENTS.md` states the contents are managed by the
  shadcn CLI and must not be hand-edited. A single `shadcn add --overwrite` can delete it.
- `packages/dashboard/public/favicon.svg` and `website/docs/public/favicon.svg` are byte-identical
  copies maintained independently.
- The favicon's dark variant fills with `oklch(1 0 0)` (`#ffffff`) while the wordmark uses
  `oklch(98.8% 0.003 106.5)` (`#fbfbf9`). Two different whites for one brand.
- Nothing serves the wordmark as a static file, so the READMEs cannot render it.

The favicon is not a separate icon. Its three subpaths are the same AIO letterform combination as
the wordmark's, translated by `(+12, +120)` into a 720x720 square. The geometry was already
unified; only its distribution was not.

## Goals

- One committed source per mark, with every other artifact generated from it.
- Static colored SVGs that jsDelivr can serve to both READMEs.
- A React component that no longer depends on webfont loading.
- Brand assets out of the shadcn-managed directory.
- One favicon, consumed by both the dashboard and the website without copies.

## Non-Goals

- Redrawing the letterforms. The geometry ships as authored.
- Publishing the brand package to npm. It stays `private`.
- Adding raster (PNG/ICO) outputs. No consumer needs them today.

## Package Layout

New private workspace package `@aio-proxy/brand` at `packages/brand`.

```
packages/brand/
├── package.json
├── tsconfig.json
├── scripts/
│   └── build-assets.ts
└── src/
    ├── aio-proxy-wordmark.svg          hand-authored source, fill="currentColor"
    ├── aio-proxy-wordmark-light.svg    generated, committed
    ├── aio-proxy-wordmark-dark.svg     generated, committed
    ├── aio-proxy-mark.svg              hand-authored source, fill="currentColor"
    ├── aio-proxy-mark-favicon.svg      generated, committed
    ├── logo-geometry.ts                generated, committed
    ├── aio-proxy-logo.tsx              hand-authored
    └── index.ts                        exports only
```

Wordmark and mark are two parallel sources, not one derived from the other. They are the same
letterforms in different arrangements (different viewBox, different padding), and deriving one
from the other would encode a translation offset that only holds until either is redrawn.

The two sources are seeded from existing files, with their baked colors replaced by
`fill="currentColor"`:

- `aio-proxy-wordmark.svg` from `packages/dashboard/public/logo-light.svg`
  (`viewBox="0 0 1920 480"`, one path).
- `aio-proxy-mark.svg` from `packages/dashboard/public/favicon.svg`
  (`viewBox="0 0 720 720"`, one path), dropping its `<style>` block and `id="a"` — the generated
  favicon re-adds the media query.

Path data is copied verbatim in both cases.

`package.json`:

```json
{
  "name": "@aio-proxy/brand",
  "version": "0.19.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./assets/*": "./src/*"
  },
  "scripts": {
    "build:assets": "bun scripts/build-assets.ts"
  },
  "dependencies": {
    "cn": "catalog:"
  },
  "peerDependencies": {
    "react": "^19.2.8"
  }
}
```

The `./assets/*` subpath lets build configs resolve raw SVG files without reaching into `src/`
by relative path.

## Generation

`scripts/build-assets.ts` reads both sources, extracts `viewBox` and each path's `d`, and emits:

| Output | From | Fill |
| --- | --- | --- |
| `aio-proxy-wordmark-light.svg` | wordmark source | `#0c0c09` |
| `aio-proxy-wordmark-dark.svg` | wordmark source | `#fbfbf9` |
| `aio-proxy-mark-favicon.svg` | mark source | `#0c0c09`, `#fbfbf9` under `@media (prefers-color-scheme: dark)` |
| `logo-geometry.ts` | both sources | n/a |

`logo-geometry.ts` is listed in `oxc.ts` `ignorePatterns`, so neither oxfmt nor oxlint touches it.
The generator therefore does not shell out to a formatter; it emits its own final formatting, and
that output must be byte-stable across runs for the clean-tree assertion to mean anything.
Running `oxfmt` on the file would in fact exit 2 (`Expected at least one target file. All matched
files may have been excluded by ignore rules.`).

### Colors

The two source colors are Tailwind v4's `--color-olive-950` and `--color-olive-50`, which are
exactly the dashboard theme's `--foreground` in light and dark mode. Generated files bake them to
hex:

- `oklch(15.3% 0.006 107.1)` -> `#0c0c09`
- `oklch(98.8% 0.003 106.5)` -> `#fbfbf9`

Hex rather than oklch because these are outward-facing assets and resvg, librsvg, Inkscape, and
various SVG-to-PNG converters have uneven oklch support; a degraded parse renders black or not at
all. Tailwind CSS, Vite, and oxc all ship hex in their README logos.

This also settles the favicon's `oklch(1 0 0)` to `#fbfbf9`, giving the brand one white.

### Naming

Generated wordmark files are named for the color scheme they are shown *in*, not for the ink they
contain: `-dark` pairs with `media="(prefers-color-scheme: dark)"` and holds light ink. This
matches Tailwind CSS, Vite, tRPC, and TanStack Query, and inverts the current
`packages/dashboard/public/logo-{light,dark}.svg` naming, which reads backwards at every call site.

### Why not `build`

Turborepo's `build` task declares `outputs: ["dist/**"]`, but these artifacts must be committed —
`dist` is gitignored and jsDelivr cannot serve uncommitted files. Registering the generator as
`build` would let a cache hit skip generation, making the clean-tree assertion vacuous.

`@aio-proxy/core` already solves this the same way: its `build:migrations` script writes to the
committed `src/db/migrations/` and is deliberately not the `build` task. `build:assets` follows
that precedent and is not registered in `turbo.json`.

## Verification

No unit tests. The contract worth guarding is "generated artifacts match their source", and the
repository already has a mechanism for exactly that.

CI (`.github/workflows/ci.yml`), mirroring the existing migrations check:

```yaml
- run: bun run --filter @aio-proxy/brand build:assets
- run: test -z "$(git status --short --untracked-files=all -- packages/brand/src)"
```

`lefthook.yml` pre-commit:

```yaml
brand-assets:
  glob: 'packages/brand/src/*.svg'
  run: bun run --filter @aio-proxy/brand build:assets
  stage_fixed: true
```

The glob covers generated SVGs as well as sources. Regeneration is idempotent, so a commit
touching only generated files simply reproduces them — cheaper than depending on lefthook's brace
expansion to single out the two sources.

Asserting on path strings in a unit test would only restate implementation literals, which
`CLAUDE.md` rules out.

## Component

`src/aio-proxy-logo.tsx` is hand-authored JSX reading `viewBox` and path data from
`logo-geometry.ts`. It keeps `fill="currentColor"`, `role="img"`, `aria-label`, and `<title>`.

Two removals from the current implementation:

- The `<text>Proxy</text>` element. The wordmark source is fully outlined, so the component no
  longer depends on whether Lexend has loaded. This is the substantive win of the replacement.
- The `children` passthrough. Neither consumer uses it.

The component merges `className` with `cn` from the `cn` package (the same tailwind-merge
implementation `packages/ui` re-exports from `src/lib/utils.ts`), depending on it directly rather
than importing through `@aio-proxy/ui`.

Plain string concatenation would be wrong here. The default class list contains `text-lg`, and
`login-page.tsx:41` renders `<AioProxyBrand className="text-2xl" />`; concatenation emits both
classes and lets CSS source order pick the winner, whereas `cn` resolves the conflict:

```
cn('h-[1.333em] w-auto shrink-0 text-lg text-foreground', 'text-2xl')
  -> 'h-[1.333em] w-auto shrink-0 text-foreground text-2xl'
```

## Consumers

| Change | File |
| --- | --- |
| Import from `@aio-proxy/brand` | `packages/dashboard/src/components/aio-proxy-brand.tsx:2` |
| Import from `@aio-proxy/brand` | `website/theme/components/nav-title/index.tsx:1` |
| Add `"@aio-proxy/brand": "workspace:*"` | `packages/dashboard/package.json`, `website/package.json` |
| Delete | `packages/ui/src/components/aio-proxy-logo.tsx` |
| Delete | `packages/dashboard/public/logo-light.svg`, `logo-dark.svg` |

Deleting the component from `packages/ui/src/components/` also resolves its standing violation of
that directory's `AGENTS.md`.

### Favicon distribution

Both `packages/dashboard/public/favicon.svg` and `website/docs/public/favicon.svg` are deleted.
Each build points at the generated favicon in the brand package instead.

Neither surface currently configures a favicon: rsbuild auto-detects `public/favicon.svg` and
injects `<link rel="icon">` on its own. Deleting the file therefore removes the tag, so each
surface must now name the file explicitly. `output.copy` is the wrong primitive here — it would
place the asset in `dist` but emit no `<link>` tag. The correct option is `html.favicon`, which
both copies the file and injects the tag, and which accepts an absolute filesystem path.

`packages/dashboard/rsbuild.config.ts`:

```ts
import { fileURLToPath } from 'node:url';

const favicon = fileURLToPath(import.meta.resolve('@aio-proxy/brand/assets/aio-proxy-mark-favicon.svg'));

// ...
html: {
  title: 'AIO Proxy Dashboard',
  favicon,
},
```

`import.meta.resolve` rather than `require.resolve`: the config is ESM under `"type": "module"`,
where `require` is not defined.

`website/rspress.config.ts` keeps its top-level `icon` field, changing the value from
`'/favicon.svg'` to the resolved `file://` URL. Rspress normalizes `icon` into rsbuild's
`html.favicon`, converting a `file://` URL via `fileURLToPath` and otherwise treating an absolute
path as relative to `docs/public` — so the URL form is required for a path outside the doc root
(`@rspress/core/dist/node/initRsbuild.js:49-55`):

```ts
icon: import.meta.resolve('@aio-proxy/brand/assets/aio-proxy-mark-favicon.svg'),
```

`import.meta.resolve` returns a `file://` URL string, which is exactly the form rspress handles.

## READMEs

`README.md` and `README.zh-Hans.md` replace the `# AIO Proxy` heading with:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://fastly.jsdelivr.net/gh/aio-proxy/aio-proxy@main/packages/brand/src/aio-proxy-wordmark-dark.svg">
  <img alt="AIO Proxy" src="https://fastly.jsdelivr.net/gh/aio-proxy/aio-proxy@main/packages/brand/src/aio-proxy-wordmark-light.svg" width="360">
</picture>
```

`<picture>` with `prefers-color-scheme` is GitHub's documented mechanism and what Vite, Tailwind
CSS, oxc, tRPC, and TanStack Query all use. An SVG-internal `@media` block was considered and
rejected: no surveyed project uses it for a README, and its behavior through GitHub's camo image
proxy is unverified. The favicon keeps its internal `@media` because browsers render a favicon as
an SVG document, where the query is reliable.

`@main` rather than a pinned tag, so the URL never needs updating. jsDelivr caches mutable refs
for 7 days; acceptable for artwork that rarely changes.

Dropping the `h1` follows Vite and Tailwind CSS — the wordmark already spells the name. The root
READMEs are not published to npm (`npm/aio-proxy/package.json` ships only `bin` and
`config.schema.json`), so registry markdown rendering is not a constraint.

## Repository Wiring

- `oxc.ts` `ignorePatterns`: add `packages/brand/src/logo-geometry.ts`, alongside the existing
  `route-tree.gen.ts` and `migrations.manifest.ts` entries.
- Root `tsconfig.json` `references`: add `./packages/brand`.
- Root `package.json` `workspaces.catalog`: add `"cn": "^0.2.5"`, and change
  `packages/ui/package.json` to `"cn": "catalog:"`. `CLAUDE.md` requires catalog management once a
  dependency has two or more workspace consumers, which adding the brand package makes true.
- Root `package.json` `workspaces.packages` already covers `packages/*`; no change needed.

## Changesets

None. Per `CLAUDE.md`, a changeset must target `aio-proxy` or `@aio-proxy/plugin-sdk` to reach a
published Release. This change is internal refactoring with no user-visible behavior difference —
a Release note reading "restructured logo assets" would be noise.

## Risks

- **jsDelivr plus camo double-caching.** A logo change may take up to 7 days to appear in the
  READMEs. Acceptable for artwork; if urgent, purge via jsDelivr's cache endpoint.
- **`html.favicon` at two build sites.** If a third surface later needs the favicon, it must add
  its own config. The alternative — committing copies into each `public/` — was rejected because
  it reintroduces exactly the duplication this change removes.
- **Favicon regression is silent.** Both surfaces lose rsbuild's public-directory auto-detection,
  and a wrong path yields a missing `<link rel="icon">` rather than a build error. Each build must
  be run once and its emitted HTML checked for the tag.

## Out of Scope

The two sources remain hand-authored SVG. If the letterforms are ever redrawn, both files must be
regenerated from the design tool; nothing in this design keeps them consistent with each other.
That is intentional — they are independent arrangements, and a check asserting a fixed translation
offset would break the moment the padding is intentionally adjusted.
