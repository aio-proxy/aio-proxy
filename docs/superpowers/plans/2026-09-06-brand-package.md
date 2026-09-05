# Brand Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all AIO Proxy brand artwork into one private `@aio-proxy/brand` package where a single committed source per mark generates every other artifact — colored SVGs for the READMEs, a favicon for both build surfaces, and geometry for the React component.

**Architecture:** Two hand-authored `currentColor` SVGs (`aio-proxy-wordmark.svg`, `aio-proxy-mark.svg`) are the only sources. A Bun script reads them and emits four committed artifacts: two hex-colored wordmarks for jsDelivr, one favicon with an internal `@media` query, and a `logo-geometry.ts` the React component imports. A CI git-clean assertion is the only test — it proves generated artifacts still match their sources. No turbo `build` task, because `dist` is gitignored and these artifacts must be committed.

**Tech Stack:** Bun 1.4.2, TypeScript, React 19, Tailwind CSS v4, rsbuild 2.x (dashboard), rspress 2.0.19 (website), Turborepo, oxlint/oxfmt, lefthook.

## Global Constraints

- The spec for this work is `docs/superpowers/specs/2026-09-06-brand-package-design.md`. Read it before starting.
- Path geometry ships **as authored**. Never retype, reformat, round, or "optimize" a `d` attribute — always copy it programmatically from the file that already holds it.
- The two brand colors, and no others: `#0c0c09` (dark ink, shown on light backgrounds) and `#fbfbf9` (light ink, shown on dark backgrounds). Generated artifacts use hex, never `oklch()`.
- Generated wordmark files are named for the color scheme they are **shown in**, not the ink they contain. `-dark` holds light ink and pairs with `media="(prefers-color-scheme: dark)"`.
- `packages/brand/src/logo-geometry.ts` is listed in `oxc.ts` `ignorePatterns`. Never run `oxfmt` or `oxlint` on it — oxfmt exits 2 on ignored files. The generator emits its own final formatting, which must be byte-stable across runs.
- `build:assets` must NOT be registered in `turbo.json`. A cache hit would skip generation and make the clean-tree assertion vacuous.
- No changeset. This is internal refactoring with no user-visible behavior change; per `CLAUDE.md` a changeset must target `aio-proxy` or `@aio-proxy/plugin-sdk` to reach a published Release.
- Nothing in this plan may edit files under `packages/ui/src/components/` other than to **delete** `aio-proxy-logo.tsx`. That directory is shadcn-managed per its `AGENTS.md`.
- Two regressions in this change are **silent** — the build succeeds and the artifact is simply missing. Both must be verified by grepping build output, never by assuming:
  1. Favicon: emitted HTML must contain `<link rel="icon" ...>`.
  2. Tailwind: emitted CSS must contain the brand component's utility classes.
- Run all commands from the repository root: `/Volumes/ExternalSSD/workspace/aio-proxy/.claude/worktrees/ecstatic-wilbur-1c3913`.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `packages/brand/package.json` | Package manifest; declares `build:assets` and the `./assets/*` export |
| `packages/brand/tsconfig.json` | TS project config, mirrors `packages/ui/tsconfig.json` |
| `packages/brand/scripts/build-assets.ts` | Reads both sources, emits all four artifacts |
| `packages/brand/src/aio-proxy-wordmark.svg` | Hand-authored source, `fill="currentColor"` |
| `packages/brand/src/aio-proxy-mark.svg` | Hand-authored source, `fill="currentColor"` |
| `packages/brand/src/aio-proxy-wordmark-light.svg` | Generated, committed, `#0c0c09` |
| `packages/brand/src/aio-proxy-wordmark-dark.svg` | Generated, committed, `#fbfbf9` |
| `packages/brand/src/aio-proxy-mark-favicon.svg` | Generated, committed, `@media` dark |
| `packages/brand/src/logo-geometry.ts` | Generated, committed, viewBox + path constants |
| `packages/brand/src/aio-proxy-logo.tsx` | Hand-authored React component |
| `packages/brand/src/index.ts` | Exports only |

**Modified:** `oxc.ts`, root `tsconfig.json`, root `package.json`, `packages/ui/package.json`, `packages/ui/src/styles.css`, `packages/dashboard/package.json`, `packages/dashboard/rsbuild.config.ts`, `packages/dashboard/src/components/aio-proxy-brand.tsx`, `website/package.json`, `website/rspress.config.ts`, `website/theme/components/nav-title/index.tsx`, `README.md`, `README.zh-Hans.md`, `.github/workflows/ci.yml`, `lefthook.yml`.

**Deleted:** `packages/ui/src/components/aio-proxy-logo.tsx`, `packages/dashboard/public/favicon.svg`, `website/docs/public/favicon.svg`. (`packages/dashboard/public/logo-light.svg` and `logo-dark.svg` are untracked in the main checkout and absent from this worktree — nothing to delete here.)

## Task Ordering

1. **Task 1** — Scaffold the package, author both sources, write the generator, wire the repo.
2. **Task 2** — The React component; migrate both consumers; delete the old one; verify Tailwind.
3. **Task 3** — Favicon migration; verify the `<link rel="icon">` tag on both surfaces.
4. **Task 4** — README `<picture>` blocks.
5. **Task 5** — CI and lefthook drift guards.

---

### Task 1: Brand package with generated assets

**Files:**
- Create: `packages/brand/package.json`, `packages/brand/tsconfig.json`, `packages/brand/scripts/build-assets.ts`, `packages/brand/src/aio-proxy-wordmark.svg`, `packages/brand/src/aio-proxy-mark.svg`, `packages/brand/src/index.ts`
- Generated (by the script, then committed): `packages/brand/src/aio-proxy-wordmark-light.svg`, `aio-proxy-wordmark-dark.svg`, `aio-proxy-mark-favicon.svg`, `logo-geometry.ts`
- Modify: `oxc.ts`, `tsconfig.json`, `package.json`, `packages/ui/package.json`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `packages/brand/src/logo-geometry.ts` exporting four `const` string values: `WORDMARK_VIEW_BOX`, `WORDMARK_PATH`, `MARK_VIEW_BOX`, `MARK_PATH`. Task 2's component imports `WORDMARK_VIEW_BOX` and `WORDMARK_PATH`.
  - `packages/brand/src/aio-proxy-mark-favicon.svg`, resolvable as `@aio-proxy/brand/assets/aio-proxy-mark-favicon.svg`. Task 3 resolves this path.
  - `packages/brand/src/aio-proxy-wordmark-{light,dark}.svg`, committed so jsDelivr can serve them. Task 4 links to these.

---

- [ ] **Step 1: Create the package directory and manifest**

```bash
mkdir -p packages/brand/src packages/brand/scripts
```

Create `packages/brand/package.json`:

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
  },
  "devDependencies": {
    "@aio-proxy/infra": "workspace:*",
    "@types/react": "catalog:",
    "react": "catalog:",
    "typescript": "catalog:"
  }
}
```

The `version` matches every other workspace package — Changesets uses `fixed` lockstep versioning, so a mismatched version breaks `changeset version`.

- [ ] **Step 2: Create the TypeScript project config**

Create `packages/brand/tsconfig.json`. This mirrors `packages/ui/tsconfig.json` — the same `jsx` and `noEmit` settings, because this package also ships `.tsx` consumed directly from source:

```json
{
  "extends": "@aio-proxy/infra/tsconfig/base.json",
  "compilerOptions": {
    "exactOptionalPropertyTypes": false,
    "jsx": "react-jsx",
    "noPropertyAccessFromIndexSignature": false,
    "noEmit": true,
    "rootDir": "src"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

- [ ] **Step 3: Author the two source SVGs by extracting existing geometry**

Do NOT type the path data by hand — it is 2875 and 1023 characters respectively. Extract it programmatically from the files that already hold it.

The wordmark geometry lives in an untracked file in the **main checkout** (not this worktree): `/Volumes/ExternalSSD/workspace/aio-proxy/packages/dashboard/public/logo-dark.svg`. The mark geometry lives in the tracked `packages/dashboard/public/favicon.svg`.

```bash
python3 - <<'PYEOF'
import re

def extract(path):
    s = open(path).read()
    return (
        re.search(r'viewBox="([^"]*)"', s).group(1),
        re.search(r'\bd="([^"]*)"', s).group(1),
    )

wm_box, wm_d = extract('/Volumes/ExternalSSD/workspace/aio-proxy/packages/dashboard/public/logo-dark.svg')
mk_box, mk_d = extract('packages/dashboard/public/favicon.svg')

assert wm_box == '0 0 1920 480', wm_box
assert len(wm_d) == 2875, len(wm_d)
assert mk_box == '0 0 720 720', mk_box
assert len(mk_d) == 1023, len(mk_d)

open('packages/brand/src/aio-proxy-wordmark.svg', 'w').write(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{wm_box}">'
    f'<path fill="currentColor" d="{wm_d}"/></svg>\n'
)
open('packages/brand/src/aio-proxy-mark.svg', 'w').write(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{mk_box}">'
    f'<path fill="currentColor" d="{mk_d}"/></svg>\n'
)
print('wrote both sources')
PYEOF
```

Expected output: `wrote both sources`. If any assertion fails, stop — the upstream file changed and this plan's constants are stale.

The mark source deliberately drops the favicon's `<style>` block, its `id="a"`, and its `<title>`: the generated favicon re-adds the media query, and the component supplies its own `<title>`.

- [ ] **Step 4: Write the generator**

Create `packages/brand/scripts/build-assets.ts`:

```ts
import { join } from 'node:path';

const SOURCE_DIR = join(import.meta.dir, '..', 'src');

/** Tailwind `--color-olive-950`; the dashboard theme's `--foreground` in light mode. */
const DARK_INK = '#0c0c09';
/** Tailwind `--color-olive-50`; the dashboard theme's `--foreground` in dark mode. */
const LIGHT_INK = '#fbfbf9';

interface Geometry {
  readonly viewBox: string;
  readonly path: string;
}

const readGeometry = async (fileName: string): Promise<Geometry> => {
  const svg = await Bun.file(join(SOURCE_DIR, fileName)).text();
  const viewBox = /viewBox="([^"]*)"/.exec(svg)?.[1];
  const path = /\bd="([^"]*)"/.exec(svg)?.[1];
  if (!viewBox || !path) {
    throw new Error(`${fileName} is missing a viewBox or a path`);
  }
  return { viewBox, path };
};

const write = async (fileName: string, contents: string): Promise<void> => {
  await Bun.write(join(SOURCE_DIR, fileName), contents);
};

const coloredSvg = ({ viewBox, path }: Geometry, fill: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><title>AIO Proxy</title>` +
  `<path fill="${fill}" d="${path}"/></svg>\n`;

const faviconSvg = ({ viewBox, path }: Geometry): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><title>AIO Proxy</title>` +
  `<style>#mark{fill:${DARK_INK}}@media (prefers-color-scheme:dark){#mark{fill:${LIGHT_INK}}}</style>` +
  `<path id="mark" d="${path}"/></svg>\n`;

const geometryModule = (wordmark: Geometry, mark: Geometry): string =>
  [
    '// Generated by packages/brand/scripts/build-assets.ts. Do not edit.',
    '',
    `export const WORDMARK_VIEW_BOX = '${wordmark.viewBox}';`,
    '',
    `export const WORDMARK_PATH =\n  '${wordmark.path}';`,
    '',
    `export const MARK_VIEW_BOX = '${mark.viewBox}';`,
    '',
    `export const MARK_PATH =\n  '${mark.path}';`,
    '',
  ].join('\n');

const wordmark = await readGeometry('aio-proxy-wordmark.svg');
const mark = await readGeometry('aio-proxy-mark.svg');

await write('aio-proxy-wordmark-light.svg', coloredSvg(wordmark, DARK_INK));
await write('aio-proxy-wordmark-dark.svg', coloredSvg(wordmark, LIGHT_INK));
await write('aio-proxy-mark-favicon.svg', faviconSvg(mark));
await write('logo-geometry.ts', geometryModule(wordmark, mark));

console.log('Generated 3 SVG artifacts and logo-geometry.ts.');
```

Note the naming inversion, which is intentional and matches Tailwind CSS, Vite, and tRPC: `-light.svg` holds `DARK_INK` because it is shown on a light background, and `-dark.svg` holds `LIGHT_INK`.

The path data is single-quoted in the generated TypeScript. SVG path syntax contains no single quotes or backslashes, so no escaping is needed — Step 6 asserts this holds.

- [ ] **Step 5: Install and run the generator**

```bash
bun install
```

```bash
bun run --filter @aio-proxy/brand build:assets
```

Expected output: `Generated 3 SVG artifacts and logo-geometry.ts.`

- [ ] **Step 6: Verify the generated artifacts**

```bash
python3 - <<'PYEOF'
import re
src = 'packages/brand/src/'

light = open(src + 'aio-proxy-wordmark-light.svg').read()
dark = open(src + 'aio-proxy-wordmark-dark.svg').read()
fav = open(src + 'aio-proxy-mark-favicon.svg').read()
geo = open(src + 'logo-geometry.ts').read()

assert 'fill="#0c0c09"' in light, 'light wordmark must carry dark ink'
assert 'fill="#fbfbf9"' in dark, 'dark wordmark must carry light ink'
assert 'oklch' not in light + dark + fav, 'no oklch in generated artifacts'
assert 'prefers-color-scheme:dark' in fav, 'favicon needs the media query'
assert '#0c0c09' in fav and '#fbfbf9' in fav, 'favicon needs both inks'

# The two wordmarks must differ only in their fill.
assert re.sub(r'#[0-9a-f]{6}', 'X', light) == re.sub(r'#[0-9a-f]{6}', 'X', dark)

# Path data must survive the round-trip into TypeScript intact.
wm_d = re.search(r'\bd="([^"]*)"', open(src + 'aio-proxy-wordmark.svg').read()).group(1)
assert len(wm_d) == 2875
assert "'" not in wm_d and '\\' not in wm_d, 'path data would need escaping'
assert wm_d in geo, 'wordmark path missing from logo-geometry.ts'
for name in ('WORDMARK_VIEW_BOX', 'WORDMARK_PATH', 'MARK_VIEW_BOX', 'MARK_PATH'):
    assert f'export const {name}' in geo, name
print('all artifact assertions passed')
PYEOF
```

Expected output: `all artifact assertions passed`

- [ ] **Step 7: Verify the generator is idempotent**

The CI drift check in Task 5 is meaningless unless a second run reproduces byte-identical output.

```bash
bun run --filter @aio-proxy/brand build:assets && git status --short --untracked-files=all -- packages/brand/src
```

Expected: the four generated files appear as `??` (they are new and not yet committed), and nothing else changes. To confirm byte-stability specifically:

```bash
md5 packages/brand/src/logo-geometry.ts && bun run --filter @aio-proxy/brand build:assets > /dev/null && md5 packages/brand/src/logo-geometry.ts
```

Expected: the two hashes are identical.

- [ ] **Step 8: Create the package entry point**

Create `packages/brand/src/index.ts`. The component lands in Task 2; for now the geometry is the only export:

```ts
export { MARK_PATH, MARK_VIEW_BOX, WORDMARK_PATH, WORDMARK_VIEW_BOX } from './logo-geometry';
```

- [ ] **Step 9: Exempt the generated module from oxlint and oxfmt**

Modify `oxc.ts`. Add the new entry after the existing `route-tree.gen.ts` line:

```ts
export const ignorePatterns = [
  '**/dist/**',
  '.reference/**',
  '.worktrees/**',
  'packages/brand/src/logo-geometry.ts',
  'packages/core/src/db/migrations.manifest.ts',
  'packages/dashboard/src/route-tree.gen.ts',
  'packages/i18n/project.inlang/**',
  'packages/i18n/src/paraglide/**',
  'packages/plugins/cursor/src/gen/**',
  // shadcn-generated primitives are maintained upstream rather than by this repository.
  'packages/ui/src/components/**',
  'docs/superpowers/**',
  // Verbatim upstream codex instructions snapshot imported as text; must not be reformatted.
  'packages/server/src/server/list-models/codex-client-models/default-instructions.md',
];
```

- [ ] **Step 10: Register the TypeScript project reference**

Modify the root `tsconfig.json`, adding `./packages/brand` to `references`. Place it first, since the brand package depends on no other workspace package:

```json
{
  "files": [],
  "references": [
    {
      "path": "./packages/brand"
    },
    {
      "path": "./packages/infra"
    },
    {
      "path": "./packages/types"
    },
    {
      "path": "./packages/i18n"
    },
    {
      "path": "./packages/plugin-sdk"
    },
    {
      "path": "./packages/plugins/github-copilot"
    },
    {
      "path": "./packages/plugins/openai-chatgpt"
    },
    {
      "path": "./packages/core"
    },
    {
      "path": "./packages/server"
    },
    {
      "path": "./packages/dashboard"
    },
    {
      "path": "./packages/cli"
    },
    {
      "path": "./packages/cli/scripts"
    }
  ]
}
```

- [ ] **Step 11: Move `cn` into the root catalog**

`CLAUDE.md` requires catalog management once a dependency has two or more workspace consumers, which the brand package's `"cn": "catalog:"` makes true.

In the root `package.json`, add `"cn": "^0.2.5"` to `workspaces.catalog`, in alphabetical position between `class-variance-authority` and `@inlang/paraglide-js`:

```json
    "class-variance-authority": "^0.7.1",
    "cn": "^0.2.5",
    "@inlang/paraglide-js": "2.22.0",
```

In `packages/ui/package.json`, change the `cn` dependency:

```json
    "cn": "catalog:",
```

- [ ] **Step 12: Reinstall and verify the workspace resolves**

```bash
bun install
```

```bash
bun run check
```

Expected: exit 0. `bun run check` is `oxlint . && oxfmt --check .`. If oxfmt reports `logo-geometry.ts`, the `oxc.ts` entry in Step 10 is wrong — fix it rather than reformatting the generated file.

- [ ] **Step 13: Commit**

```bash
git add packages/brand oxc.ts tsconfig.json package.json packages/ui/package.json bun.lock
git commit -m "feat(brand): add @aio-proxy/brand package with generated logo assets"
```

---

### Task 2: React component and consumer migration

**Files:**
- Create: `packages/brand/src/aio-proxy-logo.tsx`
- Modify: `packages/brand/src/index.ts`, `packages/ui/src/styles.css`, `packages/dashboard/package.json`, `packages/dashboard/src/components/aio-proxy-brand.tsx`, `website/package.json`, `website/theme/components/nav-title/index.tsx`
- Delete: `packages/ui/src/components/aio-proxy-logo.tsx`

**Interfaces:**
- Consumes: `WORDMARK_VIEW_BOX` and `WORDMARK_PATH` from `packages/brand/src/logo-geometry.ts` (Task 1).
- Produces: `AioProxyLogo`, exported from `@aio-proxy/brand`. Props: `AioProxyLogoProps = Omit<ComponentProps<'svg'>, 'viewBox' | 'children'>`. Both consumers pass only `className`.

---

- [ ] **Step 1: Read the component being replaced**

```bash
cat packages/ui/src/components/aio-proxy-logo.tsx
```

Note two things it does that the replacement deliberately drops: a `<text x="720" y="365">Proxy</text>` element that depends on the Lexend webfont having loaded, and a `children` passthrough neither consumer uses. Note one thing it does that the replacement keeps verbatim: the default class list `'h-[1.333em] w-auto shrink-0 text-lg text-foreground'`.

- [ ] **Step 2: Write the component**

Create `packages/brand/src/aio-proxy-logo.tsx`:

```tsx
import { cn } from 'cn';
import type { ComponentProps } from 'react';

import { WORDMARK_PATH, WORDMARK_VIEW_BOX } from './logo-geometry';

type AioProxyLogoProps = Omit<ComponentProps<'svg'>, 'viewBox' | 'children'>;

export function AioProxyLogo({ className, ...props }: AioProxyLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={WORDMARK_VIEW_BOX}
      fill="currentColor"
      aria-label="AIO Proxy"
      role="img"
      className={cn('h-[1.333em] w-auto shrink-0 text-lg text-foreground', className)}
      {...props}
    >
      <title>AIO Proxy</title>
      <path d={WORDMARK_PATH} />
    </svg>
  );
}
```

`cn` rather than string concatenation is load-bearing. `login-page.tsx:41` renders `<AioProxyBrand className="text-2xl" />` against the default `text-lg`; concatenation would emit both classes and let CSS source order pick the winner, whereas `cn` resolves the conflict to `text-2xl`.

- [ ] **Step 3: Export the component**

Modify `packages/brand/src/index.ts`:

```ts
export { AioProxyLogo } from './aio-proxy-logo';
export { MARK_PATH, MARK_VIEW_BOX, WORDMARK_PATH, WORDMARK_VIEW_BOX } from './logo-geometry';
```

- [ ] **Step 4: Bring the new source directory into Tailwind's scan scope**

This step is not optional and its omission fails silently. Tailwind v4 scans only what the CSS entry declares. `packages/ui/src/styles.css` — imported by both the dashboard and the website — declares `@source "./components"`, so moving the component to `packages/brand/src` takes `h-[1.333em]` out of scope; both builds still succeed and the logo renders unstyled.

Modify `packages/ui/src/styles.css`, line 8:

```css
@source "./components";
@source "../../brand/src";
```

- [ ] **Step 5: Declare the dependency in both consumers**

In `packages/dashboard/package.json`, add to `dependencies`, alphabetically first among the `@aio-proxy/*` entries:

```json
    "@aio-proxy/brand": "workspace:*",
    "@aio-proxy/i18n": "workspace:*",
```

In `website/package.json`, add to `dependencies`:

```json
    "@aio-proxy/brand": "workspace:*",
    "@aio-proxy/ui": "workspace:*",
```

- [ ] **Step 6: Migrate the dashboard consumer**

Modify `packages/dashboard/src/components/aio-proxy-brand.tsx`, line 2. The whole file afterwards:

```tsx
import { AioProxyLogo } from '@aio-proxy/brand';
import { m } from '@aio-proxy/i18n';

interface AioProxyBrandProps {
  readonly className?: string;
  readonly showTagline?: boolean;
}

export const AioProxyBrand: React.FC<AioProxyBrandProps> = ({ className, showTagline = true }) => {
  return (
    <div>
      <AioProxyLogo className={className} />
      {showTagline ? <div className="mt-1 truncate text-xs text-muted-foreground">{m['brand.tagline']()}</div> : null}
    </div>
  );
};
```

Import order matters to oxlint: `@aio-proxy/brand` sorts before `@aio-proxy/i18n`.

- [ ] **Step 7: Migrate the website consumer**

Modify `website/theme/components/nav-title/index.tsx`, line 1:

```tsx
import { AioProxyLogo } from '@aio-proxy/brand';
import { addLeadingSlash, addTrailingSlash, useLang, useSite } from '@rspress/core/runtime';
import { Link } from '@rspress/core/theme';
```

The rest of the file is unchanged.

- [ ] **Step 8: Delete the old component and confirm no references remain**

```bash
git rm packages/ui/src/components/aio-proxy-logo.tsx
```

```bash
grep -rn "ui/components/aio-proxy-logo" --exclude-dir=node_modules --exclude-dir=dist . ; echo "exit=$?"
```

Expected: no matches, `exit=1`. Any hit other than inside `docs/superpowers/` is a missed consumer.

- [ ] **Step 9: Install and build the dashboard**

```bash
bun install && bun run --filter @aio-proxy/dashboard build
```

Expected: exit 0.

- [ ] **Step 10: Verify Tailwind emitted the component's classes**

```bash
grep -rl '1\.333em' packages/dashboard/dist/static/css/ || echo "MISSING — @source fix did not take effect"
```

Expected: a filename such as `packages/dashboard/dist/static/css/index.<hash>.css`. If it prints `MISSING`, Step 4 was not applied or the relative path is wrong.

- [ ] **Step 11: Build the website and verify the same**

```bash
bun run --filter @aio-proxy/website build
```

```bash
grep -rl '1\.333em' website/dist/static/css/ || echo "MISSING — @source fix did not take effect"
```

Expected: a filename such as `website/dist/static/css/styles.<hash>.css`.

- [ ] **Step 12: Run lint and formatting**

```bash
bun run check
```

Expected: exit 0.

- [ ] **Step 13: Commit**

```bash
git add packages/brand packages/ui packages/dashboard/package.json packages/dashboard/src/components/aio-proxy-brand.tsx website/package.json website/theme/components/nav-title/index.tsx bun.lock
git commit -m "refactor(brand): move AioProxyLogo out of the shadcn-managed directory"
```

---

### Task 3: Favicon migration

**Files:**
- Modify: `packages/dashboard/rsbuild.config.ts`, `website/rspress.config.ts`
- Delete: `packages/dashboard/public/favicon.svg`, `website/docs/public/favicon.svg`

**Interfaces:**
- Consumes: `packages/brand/src/aio-proxy-mark-favicon.svg` from Task 1, resolved via the `./assets/*` export as `@aio-proxy/brand/assets/aio-proxy-mark-favicon.svg`.
- Produces: nothing consumed by later tasks.

Neither surface currently configures a favicon — rsbuild auto-detects `public/favicon.svg` and injects the `<link>` tag on its own. Deleting those files removes the tag, so each surface must now name the file explicitly. `output.copy` is the wrong primitive: it places the asset in `dist` but emits no `<link>`.

- [ ] **Step 1: Record the pre-change baseline**

Both builds already ran in Task 2, so their output is current.

```bash
grep -o '<link[^>]*rel="icon"[^>]*>' packages/dashboard/dist/index.html; grep -o '<link[^>]*rel="icon"[^>]*>' website/dist/index.html
```

Expected, exactly:

```
<link rel="icon" href="/dashboard/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
```

These two lines are what Step 6 and Step 8 must reproduce.

- [ ] **Step 2: Point the dashboard at the brand favicon**

Modify `packages/dashboard/rsbuild.config.ts`. Add the `node:url` import at the top, the `favicon` constant next to the existing `apiUrl`, and the `favicon` key inside `html`:

```ts
import { fileURLToPath } from 'node:url';

import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginSvgr } from '@rsbuild/plugin-svgr';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { tanstackRouter } from '@tanstack/router-plugin/rspack';

const apiUrl = `http://127.0.0.1:${process.env.AIO_PROXY_PORT ?? '9317'}`;

const favicon = fileURLToPath(import.meta.resolve('@aio-proxy/brand/assets/aio-proxy-mark-favicon.svg'));
```

and:

```ts
  html: {
    title: 'AIO Proxy Dashboard',
    favicon,
  },
```

Everything else in the file is unchanged.

`import.meta.resolve` rather than `require.resolve`: the config is ESM under `"type": "module"`, where `require` is not defined. It has been verified to work inside rsbuild's config loader and to resolve through the `./assets/*` wildcard export.

- [ ] **Step 3: Point the website at the brand favicon**

Modify `website/rspress.config.ts`. Change the `icon` value from `'/favicon.svg'`:

```ts
  icon: import.meta.resolve('@aio-proxy/brand/assets/aio-proxy-mark-favicon.svg'),
```

The `file://` URL form is required, not an absolute path. Rspress normalizes `icon` into rsbuild's `html.favicon`, converting a `file://` URL via `fileURLToPath` but joining a bare absolute path onto `docs/public` — which would silently point outside the doc root (`@rspress/core/dist/node/initRsbuild.js:49-55`). `import.meta.resolve` returns exactly the URL form rspress handles.

- [ ] **Step 4: Delete both copies**

```bash
git rm packages/dashboard/public/favicon.svg website/docs/public/favicon.svg
```

`packages/dashboard/public/` becomes empty and git will not track it; that is expected.

- [ ] **Step 5: Rebuild the dashboard**

```bash
bun run --filter @aio-proxy/dashboard build
```

Expected: exit 0.

- [ ] **Step 6: Verify the dashboard still emits the icon tag**

```bash
grep -o '<link[^>]*rel="icon"[^>]*>' packages/dashboard/dist/index.html || echo "REGRESSION — favicon link is gone"
```

Expected: a `<link rel="icon" ...>` tag. The `href` filename may differ from the baseline (rsbuild may hash or rename the copied asset); the tag's presence is what matters. If it prints `REGRESSION`, the resolved path in Step 2 is wrong.

Also confirm the asset itself was copied and carries the brand colors:

```bash
find packages/dashboard/dist -name '*favicon*' -o -name '*mark*' | head; grep -l 'prefers-color-scheme' $(find packages/dashboard/dist -name '*.svg')
```

Expected: at least one emitted SVG containing the media query.

- [ ] **Step 7: Rebuild the website**

```bash
bun run --filter @aio-proxy/website build
```

Expected: exit 0.

- [ ] **Step 8: Verify the website still emits the icon tag**

```bash
grep -o '<link[^>]*rel="icon"[^>]*>' website/dist/index.html || echo "REGRESSION — favicon link is gone"
```

Expected: a `<link rel="icon" ...>` tag.

- [ ] **Step 9: Run lint and formatting**

```bash
bun run check
```

Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add packages/dashboard/rsbuild.config.ts website/rspress.config.ts packages/dashboard/public website/docs/public
git commit -m "refactor(brand): serve one favicon from the brand package"
```

---

### Task 4: README logos

**Files:**
- Modify: `README.md`, `README.zh-Hans.md`

**Interfaces:**
- Consumes: the two committed wordmark SVGs from Task 1, which must be on `main` before jsDelivr can serve them.
- Produces: nothing consumed by later tasks.

---

- [ ] **Step 1: Replace the English README heading**

In `README.md`, replace line 1 (`# AIO Proxy`) with:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://fastly.jsdelivr.net/gh/aio-proxy/aio-proxy@main/packages/brand/src/aio-proxy-wordmark-dark.svg">
  <img alt="AIO Proxy" src="https://fastly.jsdelivr.net/gh/aio-proxy/aio-proxy@main/packages/brand/src/aio-proxy-wordmark-light.svg" width="360">
</picture>
```

Line 2 (blank) and line 3 (`English | [简体中文](...)`) stay as they are.

`<picture>` with `prefers-color-scheme` is GitHub's documented mechanism and what Vite, Tailwind CSS, oxc, tRPC, and TanStack Query all use. Dropping the `h1` follows Vite and Tailwind CSS — the wordmark already spells the name — and the root READMEs are not published to npm (`npm/aio-proxy/package.json` ships only `bin` and `config.schema.json`), so registry markdown rendering is not a constraint.

- [ ] **Step 2: Replace the Chinese README heading**

In `README.zh-Hans.md`, replace line 1 (`# AIO Proxy`) with the identical block:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://fastly.jsdelivr.net/gh/aio-proxy/aio-proxy@main/packages/brand/src/aio-proxy-wordmark-dark.svg">
  <img alt="AIO Proxy" src="https://fastly.jsdelivr.net/gh/aio-proxy/aio-proxy@main/packages/brand/src/aio-proxy-wordmark-light.svg" width="360">
</picture>
```

Line 3 (`[English](./README.md) | 简体中文`) stays as it is.

- [ ] **Step 3: Verify the referenced paths exist**

The jsDelivr URLs will 404 until these files reach `main`, so verify against the working tree instead:

```bash
ls packages/brand/src/aio-proxy-wordmark-light.svg packages/brand/src/aio-proxy-wordmark-dark.svg
```

Expected: both paths listed. Any typo in the URL path segment is a broken image on the repository landing page.

```bash
python3 - <<'PYEOF'
import re
for f in ('README.md', 'README.zh-Hans.md'):
    s = open(f).read()
    urls = re.findall(r'https://fastly\.jsdelivr\.net/gh/aio-proxy/aio-proxy@main/(\S+?)["\s]', s)
    assert len(urls) == 2, (f, urls)
    for u in urls:
        import os
        assert os.path.exists(u), (f, u)
    assert not s.startswith('# AIO Proxy'), f'{f} still has the h1'
print('README URLs resolve to real files')
PYEOF
```

Expected: `README URLs resolve to real files`

- [ ] **Step 4: Run formatting**

```bash
bun run check
```

Expected: exit 0. oxfmt formats markdown; if it rewraps the HTML block, accept its output.

- [ ] **Step 5: Commit**

```bash
git add README.md README.zh-Hans.md
git commit -m "docs: render the AIO Proxy wordmark in both READMEs"
```

---

### Task 5: Drift guards

**Files:**
- Modify: `.github/workflows/ci.yml`, `lefthook.yml`

**Interfaces:**
- Consumes: the `build:assets` script from Task 1.
- Produces: nothing.

No unit tests. The contract worth guarding is "generated artifacts match their source," and the repository already has a mechanism for exactly that — `@aio-proxy/core`'s migrations check. Asserting on path strings in a unit test would only restate implementation literals, which `CLAUDE.md` rules out.

---

- [ ] **Step 1: Read the precedent**

```bash
sed -n '30,40p' .github/workflows/ci.yml
```

You will see lines 34-35:

```yaml
      - run: bun run --filter @aio-proxy/core build:migrations
      - run: test -z "$(git status --short --untracked-files=all -- packages/core/src/db/migrations)"
```

- [ ] **Step 2: Add the brand check to CI**

Modify `.github/workflows/ci.yml`, inserting two steps immediately after the migrations pair, at the same indentation:

```yaml
      - run: bun run --filter @aio-proxy/brand build:assets
      - run: test -z "$(git status --short --untracked-files=all -- packages/brand/src)"
```

- [ ] **Step 3: Add the pre-commit regeneration hook**

Modify `lefthook.yml`, adding a `brand-assets` command under `pre-commit.commands` after `bun-check`:

```yaml
pre-commit:
  commands:
    oxlint:
      glob: '*.{js,ts,cjs,mjs,d.cts,d.mts,jsx,tsx}'
      run: bunx oxlint --fix --no-error-on-unmatched-pattern {staged_files}
      stage_fixed: true
    oxfmt:
      glob: '*.{js,ts,cjs,mjs,d.cts,d.mts,jsx,tsx,json,jsonc,css,md}'
      run: bunx oxfmt --no-error-on-unmatched-pattern {staged_files}
      stage_fixed: true
    bun-check:
      glob: 'bun.lock'
      run: bun run scripts/bun-lock-check.ts
    brand-assets:
      glob: 'packages/brand/src/*.svg'
      run: bun run --filter @aio-proxy/brand build:assets
      stage_fixed: true
```

The glob deliberately covers generated SVGs as well as the two sources. Regeneration is idempotent, so a commit touching only generated files simply reproduces them — cheaper than depending on lefthook's brace expansion to single out the sources.

- [ ] **Step 4: Verify the CI assertion passes on a clean tree**

This is exactly what CI will run:

```bash
bun run --filter @aio-proxy/brand build:assets && test -z "$(git status --short --untracked-files=all -- packages/brand/src)" && echo "CLEAN"
```

Expected: `CLEAN`. If it prints nothing, the generator is not byte-stable — fix the generator, not the assertion.

- [ ] **Step 5: Verify the assertion actually catches drift**

A guard that never fails is not a guard. Prove it fires by editing a **source** — that is what the check exists to catch. (Editing a generated file instead would prove nothing: regeneration simply overwrites it and the tree comes back clean.)

```bash
python3 -c "
p='packages/brand/src/aio-proxy-wordmark.svg'
s=open(p).read().replace('viewBox=\"0 0 1920 480\"','viewBox=\"0 0 1920 481\"')
open(p,'w').write(s)
"
bun run --filter @aio-proxy/brand build:assets && test -z "$(git status --short --untracked-files=all -- packages/brand/src)" && echo "CLEAN" || echo "DRIFT DETECTED"
```

Expected: `DRIFT DETECTED` — the source change propagated into the generated artifacts, so the tree is dirty. If this prints `CLEAN`, the CI step added in Step 2 is worthless and the generator is not actually reading its sources.

- [ ] **Step 6: Restore the tampered source**

```bash
git checkout -- packages/brand/src/aio-proxy-wordmark.svg && bun run --filter @aio-proxy/brand build:assets && git status --short --untracked-files=all -- packages/brand/src; echo "---"; test -z "$(git status --short --untracked-files=all -- packages/brand/src)" && echo "RESTORED CLEAN"
```

Expected: `RESTORED CLEAN` with no files listed above it.

- [ ] **Step 7: Run the full preflight**

```bash
bun run preflight
```

Expected: exit 0. This is `lint:types && format:check && test`. It is the repository's own definition of "done" per `CLAUDE.md`.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/ci.yml lefthook.yml
git commit -m "ci(brand): assert generated brand assets match their sources"
```

---

## Final Verification

- [ ] **The working tree is clean**

```bash
git status --short --untracked-files=all
```

Expected: no output.

- [ ] **No reference to the deleted component survives**

```bash
grep -rn "ui/components/aio-proxy-logo" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git . | grep -v "docs/superpowers/"; echo "exit=$?"
```

Expected: no output, `exit=1`.

- [ ] **No stale favicon copies survive**

```bash
git ls-files | grep 'public/favicon.svg'; echo "exit=$?"
```

Expected: no output, `exit=1`.

- [ ] **Both surfaces build and emit an icon tag**

```bash
bun run --filter @aio-proxy/dashboard build && bun run --filter @aio-proxy/website build && grep -c 'rel="icon"' packages/dashboard/dist/index.html website/dist/index.html
```

Expected: both files report `1`.

- [ ] **Both surfaces emit the brand component's Tailwind classes**

```bash
grep -rl '1\.333em' packages/dashboard/dist/static/css/ website/dist/static/css/
```

Expected: one filename from each directory.
