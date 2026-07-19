# Biome → Oxlint + Oxfmt Design

## Context

The monorepo uses Biome (`@biomejs/biome` + root `biome.json`) for lint,
format, import assist, pre-commit autofix (`lefthook.yml`), editor format-on-save
(`.vscode/settings.json`, `.idea/biome.xml`), and the root `check` /
`preflight` gates.

We want a full cutover to the Oxc toolchain: **oxlint** for lint and **oxfmt**
for format, including one repository-wide reformat of every non-ignored file
oxfmt supports.

## Goals

- Remove Biome as a dependency and config surface (CLI, VS Code, JetBrains).
- Lint with oxlint **recommended / correctness defaults**.
- Format with oxfmt, preserving current style intent (`printWidth: 120`, 2-space
  indent) via `oxfmt --migrate biome`.
- Carry forward intentional project standards that recommended does not cover
  (300-line file warn; Tailwind class sorting via oxfmt).
- Update scripts, lefthook, editor configs, and agent docs so day-to-day
  workflows use Oxc only.
- Accept a one-time repository-wide `oxfmt` rewrite of all non-ignored,
  oxfmt-supported files.

## Non-goals

- Enabling oxlint **type-aware** linting (`oxlint-tsgolint`) in this migration.
- Adding ESLint, Prettier, or a dual-tool transition period.
- Rewriting historical plans under `.omo/` or `docs/superpowers/plans/`
  (formatter must ignore these paths).
- Adding the third-party `oxlint-tailwindcss` lint plugin.

## Decisions

### Approach

Use official `oxfmt --migrate biome` for formatter config; hand-author
`.oxlintrc.json` on recommended defaults; wire scripts/hooks/editor manually.

Do **not** use community `biome-to-oxc` as the primary migrator.

### Lint baseline

- Enable oxlint recommended / correctness defaults (oxlint's shipping baseline).
- Keep the Biome override: disable lint for
  `packages/dashboard/src/components/ui/**`.
- Ignore generated / vendored paths aligned with current `biome.json`
  `files.includes` negations.

### Custom Biome rules vs oxlint recommended

| Former Biome setting                  | Oxc outcome                                                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `noDeprecatedImports`                 | Drop for now. Closest rule is type-aware `typescript/no-deprecated` (pedantic); type-aware is out of scope.                        |
| `useSortedClasses` (`cn` / `cva`)     | Not in oxlint recommended. Replaced by **oxfmt** `sortTailwindcss`.                                                                |
| `noExcessiveLinesPerFile` (300, warn) | Keep via `eslint/max-lines` warn (`max: 300`, skip blank lines). This is a repo coding standard in `AGENTS.md`, not Biome default. |

### Format + Tailwind class sorting

- Generate `.oxfmtrc.json` with `oxfmt --migrate biome`, then verify
  `printWidth: 120`, spaces/indent, and ignore patterns.
- Biome `assist.actions.source.organizeImports` maps to oxfmt import sorting
  (`sortImports` / migrate output). Keep import sorting enabled if migrate
  preserves it; otherwise turn on the oxfmt equivalent explicitly.
- Enable oxfmt Tailwind sorting:

```json
{
  "sortTailwindcss": {
    "stylesheet": "packages/dashboard/src/styles.css",
    "functions": ["cn", "cva"]
  }
}
```

- Do not add `oxlint-tailwindcss` for sort-order parity.

### What “full repo” means

“Full-repo” / repository-wide format means: run oxfmt over the workspace root
(`.`) so it visits every file oxfmt supports that is **not** listed in formatter
`ignorePatterns` (and other ignore sources oxfmt honors, such as `.gitignore`
when applicable).

It does **not** mean rewriting historical plan Markdown under `.omo/` or
`docs/superpowers/plans/`. Those paths are formatter-only ignores so the
non-goal stays intact even though oxfmt can format Markdown.

### Check / format path scope

Prefer ignore-driven root commands over an explicit allowlist of a few root
files plus `packages`:

```text
check   → oxlint . && oxfmt --check .
format  → oxfmt .
```

Scope is controlled by `.oxlintrc.json` / `.oxfmtrc.json` ignore patterns so
`scripts/`, `npm/`, and other tracked code stay in the continuous gate and
cannot drift after the initial rewrite. Historical plan trees stay out via
formatter-only ignores.

`preflight` keeps calling `check` first, then existing test steps.

### Type-aware (deferred)

Type-aware lint runs `tsgolint` / typescript-go and is several times slower than
plain oxlint. It remains a possible follow-up for rules like `no-deprecated`,
not part of this cutover.

## Tooling surface

### Dependencies (root)

- Add: `oxlint`, `oxfmt`
- Remove: `@biomejs/biome`

### Config files

| Action | Path              |
| ------ | ----------------- |
| Add    | `.oxlintrc.json`  |
| Add    | `.oxfmtrc.json`   |
| Remove | `biome.json`      |
| Remove | `.idea/biome.xml` |

Shared ignore intent (formatter + linter):

- `**/dist`
- `.reference`
- `.worktrees`
- `packages/core/src/db/migrations.manifest.ts`
- `packages/dashboard/src/route-tree.gen.ts`
- `packages/i18n/project.inlang/.meta.json`
- `packages/i18n/src/paraglide`

Formatter-only ignores (preserve historical plans; oxfmt formats Markdown):

- `.omo/**`
- `docs/superpowers/plans/**`

### Scripts

Replace root `check` / add `format` as above (`oxlint .` + `oxfmt --check .` /
`oxfmt .`), with ignores owning the boundary rather than a narrow path list.

### lefthook

Pre-commit: run oxlint fix + oxfmt on staged files (with unmatched-pattern
tolerance), keep `stage_fixed: true`. Drop the Biome command.

### Editors

**VS Code (`.vscode/settings.json`)**

- Remove Biome formatter / code-action settings and the broken `frontend/...`
  Biome paths.
- Configure the Oxc / oxfmt editor integration recommended by upstream for
  format-on-save on TS/TSX (and other supported languages already covered by
  today's Biome hook glob where practical).

**JetBrains (`.idea/biome.xml`)**

- Delete the tracked Biome IDE config so format / safe fixes / import sorting
  on save no longer point at Biome.
- Do not add a replacement JetBrains Oxc config in this migration unless a
  checked-in, project-shared equivalent already exists upstream; local IDE
  setup can follow Oxc docs after cutover.

### Docs

Update `AGENTS.md` / `CLAUDE.md` (and dashboard copies only if they mention
Biome) so completion gates say oxlint + oxfmt instead of `biome check`.

### Inline suppressions

Replace remaining `biome-ignore` comments with oxlint equivalents, or remove
them if the rule no longer applies.

## Migration sequence

1. Install `oxlint` and `oxfmt`; remove `@biomejs/biome` after configs land.
2. Run `oxfmt --migrate biome`; add `sortTailwindcss`; finalize shared ignores
   and formatter-only ignores (`.omo/**`, `docs/superpowers/plans/**`).
3. Author `.oxlintrc.json` (recommended + `max-lines` + ui override + ignores).
4. Update `package.json` scripts, `lefthook.yml`, `.vscode/settings.json`, agent
   docs; delete `biome.json` and `.idea/biome.xml`.
5. Repository-wide `oxfmt .` write (all non-ignored, oxfmt-supported files);
   fix oxlint failures and suppressions.
6. Verify with `bun run check` (`oxlint .` && `oxfmt --check .`) and
   `bun run preflight` (or check + affected unit tests at minimum).

### Commit preference

Prefer two commits when implementing:

1. Toolchain + config + script/hook/editor/doc wiring (no mass reformat),
   including deletion of `.idea/biome.xml`.
2. Repository-wide oxfmt (and any lint fixes required for green `check`).

## Acceptance

- No `@biomejs/biome` dependency; no `biome.json`; no `.idea/biome.xml`.
- `bun run check` uses `oxlint .` and `oxfmt --check .` only, with scope
  controlled by ignore patterns (not a narrow allowlist).
- Pre-commit and VS Code format/lint path no longer reference Biome.
- Agent docs describe Oxc gates.
- Every non-ignored, oxfmt-supported file formats cleanly under the new oxfmt
  config (including Tailwind class sorting for `cn` / `cva` where applicable).
- Historical plans under `.omo/` and `docs/superpowers/plans/` are not
  rewritten by the migration format pass.
- `max-lines` warn at 300 remains enforced by oxlint.

## Follow-ups (out of scope)

- Evaluate oxlint `--type-aware` + `typescript/no-deprecated` with a local
  timing measurement on this monorepo.
- Optional: broader Tailwind lint via `oxlint-tailwindcss` if product wants
  unknown-class / conflict checks beyond sorting.
- Optional: checked-in JetBrains Oxc/oxfmt project settings if the team wants
  shared IDE wiring beyond deleting Biome.
