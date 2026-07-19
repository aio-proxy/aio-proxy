# Biome → Oxlint + Oxfmt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Biome with oxlint + oxfmt across dependencies, configs, scripts, hooks, editors, and agent docs, then reformat every non-ignored oxfmt-supported file.

**Architecture:** Keep Biome long enough to run `oxfmt --migrate biome`, hand-author `.oxlintrc.json` on oxlint correctness defaults plus `max-lines`, drive continuous gates with `oxlint .` and `oxfmt --check .` via ignore patterns, then delete all Biome surfaces and run one repository-wide `oxfmt .`.

**Tech Stack:** Bun workspaces, oxlint, oxfmt, lefthook, VS Code / Cursor (`oxc.oxc-vscode`), JetBrains tracked `.idea` cleanup.

## Global Constraints

- Design reference: `docs/superpowers/specs/2026-07-19-biome-to-oxc-design.md`.
- Follow `AGENTS.md` and `packages/dashboard/AGENTS.md`.
- Do not enable oxlint type-aware linting or add `oxlint-tsgolint`.
- Do not add ESLint, Prettier, or `oxlint-tailwindcss`.
- Do not rewrite `.omo/**` or `docs/superpowers/plans/**` (formatter-only ignores).
- Prefer two commits: (1) toolchain wiring without mass reformat, (2) repository-wide format + lint green.
- Run commands from the repository root.
- Only create git commits when the human explicitly asks, or when executing a plan step that includes a commit after the human has approved execution of this plan.

## File map

- Create: `.oxfmtrc.json` — formatter config from migrate + Tailwind/import sorting + ignores.
- Create: `.oxlintrc.json` — correctness defaults, `max-lines`, ui lint ignore, shared ignores.
- Create: `.vscode/extensions.json` — recommend `oxc.oxc-vscode`.
- Modify: `package.json` — deps + `check` / `format` scripts.
- Modify: `bun.lock` — lockfile after dependency change.
- Modify: `lefthook.yml` — oxlint/oxfmt pre-commit.
- Modify: `.vscode/settings.json` — Oxc formatter on save.
- Modify: `AGENTS.md`, `CLAUDE.md` — completion gate wording.
- Delete: `biome.json`, `.idea/biome.xml`.
- Modify (task 3): any files oxfmt rewrites; remove obsolete `biome-ignore` comments in dashboard sources.

---

### Task 1: Install Oxc tools and author configs

**Files:**

- Create: `.oxfmtrc.json`
- Create: `.oxlintrc.json`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**

- Consumes: existing `biome.json` (must still exist for `--migrate biome`).
- Produces: committed Oxc configs that `oxlint .` and `oxfmt --check .` can load; root deps `oxlint` and `oxfmt` present; `@biomejs/biome` still present until Task 2 deletes Biome surfaces.

- [ ] **Step 1: Add oxlint and oxfmt without removing Biome yet**

Run:

```bash
bun add -D oxlint oxfmt
```

Expected: `package.json` `devDependencies` includes `oxlint` and `oxfmt`; `bun.lock` updates; `@biomejs/biome` still listed.

- [ ] **Step 2: Migrate formatter config from Biome**

Run:

```bash
bunx oxfmt --migrate biome
```

Expected: creates `.oxfmtrc.json`. If the command refuses because a target already exists, delete only a partial `.oxfmtrc.json` you just created and re-run — do not delete `biome.json` yet.

- [ ] **Step 3: Finalize `.oxfmtrc.json`**

Open `.oxfmtrc.json` and ensure all of the following are present after migrate (merge manually; keep migrate-produced print/indent values if they already match):

```json
{
  "printWidth": 120,
  "tabWidth": 2,
  "useTabs": false,
  "sortImports": {
    "groups": [
      "type-import",
      ["value-builtin", "value-external"],
      "type-internal",
      "value-internal",
      ["type-parent", "type-sibling", "type-index"],
      ["value-parent", "value-sibling", "value-index"],
      "unknown"
    ]
  },
  "sortTailwindcss": {
    "stylesheet": "packages/dashboard/src/styles.css",
    "functions": ["cn", "cva"]
  },
  "ignorePatterns": [
    "**/dist/**",
    ".reference/**",
    ".worktrees/**",
    "packages/core/src/db/migrations.manifest.ts",
    "packages/dashboard/src/route-tree.gen.ts",
    "packages/i18n/project.inlang/.meta.json",
    "packages/i18n/src/paraglide/**",
    ".omo/**",
    "docs/superpowers/plans/**"
  ]
}
```

Notes:

- Field names from migrate may differ slightly (for example `indentWidth` vs `tabWidth`). Prefer the keys migrate emitted when they are valid oxfmt options; only add missing keys from the block above.
- Formatter-only ignores for `.omo/**` and `docs/superpowers/plans/**` are required.
- Do not put `packages/dashboard/src/components/ui/**` in formatter ignores (those files should still format).

- [ ] **Step 4: Create `.oxlintrc.json`**

Create `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "categories": {
    "correctness": "error"
  },
  "rules": {
    "eslint/max-lines": [
      "warn",
      {
        "max": 300,
        "skipBlankLines": true,
        "skipComments": false
      }
    ]
  },
  "ignorePatterns": [
    "**/dist/**",
    ".reference/**",
    ".worktrees/**",
    "packages/core/src/db/migrations.manifest.ts",
    "packages/dashboard/src/route-tree.gen.ts",
    "packages/i18n/project.inlang/.meta.json",
    "packages/i18n/src/paraglide/**",
    "packages/dashboard/src/components/ui/**"
  ]
}
```

Notes:

- Do not enable `options.typeAware`.
- Do not add `.omo/**` / `docs/superpowers/plans/**` here unless oxlint would otherwise lint those trees; they are primarily Markdown/plan paths for formatter protection.
- `packages/dashboard/src/components/ui/**` is linter-only ignore (Biome override parity).

- [ ] **Step 5: Smoke-test configs**

Run:

```bash
bunx oxlint --print-config > /tmp/oxlint-print-config.json
bunx oxfmt --check package.json
bunx oxlint package.json
```

Expected:

- `--print-config` exits 0 and shows `eslint/max-lines` configured.
- `oxfmt --check package.json` exits 0 or reports format diffs only for that file (not a config-load error).
- `oxlint package.json` exits 0 or reports rule diagnostics only (not a config-load error).

- [ ] **Step 6: Stop here for Task 1 review gate**

Do not delete Biome, do not change scripts yet, do not run repository-wide format yet.

---

### Task 2: Wire scripts, hooks, editors, docs; remove Biome surfaces

**Files:**

- Modify: `package.json` (scripts + remove `@biomejs/biome`)
- Modify: `bun.lock`
- Modify: `lefthook.yml`
- Modify: `.vscode/settings.json`
- Create: `.vscode/extensions.json`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Delete: `biome.json`
- Delete: `.idea/biome.xml`

**Interfaces:**

- Consumes: `.oxlintrc.json` and `.oxfmtrc.json` from Task 1.
- Produces: `bun run check` → `oxlint . && oxfmt --check .`; `bun run format` → `oxfmt .`; no Biome dependency or tracked Biome config files.

- [ ] **Step 1: Update root scripts and remove Biome dependency**

In `package.json`:

1. Replace the `check` script with:

```json
"check": "oxlint . && oxfmt --check .",
"format": "oxfmt ."
```

2. Remove `@biomejs/biome` from `devDependencies`.

3. Keep `preflight` calling `bun run check` first (no other preflight rewrite required).

Run:

```bash
bun install
```

Expected: lockfile no longer contains `@biomejs/biome`; `oxlint` and `oxfmt` remain.

- [ ] **Step 2: Replace lefthook Biome command**

Replace the `biome` pre-commit command block in `lefthook.yml` with:

```yml
pre-commit:
  commands:
    oxlint:
      glob: "*.{js,ts,cjs,mjs,d.cts,d.mts,jsx,tsx}"
      run: bunx oxlint --fix --no-error-on-unmatched-pattern {staged_files}
      stage_fixed: true
    oxfmt:
      glob: "*.{js,ts,cjs,mjs,d.cts,d.mts,jsx,tsx,json,jsonc,css}"
      run: bunx oxfmt --no-error-on-unmatched-pattern {staged_files}
      stage_fixed: true
    bun-check:
      glob: "bun.lock"
      run: bun run scripts/bun-lock-check.ts
```

Keep the existing `commit-msg` / commitlint block unchanged.

- [ ] **Step 3: Switch VS Code / Cursor settings to Oxc**

Replace `.vscode/settings.json` contents with:

```json
{
  "js/ts.tsdk.path": "node_modules/typescript/lib",
  "oxc.fmt.configPath": ".oxfmtrc.json",
  "editor.defaultFormatter": "oxc.oxc-vscode",
  "editor.formatOnSave": true,
  "[typescript]": {
    "editor.defaultFormatter": "oxc.oxc-vscode",
    "editor.formatOnSave": true
  },
  "[typescriptreact]": {
    "editor.defaultFormatter": "oxc.oxc-vscode",
    "editor.formatOnSave": true
  },
  "[javascript]": {
    "editor.defaultFormatter": "oxc.oxc-vscode",
    "editor.formatOnSave": true
  },
  "[javascriptreact]": {
    "editor.defaultFormatter": "oxc.oxc-vscode",
    "editor.formatOnSave": true
  },
  "[json]": {
    "editor.defaultFormatter": "oxc.oxc-vscode",
    "editor.formatOnSave": true
  },
  "[jsonc]": {
    "editor.defaultFormatter": "oxc.oxc-vscode",
    "editor.formatOnSave": true
  },
  "files.readonlyInclude": {
    "**/route-tree.gen.ts": true
  },
  "files.watcherExclude": {
    "**/route-tree.gen.ts": true
  },
  "search.exclude": {
    "**/route-tree.gen.ts": true
  },
  "tailwindCSS.classAttributes": ["class", "className"],
  "tailwindCSS.classFunctions": ["cn", "cva"]
}
```

Create `.vscode/extensions.json`:

```json
{
  "recommendations": ["oxc.oxc-vscode"]
}
```

- [ ] **Step 4: Delete Biome config surfaces**

Delete:

- `biome.json`
- `.idea/biome.xml`

Verify:

```bash
test ! -f biome.json
test ! -f .idea/biome.xml
rg -n "@biomejs/biome|biome check|biomejs\\.biome" package.json lefthook.yml .vscode AGENTS.md CLAUDE.md || true
```

Expected: both files gone; no remaining Biome wiring in those live surfaces (historical plans may still mention Biome and must not be edited).

- [ ] **Step 5: Update agent docs**

In `AGENTS.md` and `CLAUDE.md`, replace the completion-gate sentence that mentions biome with:

```markdown
- Before considering a change complete, run `bun run preflight` (oxlint + oxfmt check + all unit tests), or at minimum `bun run check` plus the affected package's tests.
```

Do not edit `packages/dashboard/AGENTS.md` unless it literally mentions Biome (today it does not).

- [ ] **Step 6: Verify wiring without requiring a green full format yet**

Run:

```bash
bun run check
```

Expected at this stage:

- Commands resolve (`oxlint` / `oxfmt` found).
- Likely non-zero exit because the tree is not yet reformatted and/or lint issues remain.
- Must not fail with “biome: command not found” or missing config errors.
- Confirm ignored plan paths are excluded from format consideration:

```bash
bunx oxfmt --check docs/superpowers/plans/2026-07-18-dev-task-model.md; echo exit:$?
```

Expected: unmatched/ignored behavior (no rewrite requirement for that historical plan file). Exact message may be “No files found” / ignored; exit must not demand formatting that file.

- [ ] **Step 7: Commit toolchain wiring (only if the human asked to commit / approved plan execution commits)**

```bash
git add package.json bun.lock .oxlintrc.json .oxfmtrc.json lefthook.yml .vscode/settings.json .vscode/extensions.json AGENTS.md CLAUDE.md
git add -u biome.json .idea/biome.xml
git commit -m "$(cat <<'EOF'
chore: replace Biome with oxlint and oxfmt tooling

EOF
)"
```

---

### Task 3: Repository-wide format and lint cleanup

**Files:**

- Modify: whatever non-ignored oxfmt-supported files `oxfmt .` rewrites
- Modify: `packages/dashboard/src/modules/providers/templates/providers-page.tsx`
- Modify: `packages/dashboard/src/components/data-table-pagination/data-table-pagination.tsx`
- Modify: any additional sources needed for `oxlint .` to pass

**Interfaces:**

- Consumes: Task 2 scripts (`bun run format`, `bun run check`).
- Produces: `bun run check` exits 0; historical plans untouched.

- [ ] **Step 1: Snapshot that historical plans are unchanged before format**

Run:

```bash
git status --short .omo docs/superpowers/plans | head
```

Expected: clean for those trees (or only unrelated pre-existing edits). Record the output.

- [ ] **Step 2: Run repository-wide format**

Run:

```bash
bun run format
```

Expected: oxfmt rewrites non-ignored supported files under the repo root (including `packages/`, `scripts/`, `npm/` as applicable). Completes without config errors.

- [ ] **Step 3: Confirm historical plans were not rewritten**

Run:

```bash
git status --short .omo docs/superpowers/plans | head
```

Expected: still no format-driven changes under those paths.

- [ ] **Step 4: Remove obsolete Biome suppressions**

In these two files, delete the `// biome-ignore ...` comments (keep the JSX/`key={index}` code). With correctness-only oxlint and react plugin off by default, `react/no-array-index-key` is not enabled, so the suppressions are dead:

- `packages/dashboard/src/modules/providers/templates/providers-page.tsx`
- `packages/dashboard/src/components/data-table-pagination/data-table-pagination.tsx`

If Task 3 later enables a rule that flags these lines, restore an oxlint-disable comment for that exact rule instead of reintroducing Biome syntax.

- [ ] **Step 5: Fix remaining oxlint failures**

Run:

```bash
bunx oxlint .
```

For each error:

1. Prefer a minimal code fix that preserves behavior.
2. Use `// oxlint-disable-next-line <rule>` only when the former Biome ignore intent still applies.
3. Do not weaken `.oxlintrc.json` categories to silence issues.
4. `max-lines` is warn-only; do not mass-split files in this task unless an error (not warn) blocks the gate.

Re-run until `oxlint .` exits 0 (warnings for `max-lines` are acceptable unless the command is later run with `--deny-warnings`; default check must not pass `--deny-warnings`).

- [ ] **Step 6: Green check**

Run:

```bash
bun run check
```

Expected: exit 0 from both `oxlint .` and `oxfmt --check .`.

- [ ] **Step 7: Commit format + lint cleanup (only if the human asked to commit / approved plan execution commits)**

```bash
git add -A
git status --short .omo docs/superpowers/plans
git commit -m "$(cat <<'EOF'
style: apply oxfmt across the repository

EOF
)"
```

Before committing, confirm `git status --short .omo docs/superpowers/plans` shows no plan rewrites. Unstage any accidental plan changes if present.

---

### Task 4: Final verification

**Files:**

- None required unless verification fails and needs a fix follow-up.

**Interfaces:**

- Consumes: green `bun run check` from Task 3.
- Produces: acceptance evidence for the design doc.

- [ ] **Step 1: Prove Biome surfaces are gone**

Run:

```bash
test ! -f biome.json
test ! -f .idea/biome.xml
rg -n "@biomejs/biome" package.json bun.lock || true
```

Expected: no `biome.json`, no `.idea/biome.xml`, no `@biomejs/biome` in package metadata/lockfile.

- [ ] **Step 2: Prove ignore-driven format scope**

Run:

```bash
bunx oxfmt --check .
bunx oxfmt --check docs/superpowers/plans >/tmp/oxfmt-plans.txt 2>&1; echo exit:$?
```

Expected: root `--check .` exits 0; plans path does not require formatting historical Markdown (ignored / no files).

- [ ] **Step 3: Run preflight**

Run:

```bash
bun run preflight
```

Expected: exit 0. If preflight fails for unrelated flaky tests, re-run once; if still failing, fix only failures caused by this migration (format/lint/import order). Do not expand scope into unrelated product bugs.

- [ ] **Step 4: Acceptance checklist**

Confirm each design acceptance item:

- [ ] No `@biomejs/biome`, no `biome.json`, no `.idea/biome.xml`
- [ ] `bun run check` is `oxlint . && oxfmt --check .`
- [ ] lefthook + VS Code no longer reference Biome
- [ ] `AGENTS.md` / `CLAUDE.md` mention oxlint + oxfmt
- [ ] Non-ignored oxfmt-supported files check clean
- [ ] `.omo/` and `docs/superpowers/plans/` were not rewritten
- [ ] `eslint/max-lines` warn at 300 remains in `.oxlintrc.json`

---

## Spec coverage self-review

| Spec requirement | Task |
| --- | --- |
| Remove Biome dependency + `biome.json` | Task 2 |
| Delete `.idea/biome.xml` | Task 2 |
| `.oxfmtrc.json` via migrate + style parity | Task 1 |
| `sortTailwindcss` for `cn`/`cva` | Task 1 |
| `sortImports` for former organizeImports | Task 1 |
| Formatter-only ignores for `.omo/**` and plans | Task 1, verified Task 3/4 |
| `.oxlintrc.json` correctness + `max-lines` | Task 1 |
| ui components lint ignored | Task 1 |
| No type-aware | Task 1 constraint |
| `check` / `format` use `.` + ignores | Task 2 |
| lefthook oxlint/oxfmt | Task 2 |
| VS Code Oxc settings + extensions recommendation | Task 2 |
| Agent docs gate wording | Task 2 |
| Repository-wide oxfmt of non-ignored files | Task 3 |
| Remove/replace `biome-ignore` | Task 3 |
| `bun run check` / `preflight` green | Task 3–4 |
| Two-commit preference | Task 2 + Task 3 commit steps |

## Placeholder scan

No TBD/TODO steps. Commands and target file contents are explicit. Commit steps are gated on human approval per repo commit rules.
