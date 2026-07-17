# OAuth Plugin Main Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring PR #29 onto current `main`, replace the stale ChatGPT model list with the Codex bundled catalog, and make every touched handwritten file comply with the new 300-line and Dashboard conventions without changing OAuth behavior.

**Architecture:** Rebase first so all work targets the actual merge result. Keep the model catalog as a small TTL-backed plugin concern, use Bun's native colocated test discovery, and split oversized modules only along responsibilities already present in the code. Preserve public import paths with directory `index.ts` entry points and avoid new dependencies or speculative abstractions.

**Tech Stack:** Bun 1.3.14, TypeScript 6, Bun Test, Rstest for Dashboard only, Zod 4 via `@aio-proxy/plugin-sdk`, es-toolkit 1.49, React, TanStack Form/Table/Query, SQLite, Hono.

## Global Constraints

- Rebase onto current `origin/main` before editing; PR #29 currently conflicts with `main`.
- `DashboardProviderSummary`, `DashboardPluginSummary`, `Diagnostic`, and other shared DTOs remain imported from `@aio-proxy/types`; do not redeclare them in Dashboard.
- Dashboard Hono route and client contracts come from the typed client exported by `@aio-proxy/server`.
- Fetch ChatGPT models from `https://github.com/openai/codex/raw/refs/heads/main/codex-rs/models-manager/models.json`.
- Include every model with `supported_in_api: true`, including `visibility: "hide"`; do not special-case `codex-auto-review`.
- ChatGPT catalog policy is TTL with `ttlMs = 6 * 60 * 60_000`; the host owns persistence, stale reuse, timeout, and retry.
- Do not add Rstest to core, CLI, server, plugin SDK, or built-in plugin packages. Use Bun Test and colocated `*.test.ts` files.
- Every new or materially changed handwritten code or test file must remain at or below 300 lines; evaluate splitting at 240 lines.
- Preserve current public exports, error classes, diagnostics, transaction ordering, lock fencing, and runtime behavior during file moves.
- Use narrow `es-toolkit` imports; do not use `es-toolkit/compat` without lodash compatibility requirements.
- Do not manually edit files under `packages/dashboard/src/components/ui/`.
- Run `bun run check` and affected tests before each commit.
- Every commit appends `Co-authored-by: Codex <noreply@openai.com>`.

---

### Task 1: Rebase onto Main and Correct the Dashboard Contract Wording

**Files:**
- Modify during conflict resolution: `AGENTS.md`
- Modify: `packages/dashboard/AGENTS.md`
- Resolve if conflicted: `bun.lock`
- Resolve if conflicted: `packages/i18n/messages/en.json`
- Resolve if conflicted: `packages/i18n/messages/zh-Hans.json`
- Resolve if conflicted: `packages/server/package.json`
- Resolve if conflicted: `packages/server/src/dashboard-routes/config.ts`
- Resolve if conflicted: `packages/server/_test/dashboard-provider-options-schema.test.ts`

**Interfaces:**
- Consumes: `origin/main` at or after merge commit `0ec1be2`.
- Produces: a conflict-free branch containing both OAuth plugin work and current provider-options/dashboard standards.

- [ ] **Step 1: Fetch and record the rebase point**

```bash
rtk git fetch origin main
rtk git rev-parse origin/main
rtk git status --short --branch
```

Expected: `origin/main` resolves to `0ec1be2` or a newer commit; the worktree is clean.

- [ ] **Step 2: Rebase and resolve conflicts by retaining both features**

```bash
rtk git rebase origin/main
```

Resolve conflicts with these rules:

- `AGENTS.md`: retain all current-main coding standards and routing rules.
- `packages/dashboard/AGENTS.md`: retain current-main Dashboard rules, then replace the ambiguous API-type sentence with the exact two bullets in Step 3.
- `packages/server/src/dashboard-routes/config.ts`: keep main's local provider-options schema route behavior and the PR's OAuth plugin/provider mutation behavior.
- i18n JSON: keep keys from both sides; do not duplicate or rename existing message keys.
- package manifests: keep both dependency sets and use `"catalog:"` for catalog-managed dependencies.
- `bun.lock`: do not hand-merge; after manifests are resolved, regenerate with `rtk bun install`.

Continue until complete:

```bash
rtk git add -A
rtk git rebase --continue
```

Expected: `rtk git status --short` reports no unmerged paths.

- [ ] **Step 3: Make the Dashboard API contract wording precise**

Replace the existing `Shared API types...` bullet in `packages/dashboard/AGENTS.md` with:

```markdown
- Dashboard API route and client types must come from the typed Hono client exported by `@aio-proxy/server`.
- Shared domain models and DTOs may be imported from `@aio-proxy/types`; do not redeclare them in the dashboard.
```

- [ ] **Step 4: Verify the rebased baseline**

```bash
rtk bun install
rtk bun run check
rtk bun run --filter @aio-proxy/server test:unit
rtk bun run --filter @aio-proxy/dashboard test:unit
```

Expected: dependency installation, static checks, server tests, and Dashboard tests pass before new behavior is added.

- [ ] **Step 5: Commit the wording correction if it is not part of a rebased commit**

```bash
rtk git add packages/dashboard/AGENTS.md bun.lock
rtk git commit -m "docs: clarify dashboard api type boundaries" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Replace the ChatGPT Fixed Catalog with the Codex Bundled Catalog

**Files:**
- Create: `packages/plugins/openai-chatgpt/src/catalog.ts`
- Create: `packages/plugins/openai-chatgpt/src/catalog.test.ts`
- Create: `packages/plugins/openai-chatgpt/src/plugin.ts`
- Modify: `packages/plugins/openai-chatgpt/src/index.ts`
- Modify: `packages/plugins/openai-chatgpt/src/jwt.ts`
- Modify: `packages/plugins/openai-chatgpt/_test/adapter.test.ts`
- Modify: `docs/superpowers/specs/2026-07-14-oauth-plugin-system-design.md`
- Modify: `docs/superpowers/plans/2026-07-14-oauth-plugin-system.md`

**Interfaces:**
- Produces: `CHATGPT_CATALOG_TTL_MS`, `CODEX_MODELS_URL`, and `discoverOpenAIChatGPTModels(signal): Promise<readonly ModelDescriptor[]>`.
- Preserves: default export and named exports from `@aio-proxy/plugin-openai-chatgpt`.

- [ ] **Step 1: Write the failing colocated catalog test**

Add `packages/plugins/openai-chatgpt/src/catalog.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { CHATGPT_CATALOG_TTL_MS, discoverOpenAIChatGPTModels } from "./catalog";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("keeps supported visible and hidden Codex models in priority order", async () => {
  globalThis.fetch = async () =>
    Response.json({
      models: [
        { slug: "hidden", display_name: "Hidden", priority: 2, supported_in_api: true, visibility: "hide" },
        { slug: "unsupported", display_name: "Unsupported", priority: 0, supported_in_api: false, visibility: "list" },
        { slug: "visible", display_name: "Visible", priority: 1, supported_in_api: true, visibility: "list" },
      ],
    });

  await expect(discoverOpenAIChatGPTModels(new AbortController().signal)).resolves.toEqual([
    { id: "visible", displayName: "Visible" },
    { id: "hidden", displayName: "Hidden" },
  ]);
  expect(CHATGPT_CATALOG_TTL_MS).toBe(6 * 60 * 60_000);
});
```

- [ ] **Step 2: Verify RED**

```bash
rtk bun test packages/plugins/openai-chatgpt/src/catalog.test.ts
```

Expected: FAIL because `catalog.ts` does not exist.

- [ ] **Step 3: Implement the minimal raw catalog client**

Create `packages/plugins/openai-chatgpt/src/catalog.ts`:

```ts
import { type ModelDescriptor, zod } from "@aio-proxy/plugin-sdk";
import { filter, map, pipe, sortBy } from "es-toolkit/fp";

export const CODEX_MODELS_URL =
  "https://github.com/openai/codex/raw/refs/heads/main/codex-rs/models-manager/models.json";
export const CHATGPT_CATALOG_TTL_MS = 6 * 60 * 60_000;

const CodexModelsSchema = zod.object({
  models: zod.array(
    zod.object({
      slug: zod.string().min(1),
      display_name: zod.string().min(1),
      priority: zod.number(),
      supported_in_api: zod.boolean(),
      visibility: zod.string(),
    }),
  ),
});

export async function discoverOpenAIChatGPTModels(signal: AbortSignal): Promise<readonly ModelDescriptor[]> {
  const response = await fetch(CODEX_MODELS_URL, { signal });
  if (!response.ok) throw new Error(`Codex model catalog request failed with ${response.status}`);
  const { models } = CodexModelsSchema.parse(await response.json());
  return pipe(
    models,
    filter((model) => model.supported_in_api),
    sortBy([(model) => model.priority]),
    map((model) => ({ id: model.slug, displayName: model.display_name })),
  );
}
```

Do not filter `visibility`; its only purpose here is trust-boundary validation.

- [ ] **Step 4: Move descriptor construction out of the public index**

Rename the ambiguous `OpenAIChatGPTCopy`/`englishCopy` pair to
`OpenAIChatGPTPresentationText`/`englishPresentationText`, then move those exports,
`createOpenAIChatGPTPlugin`, and `buildAuthorizationUrl` into `src/plugin.ts`.
`PresentationText` means the localized labels and descriptions shown by the host;
it is not copied data or a clone operation. Replace the fixed catalog with:

```ts
catalog: {
  policy: { kind: "ttl", ttlMs: CHATGPT_CATALOG_TTL_MS },
  discover: async ({ signal }) => ({
    language: await discoverOpenAIChatGPTModels(signal),
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  }),
},
```

Keep `src/index.ts` limited to exports and default construction:

```ts
import packageJson from "../package.json" with { type: "json" };
import { createOpenAIChatGPTPlugin, englishPresentationText } from "./plugin";

export { CHATGPT_CATALOG_TTL_MS, CODEX_MODELS_URL } from "./catalog";
export {
  createOpenAIChatGPTPlugin,
  englishPresentationText,
  type OpenAIChatGPTPresentationText,
} from "./plugin";
export type { ChatGPTCredential } from "./schema";

export const OPENAI_CHATGPT_PLUGIN_VERSION = packageJson.version;

export default createOpenAIChatGPTPlugin(englishPresentationText);
```

- [ ] **Step 5: Remove the unjustified compat import**

In `src/jwt.ts`, replace:

```ts
import { isPlainObject } from "es-toolkit/compat";
```

with:

```ts
import { isPlainObject } from "es-toolkit/predicate";
```

- [ ] **Step 6: Update adapter tests and design documents**

Change the adapter test to stub `fetch`, expect the fetched language catalog, and assert:

```ts
expect(adapter.catalog.policy).toEqual({ kind: "ttl", ttlMs: 6 * 60 * 60_000 });
```

Replace statements describing a fixed/static ChatGPT catalog with the raw Codex catalog, six-hour TTL, and inclusion of hidden API-supported models.

- [ ] **Step 7: Verify GREEN**

```bash
rtk bun test packages/plugins/openai-chatgpt/src/catalog.test.ts packages/plugins/openai-chatgpt/_test/adapter.test.ts
rtk bun run --filter @aio-proxy/plugin-openai-chatgpt build
```

Expected: tests and package build pass; no fixed `OPENAI_CHATGPT_MODELS` constant remains.

- [ ] **Step 8: Commit**

```bash
rtk git add packages/plugins/openai-chatgpt docs/superpowers/specs/2026-07-14-oauth-plugin-system-design.md docs/superpowers/plans/2026-07-14-oauth-plugin-system.md
rtk git commit -m "fix(chatgpt): load codex model catalog" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Make Dashboard Controls and Test Components Match the New Rules

**Files:**
- Modify: `packages/dashboard/src/components/data-table-toolbar.tsx`
- Modify: `packages/dashboard/src/components/data-table-toolbar.test.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/provider-state-cell.test.tsx`
- Modify: `packages/dashboard/src/modules/providers/templates/providers-page.test.tsx`
- Create: `packages/dashboard/src/modules/providers/test-doubles.ts`

**Interfaces:**
- Preserves: `DataTableToolbar` props and TanStack Table behavior.
- Produces: TanStack Form ownership for both global filtering and column visibility.

- [ ] **Step 1: Add a failing column-visibility form assertion**

Extend `data-table-toolbar.test.tsx` so toggling a menu checkbox closes and reopens the menu, then verifies the checked state remains synchronized with the table. Spy on `table.setGlobalFilter` only for the text field; the checkbox must update through a TanStack Form field before calling `column.toggleVisibility`.

```ts
fireEvent.click(visibleItem);
fireEvent.click(screen.getByRole("button", { name: "Columns" }));
expect(await screen.findByRole("menuitemcheckbox", { name: "Name" })).toHaveAttribute("aria-checked", "false");
```

- [ ] **Step 2: Verify RED**

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- data-table-toolbar.test.tsx
```

Expected: FAIL after the test is changed to require form-owned visibility state.

- [ ] **Step 3: Put the visibility record in the existing TanStack Form**

Use one record field rather than one dynamically typed field per column:

```tsx
const form = useForm({
  defaultValues: {
    tableFilter: "",
    columnVisibility: { ...columnVisibility },
  },
});

<form.Field name="columnVisibility">
  {(field) =>
    table.getAllLeafColumns().map((column) => (
      <DropdownMenuCheckboxItem
        key={column.id}
        checked={field.state.value[column.id] !== false}
        onCheckedChange={(checked) => {
          field.handleChange({ ...field.state.value, [column.id]: checked });
          column.toggleVisibility(checked);
        }}
      >
        {columnLabel(column.id)}
      </DropdownMenuCheckboxItem>
    ))
  }
</form.Field>
```

Keep `DropdownMenuCheckboxItem`; it is the shadcn checkbox primitive for menu semantics. Do not add a nested standalone `Checkbox`.

- [ ] **Step 4: Remove component declarations from test `.tsx` files**

Keep the single harness in `data-table-toolbar.test.tsx`, but type it explicitly:

```tsx
import type React from "react";

const ToolbarHarness: React.FC = () => {
  const { table, columnVisibility } = useDataTable(data, columns);
  return (
    <DataTableToolbar
      table={table}
      columnVisibility={columnVisibility}
      filterId="table-filter"
      filterLabel="Filter"
      columnsLabel="Columns"
      columnLabel={columnLabel}
    />
  );
};
```

Create `modules/providers/test-doubles.ts` with typed `React.FC` exports implemented through `createElement`:

```ts
export const DeleteProviderDialogStub: React.FC = () => null;
export const RouterLinkStub: React.FC<React.AnchorHTMLAttributes<HTMLAnchorElement>> = (props) =>
  createElement("a", props);
```

Import these doubles from the two test files. Split provider-state tests away from ProvidersPage tests so each `.tsx` test file declares no local React component.

- [ ] **Step 5: Verify GREEN**

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- data-table-toolbar.test.tsx provider-state-cell.test.tsx providers-page.test.tsx
rtk bun run --filter @aio-proxy/dashboard build
```

Expected: focused tests and Dashboard build pass.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/dashboard/src/components packages/dashboard/src/modules/providers
rtk git commit -m "refactor(dashboard): align table controls with form rules" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 4: Enable Bun Colocated Tests Without Adding a Runner

**Files:**
- Modify: `packages/core/package.json`
- Modify: `packages/cli/package.json`
- Modify: `packages/server/package.json`
- Modify: `packages/plugin-sdk/package.json`
- Modify: `packages/plugins/github-copilot/package.json`
- Modify: `packages/plugins/openai-chatgpt/package.json`

**Interfaces:**
- Produces: package test scripts that discover both existing `_test/` files and new colocated `*.test.ts` files.
- Preserves: CLI and server test preload behavior.

- [ ] **Step 1: Change only the discovery scope**

Use these exact scripts:

```json
// core, plugin-sdk, built-in plugins
"test:unit": "bun test"

// cli and server
"test:unit": "bun test --preload=./_test/setup.ts"
```

Keep existing `"test": "bun run test:unit"` aliases.

- [ ] **Step 2: Verify old and colocated tests are both discovered**

```bash
rtk bun run --filter @aio-proxy/core test:unit
rtk bun run --filter @aio-proxy/cli test:unit
rtk bun run --filter @aio-proxy/server test:unit
rtk bun run --filter @aio-proxy/plugin-openai-chatgpt test:unit
```

Expected: existing `_test/` suites still run, and `src/catalog.test.ts` is included without an explicit path.

- [ ] **Step 3: Commit**

```bash
rtk git add packages/*/package.json packages/plugins/*/package.json bun.lock
rtk git commit -m "test: enable colocated bun test discovery" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 5: Split Core Locking and Config Persistence by Responsibility

**Files:**
- Create: `packages/core/src/file-lock/process-identity.ts`
- Create: `packages/core/src/file-lock/recovery-fence.ts`
- Create: `packages/core/src/plugins/config-file/index.ts`
- Create: `packages/core/src/plugins/config-file/lock.ts`
- Create: `packages/core/src/plugins/config-file/serialization.ts`
- Delete: `packages/core/src/plugins/config-file.ts`
- Modify: `packages/core/src/npm-lock.ts`
- Create: `packages/core/src/plugins/config-file/lock.test.ts`
- Create: `packages/core/src/plugins/config-file/transaction.test.ts`
- Create: `packages/core/src/npm-lock.test.ts`
- Remove moved cases from: `packages/core/_test/plugins/config-file.test.ts`
- Remove moved cases from: `packages/core/_test/npm.test.ts`

**Interfaces:**
- Preserves: `AtomicConfigFile`, `AtomicConfigCommitUncertainError`, `AtomicConfigLockReleaseError`, `digestProviderEntry`, `acquireNpmInstallLock`, and all timeout constants.
- Produces: shared process-identity and recovery-fence primitives used by both lock implementations.

- [ ] **Step 1: Record the existing behavior baseline**

```bash
rtk bun test packages/core/_test/plugins/config-file.test.ts packages/core/_test/npm.test.ts
```

Expected: PASS before moving code.

- [ ] **Step 2: Extract process identity without changing its semantics**

Move these duplicated operations from both lock files into `file-lock/process-identity.ts`:

```ts
export const PROCESS_STARTTIME_TIMEOUT = Symbol("process-starttime-timeout");
export function processIsAlive(pid: number): boolean;
export async function processStarttime(pid: number): Promise<string | null>;
export async function withinProcessStarttimeDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof PROCESS_STARTTIME_TIMEOUT>;
export async function settleProcessStarttimeCleanup(promise: Promise<unknown>, timeoutMs: number): Promise<void>;
```

Retain the existing `/proc/<pid>/stat` parsing, stdout draining, timeout values, and Windows behavior exactly once in this module.

- [ ] **Step 3: Extract recovery-marker fencing**

Move marker creation, heartbeat, stale-owner verification, and cleanup into `file-lock/recovery-fence.ts` with this interface:

```ts
export type RecoveryFence = {
  readonly assertOwned: () => Promise<void>;
  readonly close: () => Promise<void>;
};

export async function acquireRecoveryFence(input: {
  readonly lockPath: string;
  readonly staleMs: number;
  readonly heartbeatMs: number;
  readonly signal?: AbortSignal;
}): Promise<RecoveryFence>;
```

Both config and npm locking must call this module; do not retain copied marker implementations.

- [ ] **Step 4: Convert config-file into a private directory**

Move JSON parsing, stable digesting, and candidate encoding to `serialization.ts`. Move lock acquisition/reclamation to `lock.ts`. Keep `index.ts` limited to the public errors, `AtomicConfigFile`, and exports:

```ts
export { CONFIG_LOCK_HEARTBEAT_MS, CONFIG_LOCK_STALE_MS, CONFIG_LOCK_WAIT_MS } from "./lock";
export { digestProviderEntry } from "./serialization";
export class AtomicConfigFile { /* existing transaction/read/replace methods */ }
```

Preserve the import path `./plugins/config-file` through directory resolution.

- [ ] **Step 5: Reduce npm-lock to npm-specific acquisition policy**

Keep lock filename, retry count, retry delay, and exported `acquireNpmInstallLock` in `npm-lock.ts`. Import process identity and recovery fencing from `file-lock/`; remove the copied helpers.

- [ ] **Step 6: Split and colocate tests by behavior**

- `config-file/lock.test.ts`: cross-process serialization, stale owner recovery, recovery markers, heartbeat, PID reuse, replacement-owner fencing.
- `config-file/transaction.test.ts`: mode/newline preservation, verify rollback, exact-object no-op, provider digest stability.
- `npm-lock.test.ts`: only npm installation lock acquisition, retry, stale recovery, and release behavior newly added by this PR.
- Leave unrelated npm package installation/cache tests in `_test/npm.test.ts`; it must not grow beyond its pre-PR line count.

- [ ] **Step 7: Verify line limits and behavior**

```bash
rtk bun test packages/core/src/plugins/config-file packages/core/src/npm-lock.test.ts packages/core/_test/npm.test.ts
rtk proxy sh -c 'find packages/core/src/file-lock packages/core/src/plugins/config-file -name "*.ts" -exec wc -l {} +; wc -l packages/core/src/npm-lock.ts'
```

Expected: tests pass; every listed handwritten file is at most 300 lines.

- [ ] **Step 8: Commit**

```bash
rtk git add packages/core/src/file-lock packages/core/src/plugins/config-file packages/core/src/npm-lock.ts packages/core/src/npm-lock.test.ts packages/core/_test
rtk git commit -m "refactor(core): share lock recovery primitives" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 6: Split Core OAuth Account, Repository, and Loader Modules

**Files:**
- Create: `packages/core/src/plugins/account-login/index.ts`
- Create: `packages/core/src/plugins/account-login/errors.ts`
- Create: `packages/core/src/plugins/account-login/deadline.ts`
- Create: `packages/core/src/plugins/account-login/validation.ts`
- Create: `packages/core/src/plugins/account-login/login.ts`
- Create: `packages/core/src/plugins/account-login/recovery.ts`
- Delete: `packages/core/src/plugins/account-login.ts`
- Create: `packages/core/src/plugins/repository/index.ts`
- Create: `packages/core/src/plugins/repository/types.ts`
- Create: `packages/core/src/plugins/repository/rows.ts`
- Create: `packages/core/src/plugins/repository/accounts.ts`
- Create: `packages/core/src/plugins/repository/pending-operations.ts`
- Create: `packages/core/src/plugins/repository/plugin-state.ts`
- Delete: `packages/core/src/plugins/repository.ts`
- Create: `packages/core/src/plugins/loader/index.ts`
- Create: `packages/core/src/plugins/loader/descriptor.ts`
- Create: `packages/core/src/plugins/loader/candidates.ts`
- Delete: `packages/core/src/plugins/loader.ts`
- Create colocated tests under each new private directory.
- Remove moved tests from `packages/core/_test/plugins/account-login.test.ts`, `repository.test.ts`, `loader.test.ts`, and `credential-port.test.ts`.

**Interfaces:**
- Preserves every export currently re-exported by `packages/core/src/plugins/index.ts`.
- Preserves `createPluginRepository(sqlite): PluginRepository`, `loginOAuthAccount`, `deleteOAuthAccount`, `recoverPendingAccountOperations`, `loadPluginRegistry`, and `observedPromiseDeadline` signatures.

- [ ] **Step 1: Record focused baseline tests**

```bash
rtk bun test packages/core/_test/plugins/account-login.test.ts packages/core/_test/plugins/repository.test.ts packages/core/_test/plugins/loader.test.ts packages/core/_test/plugins/credential-port.test.ts
```

Expected: PASS.

- [ ] **Step 2: Split account-login around its existing phases**

- `errors.ts`: all exported account/login/catalog error classes and the private adapter error.
- `deadline.ts`: `deadlineController`, `childDeadline`, `withAbort`, authorization error preservation.
- `validation.ts`: provider-entry parsing, capability comparison, staged-write validation, login result validation, in-memory credential port.
- `login.ts`: preflight and `loginOAuthAccount` transaction only.
- `recovery.ts`: `deleteOAuthAccount`, deadline selection, orphan cleanup, and `recoverPendingAccountOperations`.
- `index.ts`: export the public constants, types, errors, and three operations.

No file may export a private helper merely to satisfy a test; tests exercise public behavior or import private collaborators only from inside the same directory.

- [ ] **Step 3: Split repository by stored aggregate**

- `types.ts`: current public snapshots, writes, pending operation types, and `PluginRepository`.
- `rows.ts`: SQLite row types plus JSON encode/decode and row-to-domain conversion.
- `accounts.ts`: account read/write/CAS/revision operations.
- `pending-operations.ts`: stage/finalize/compensate/recovery marker operations.
- `plugin-state.ts`: catalog, diagnostics, plugin secrets, and refresh lease operations.
- `index.ts`: compose the three `Pick<PluginRepository, ...>` objects with object spread and export existing public types.

Use the existing `PluginRepository` interface; do not add another repository abstraction.

- [ ] **Step 4: Split loader into descriptor validation and candidate loading**

- `descriptor.ts`: descriptor cache, import validation, `observedPromiseDeadline`, and third-party descriptor loading.
- `candidates.ts`: built-in/third-party candidate enumeration, options/secrets preparation, and failed-state construction.
- `index.ts`: public types and the `loadPluginRegistry` loop.

- [ ] **Step 5: Split tests by the same responsibilities**

Create these files, each at most 300 lines:

```text
account-login/constants-and-validation.test.ts
account-login/abort.test.ts
account-login/create.test.ts
account-login/relogin.test.ts
account-login/compensation.test.ts
account-login/recovery.test.ts
repository/accounts.test.ts
repository/pending-operations.test.ts
repository/plugin-state.test.ts
loader/descriptor.test.ts
loader/options-and-secrets.test.ts
loader/isolation.test.ts
credential-port/concurrency.test.ts
credential-port/lease-loss.test.ts
credential-port/redaction.test.ts
```

Move existing cases without rewriting fixtures unless a fixture is genuinely shared by at least two new files; shared fixtures stay in a directory-local `test-support.ts` below 300 lines.

- [ ] **Step 6: Verify behavior, exports, and line limits**

```bash
rtk bun test packages/core/src/plugins/account-login packages/core/src/plugins/repository packages/core/src/plugins/loader packages/core/src/plugins/credential-port
rtk bun run --filter @aio-proxy/core build
rtk proxy sh -c 'find packages/core/src/plugins/account-login packages/core/src/plugins/repository packages/core/src/plugins/loader -name "*.ts" -exec wc -l {} +'
```

Expected: tests/build pass; all files are at most 300 lines; imports from `@aio-proxy/core` remain unchanged.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/core/src/plugins packages/core/_test/plugins
rtk git commit -m "refactor(core): split oauth persistence responsibilities" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 7: Split CLI Plugin Commands and Colocate Their Tests

**Files:**
- Replace `packages/cli/src/plugin-commands/plugin.ts` with `packages/cli/src/plugin-commands/plugin/`.
- Replace `packages/cli/src/plugin-commands/provider-login.ts` with `packages/cli/src/plugin-commands/provider-login/`.
- Replace `packages/cli/src/plugin-commands/loopback.ts` with `packages/cli/src/plugin-commands/loopback/`.
- Replace `packages/cli/src/plugin-commands/form.ts` with `packages/cli/src/plugin-commands/form/`.
- Split and move tests from `packages/cli/_test/plugin-commands.test.ts`, `provider-plugin-login.test.ts`, `plugin-authorization.test.ts`, and `plugin-form.test.ts`.

**Interfaces:**
- Preserves all imports through `plugin-commands/plugin`, `provider-login`, `loopback`, and `form`.
- Preserves CLI errors included in `pluginErrors`, the existing provider-login error classes and
  `isProviderLoginUserError` safe-error provenance behavior, and loopback user-error classification.

- [ ] **Step 1: Run the CLI baseline**

```bash
rtk bun test packages/cli/_test/plugin-commands.test.ts packages/cli/_test/provider-plugin-login.test.ts packages/cli/_test/plugin-authorization.test.ts packages/cli/_test/plugin-form.test.ts
```

Expected: PASS.

- [ ] **Step 2: Split plugin lifecycle commands**

Create:

```text
plugin/index.ts
plugin/errors.ts
plugin/config-entry.ts
plugin/descriptor.ts
plugin/deps.ts
plugin/add.ts
plugin/configure.ts
plugin/remove.ts
```

Responsibilities:

- `errors.ts`: current plugin lifecycle errors and `pluginErrors`.
- `config-entry.ts`: entry parsing/replacement/removal and JSON comparison.
- `descriptor.ts`: descriptor import, staging, setup validation, and secret compensation.
- `deps.ts`: dependency type, default dependency construction, confirmation helpers.
- `add.ts`: `pluginAdd`.
- `configure.ts`: `pluginConfig`.
- `remove.ts`: `pluginList`, `pluginRemove`, and `pluginPrune`.
- `index.ts`: re-export public options, deps, errors, confirmation helpers, and commands.

- [ ] **Step 3: Split provider login**

Create:

```text
provider-login/index.ts
provider-login/errors.ts
provider-login/capability.ts
provider-login/deps.ts
provider-login/presentation.ts
```

Keep capability parsing/selection in `capability.ts`, dependency construction in `deps.ts`, safe error rendering in `presentation.ts`, and only `providerLogin` orchestration plus exports in `index.ts`.

- [ ] **Step 4: Split loopback and form helpers**

Create:

```text
loopback/index.ts
loopback/errors.ts
loopback/callback.ts
form/index.ts
form/errors.ts
form/json.ts
```

- `loopback/callback.ts`: request validation, redirect URI construction, callback parsing.
- `loopback/index.ts`: Bun listener lifecycle and `runLoopbackAuthorization`.
- `form/json.ts`: inert JSON validation/cloning/equality and compatible defaults.
- `form/index.ts`: prompt traversal and `renderConfigSpec`.

- [ ] **Step 5: Colocate tests by command/concern**

Create files at most 300 lines:

```text
plugin/add.test.ts
plugin/configure.test.ts
plugin/remove.test.ts
plugin/descriptor-security.test.ts
provider-login/capability.test.ts
provider-login/presentation.test.ts
provider-login/login.test.ts
loopback/device-code.test.ts
loopback/callback.test.ts
loopback/server.test.ts
form/render.test.ts
form/secrets.test.ts
form/json.test.ts
```

Keep shared dependency builders in a directory-local `test-support.ts`. Do not create a repository-wide test utility.

- [ ] **Step 6: Verify CLI behavior and binary compilation**

```bash
rtk bun run --filter @aio-proxy/cli test:unit
rtk bun run --filter @aio-proxy/cli build:binary
rtk proxy sh -c 'find packages/cli/src/plugin-commands -name "*.ts" -exec wc -l {} +'
```

Expected: all CLI tests pass, the binary builds, and all files are at most 300 lines.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/cli/src/plugin-commands packages/cli/_test
rtk git commit -m "refactor(cli): split plugin command responsibilities" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 8: Split Server Runtime, State, Pipeline, and Integration Tests

**Files:**
- Replace `packages/server/src/plugin-runtime.ts` with `packages/server/src/plugin-runtime/`.
- Replace `packages/server/src/server-state.ts` with `packages/server/src/server-state/`.
- Replace `packages/server/src/routes/pipeline.ts` with `packages/server/src/routes/pipeline/`.
- Split `packages/server/_test/plugin-runtime.test.ts`.
- Split `packages/server/_test/plugin-snapshot.test.ts`.
- Split `packages/server/_test/catalog-scheduler.test.ts`.
- Split `packages/server/_test/account-removal.test.ts`.
- Extract PR-added cases from oversized modified server test files.

**Interfaces:**
- Preserves: `materializePluginProvider`, `pluginOptionsIdentityDigest`, `validatePluginProtocolMap`, `createServerState`, `createModelsDevCatalogTask`, and `handleProtocolRequest`.
- Preserves: the single candidate loop in `routes/pipeline` and capability-based routing required by root `AGENTS.md`.

- [ ] **Step 1: Run the server baseline**

```bash
rtk bun test packages/server/_test/plugin-runtime.test.ts packages/server/_test/plugin-snapshot.test.ts packages/server/_test/catalog-scheduler.test.ts packages/server/_test/account-removal.test.ts packages/server/_test/pipeline.test.ts packages/server/_test/config-store.test.ts
```

Expected: PASS.

- [ ] **Step 2: Split plugin runtime by pure concern**

Create:

```text
plugin-runtime/index.ts
plugin-runtime/types.ts
plugin-runtime/identity.ts
plugin-runtime/catalog.ts
plugin-runtime/capabilities.ts
plugin-runtime/materialize.ts
```

- `identity.ts`: stable serialization, digests, runtime identity.
- `catalog.ts`: catalog diagnostics/freshness/metadata.
- `capabilities.ts`: raw/model capability wrapping and routing config.
- `materialize.ts`: provider materialization state machine.
- `index.ts`: public exports and protocol-map validation.

- [ ] **Step 3: Split server state by lifecycle**

Create:

```text
server-state/index.ts
server-state/types.ts
server-state/snapshot.ts
server-state/reload.ts
server-state/recovery.ts
server-state/probe.ts
```

- `snapshot.ts`: `Snapshot`, provider summaries, `buildSnapshot`, `buildSnapshotWithProviders`, empty plugin snapshot.
- `reload.ts`: reload transaction staging, compensation, finalization, and protocol-independent failure logging.
- `recovery.ts`: recovery scheduler/timer and pending-operation scheduling.
- `probe.ts`: status merge and provider probe.
- `index.ts`: `createServerState`, DB opening, public types, and lightweight orchestration.

- [ ] **Step 4: Split the protocol pipeline without creating a second candidate loop**

Create:

```text
routes/pipeline/index.ts
routes/pipeline/attempt.ts
routes/pipeline/failure.ts
routes/pipeline/stream.ts
routes/pipeline/request.ts
```

- `index.ts`: `handleProtocolRequest` and the only call into `attemptCandidates`.
- `attempt.ts`: the sole candidate loop and attempt base construction.
- `failure.ts`: fallback status and final protocol-shaped failures.
- `stream.ts`: response retention and stream preflight.
- `request.ts`: content-length validation.

Do not move candidate iteration into adapters or route registration files.

- [ ] **Step 5: Split new server tests by lifecycle boundary**

Create files at most 300 lines:

```text
plugin-runtime/identity.test.ts
plugin-runtime/catalog.test.ts
plugin-runtime/capabilities.test.ts
plugin-runtime/diagnostics.test.ts
plugin-runtime/materialize.test.ts
plugin-snapshot/test-support.ts
plugin-snapshot/lease.test.ts
plugin-snapshot/reload.test.ts
plugin-snapshot/isolation.test.ts
plugin-snapshot/catalog.test.ts
plugin-snapshot/recovery.test.ts
catalog-scheduler/lifecycle.test.ts
catalog-scheduler/failure.test.ts
account-removal/staging.test.ts
account-removal/finalize.test.ts
account-removal/races.test.ts
```

For existing oversized test files modified by this PR, move only the PR-added cases into focused colocated files so the original file returns to its pre-PR size or smaller:

```text
server-reload.oauth.test.ts
dashboard-providers-mutation.oauth.test.ts
config-store.oauth.test.ts
pipeline.oauth.test.ts
pipeline-helpers.oauth.test.ts
```

Apply the same rule to `packages/types/_test/schemas.test.ts`: move OAuth plugin schema cases to `packages/types/src/plugin.test.ts` instead of splitting unrelated legacy schema coverage.

- [ ] **Step 6: Verify server behavior and line limits**

```bash
rtk bun run --filter @aio-proxy/server test:unit
rtk bun x tsc --noEmit -p packages/server/tsconfig.json
rtk bun run --filter @aio-proxy/types test:unit
rtk proxy sh -c 'find packages/server/src/plugin-runtime packages/server/src/server-state packages/server/src/routes/pipeline -name "*.ts" -exec wc -l {} +'
```

Expected: all tests/typechecks pass; every new file is at most 300 lines; route files still contain no provider-kind branching or fallback loops.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/server packages/types
rtk git commit -m "refactor(server): split plugin runtime lifecycle" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 9: Split the GitHub Copilot Adapter and Its Tests

**Files:**
- Replace `packages/plugins/github-copilot/src/github-api.ts` with `packages/plugins/github-copilot/src/github-api/`.
- Create: `packages/plugins/github-copilot/src/plugin.ts`
- Modify: `packages/plugins/github-copilot/src/index.ts`
- Split `packages/plugins/github-copilot/_test/github-copilot.test.ts` into colocated tests.

**Interfaces:**
- Preserves: `GitHubAccountOptions`, `GitHubCopilotCredential`, `loginToGitHubCopilot`, `discoverGitHubCopilotModels`, `currentGitHubCopilotCredential`, `fetchCopilotToken`, URL helpers, and default plugin export.

- [ ] **Step 1: Run the current plugin tests**

```bash
rtk bun run --filter @aio-proxy/plugin-github-copilot test:unit
```

Expected: PASS.

- [ ] **Step 2: Split GitHub API responsibilities**

Create:

```text
github-api/index.ts
github-api/types.ts
github-api/http.ts
github-api/login.ts
github-api/credential.ts
github-api/catalog.ts
github-api/urls.ts
```

- `http.ts`: `fetchJson` and headers.
- `login.ts`: device code request/poll and `loginToGitHubCopilot`.
- `credential.ts`: token fetch/refresh/current credential and expiry calculation.
- `catalog.ts`: model entry/protocol mapping and model discovery.
- `urls.ts`: enterprise normalization and API/base URL construction.
- `index.ts`: public exports only.

- [ ] **Step 3: Move descriptor construction out of the package index**

Rename `GitHubCopilotCopy`/`englishCopy` to
`GitHubCopilotPresentationText`/`englishPresentationText`. Move those localized
presentation fields, schema/form construction, adapter creation, and
`createGitHubCopilotPlugin` to `src/plugin.ts`. Keep `src/index.ts` to exports,
package version, TTL constant, and default plugin construction.

- [ ] **Step 4: Colocate tests**

Create:

```text
plugin.test.ts
github-api/login.test.ts
github-api/credential.test.ts
github-api/catalog.test.ts
github-api/urls.test.ts
```

Move existing cases by describe block. Keep fixtures directory-local and below 300 lines.

- [ ] **Step 5: Verify and commit**

```bash
rtk bun run --filter @aio-proxy/plugin-github-copilot test:unit
rtk bun run --filter @aio-proxy/plugin-github-copilot build
rtk proxy sh -c 'find packages/plugins/github-copilot/src -name "*.ts" -exec wc -l {} +'
rtk git add packages/plugins/github-copilot
rtk git commit -m "refactor(copilot): split adapter responsibilities" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 10: Run Final Verification

**Files:**
- Modify tests only: split every touched handwritten test file over 300 lines into directly discovered concern files.
- Modify: `.superpowers/sdd/task-10-brief.md`
- Modify: `.superpowers/sdd/task-10-report.md`
- Modify: `docs/superpowers/plans/2026-07-17-oauth-plugin-main-compliance.md`
- Carry forward: tracked `.superpowers/sdd/task-4-report.md`, an intentional
  earlier-task correction already present when Task 10 began.
- No production files.

**Interfaces:**
- Confirms locally: the rebased branch passes all checks, contains no oversized touched handwritten files, and addresses the open ChatGPT catalog comment.
- Records remotely: the current published PR state; publication and the final
  mergeability recheck remain pending an authorized finishing choice.

- [x] **Step 0: Close the strict touched-test size gate without behavior changes**

The exact gate identified 10 oversized touched test files. Split them by their
existing concerns into directly discovered Bun test files, using local support
only when at least two split files share it. Preserve every test name,
assertion, and behavior, and keep every new test/support file at or below 300
lines.

Focused comparison commands:

```bash
AIO_PROXY_HOME=/tmp/aio-proxy-task10-split/core-final rtk bun test \
  packages/core/_test/request-log-{write,summary,list}.test.ts \
  packages/core/_test/router-{resolution,aliases}.test.ts

rtk proxy sh -c 'cd packages/server && \
  AIO_PROXY_HOME=/tmp/aio-proxy-task10-split/server-final \
  bun test --preload=./_test/setup.ts \
  _test/anthropic-messages-{native,model,failures,count-tokens}.test.ts \
  _test/dashboard-providers-mutation-{basic,aliases,concurrency}.test.ts \
  _test/gemini-generate-content-{native,model,stream,routing}.test.ts \
  _test/openai-completions-{native,model-stream,usage,fallback,errors,boundaries}.test.ts \
  _test/openai-responses-{native,model,unsupported}.test.ts \
  _test/pipeline-{boundaries,raw-fallback,model-stream,terminal}.test.ts \
  _test/server-{health-models,model-ordering,config,provider-probe,plugin-install}.test.ts'

AIO_PROXY_HOME=/tmp/aio-proxy-task10-split/types-final rtk bun test \
  packages/types/_test/schemas-{config-acceptance,config-rejection,provider-mutation,provider-alias-mutation,events}.test.ts
```

Expected and observed: Core 34 tests / 90 assertions, Server 165 tests / 498
assertions, Types 44 tests / 70 assertions, all with zero failures.

- [x] **Step 1: Check touched source sizes without adding repository tooling**

```bash
rtk proxy sh -c '
base=$(git merge-base origin/main HEAD)
git diff --diff-filter=AM --name-only "$base"...HEAD -- "*.ts" "*.tsx" "*.js" "*.jsx" |
while IFS= read -r file; do
  [ -f "$file" ] || continue
  lines=$(wc -l < "$file" | tr -d " ")
  [ "$lines" -gt 300 ] && printf "%s\t%s\n" "$lines" "$file"
done
'
```

Expected: no output.

- [x] **Step 2: Run complete local verification**

```bash
rtk bun run check
AIO_PROXY_HOME=/tmp/aio-proxy-task10-split/unit rtk bun run test:unit
rtk bun run build
AIO_PROXY_HOME=/tmp/aio-proxy-task10-split/cli-binary rtk bun run --filter @aio-proxy/cli build:binary
rtk bunx tsc --noEmit -p packages/server/tsconfig.json
rtk git diff --check
rtk git status --short
```

Expected: all commands pass; the worktree contains only intentional changes.

- [x] **Step 3: Inspect current PR comments and published mergeability**

```bash
rtk proxy python3 /Users/bytedance/.codex/plugins/cache/openai-curated-remote/github/0.1.8-2841cf9749ae/skills/gh-address-comments/scripts/fetch_comments.py
rtk gh pr view 29 --json mergeable,mergeStateStatus,headRefOid
```

Observed: the ChatGPT catalog comment is addressed in verified local code, but
the published PR head remains `CONFLICTING`/`DIRTY`. Do not reply to or resolve
the GitHub thread without explicit user authorization.

- [ ] **Step 4: Publish the verified branch and recheck remote mergeability**

This is a finishing choice, not a local verification step. Only after explicit
authorization to push:

```bash
rtk git push --force-with-lease origin codex/oauth-plugin-system-design
rtk gh pr view 29 --json mergeable,mergeStateStatus,headRefOid
```

Expected after authorized publication: the PR head matches the verified local
commit and mergeability is re-evaluated. Force-push is not authorized yet, so
this step remains pending.

## Self-Review

- Spec coverage: rebase/conflicts, corrected Dashboard type interpretation, raw ChatGPT catalog with hidden models retained, es-toolkit import, Dashboard form/component rules, Bun colocation, all confirmed production/test size violations, and final PR comment verification are covered.
- Intentionally excluded: moving shared DTOs from `@aio-proxy/types` to `@aio-proxy/server`, adding Rstest outside Dashboard, calling Codex's internal authenticated `/models` endpoint, and changing OAuth behavior during file splits.
- Placeholder scan: local verification has no deferred implementation
  decisions; remote publication remains an explicit finishing choice.
- Type consistency: catalog exports, TTL constant, public OAuth/core/CLI/server signatures, and directory entry points match current names.
