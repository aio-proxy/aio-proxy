# Ponytail Audit Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove ~700 lines of dead code and duplicated helpers found by a repo-wide over-engineering audit, without changing any user-visible behavior.

**Architecture:** Six independent cleanup tasks. Tasks 1–2 delete provably-unreferenced code. Tasks 3–5 collapse helpers that were copy-pasted across plugin packages into single `@aio-proxy/plugin-sdk` exports (every affected plugin already depends on the SDK). Task 6 removes redundant `export` keywords. Each task is independently revertable and ends green.

**Tech Stack:** Bun workspace monorepo, Turborepo, TypeScript, `bun test`, oxlint + oxfmt, Changesets.

## Global Constraints

- **Behavior must not change.** This is a pure cleanup. If a change would alter runtime behavior, stop and report rather than proceeding.
- **The baseline is already red.** On the base commit `182ec1e6`, `bun run test:unit` fails in `@aio-proxy/core#build` with a pre-existing type error at `packages/core/src/protocol/tools.ts:39` (`TS2322: Type 'JSONArray | JSONObject' is not assignable to type 'JSONSchema7 | ...'`). **This is not yours. Do not fix it. Do not let it block you.** Verify your work with the per-package commands given in each task, all of which pass today.
- Run `bun run check` (oxlint + oxfmt) before each commit. Run `bun run format` to auto-fix formatting.
- Keep tests colocated with source in a same-name directory (`foo/index.ts`, `foo/foo.ts`, `foo/foo.test.ts`) per CLAUDE.md. Do not add files to legacy `__tests__/` directories.
- Prefer `es-toolkit` narrow imports (`es-toolkit/array`, `es-toolkit/predicate`) over hand-rolled utilities.
- **Adding a value import to a `import type { ... }` line.** Most files in Tasks 3–5 currently import from the SDK with a type-only statement, which cannot carry a value. Two correct shapes — match whichever the file already uses elsewhere:
  - The file's SDK import is `import type { A, B } from '@aio-proxy/plugin-sdk';` → drop the leading `type`, mark each existing member individually, and add the new value: `import { type A, type B, newHelper } from '@aio-proxy/plugin-sdk';`
  - The file's SDK import is already a value import with inline `type` markers (kimi-code/cursor `credential.ts`, claude-code `plugin.ts`) → just add the new name to the member list.

  Never leave two separate import statements from `@aio-proxy/plugin-sdk` in one file; oxlint flags the duplicate.
- **Changeset:** exactly one changeset for the whole branch, added in Task 7. Do not write one per task.
- Commit messages follow Conventional Commits (`type(scope): subject`).

---

## Baseline Verification Commands

These all pass on the base commit. Use them, not the repo-wide `test:unit`.

| Package | Command (run from repo root) |
|---|---|
| plugin-sdk | `cd packages/plugin-sdk && bun test ./src` |
| types | `cd packages/types && bun test ./__tests__ ./src` |
| openai-chatgpt | `cd packages/plugins/openai-chatgpt && bun test --preload=./test/setup.ts` |
| xai-grok | `cd packages/plugins/xai-grok && bun test` |
| google-antigravity | `cd packages/plugins/google-antigravity && bun test --preload=./test/setup.ts` |
| kimi-code | `cd packages/plugins/kimi-code && bun test --preload=./test/setup.ts` |
| cursor | `cd packages/plugins/cursor && bun test` |
| muse-code | `cd packages/plugins/muse-code && bun test` |
| github-copilot | `cd packages/plugins/github-copilot && bun test --preload=./test/setup.ts` |
| cli | `cd packages/cli && bun test --preload=./__tests__/setup.ts --timeout 20000` |

---

## File Structure

**Deleted:**
- `packages/ui/src/components/reui/stepper.tsx` (415 lines, zero references)
- `packages/types/src/aio.ts` (60 lines, zero runtime references)

**Created:**
- `packages/plugin-sdk/src/abortable-sleep/{index.ts,abortable-sleep.ts,abortable-sleep.test.ts}`
- `packages/plugin-sdk/src/quota-items/{index.ts,quota-items.ts,quota-items.test.ts}`
- `packages/plugin-sdk/src/optional-string/{index.ts,optional-string.ts,optional-string.test.ts}`

**Modified:** `packages/plugin-sdk/src/index.ts`, `packages/ui/components.json`, `packages/types/src/index.ts`, `packages/types/__tests__/schemas-events.test.ts`, plus the plugin call sites listed per task.

---

### Task 1: Delete the orphaned `reui/stepper` component

**Context:** `stepper.tsx` was added in `e3402a18`. Its only consumer, `provider-stepper-import.test.tsx`, was deleted in `d4a3ee3e4`. Nothing references it now — not the dashboard, not the UI package, not any config.

**Files:**
- Delete: `packages/ui/src/components/reui/stepper.tsx`
- Modify: `packages/ui/components.json` (remove the `registries` block)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. No other task depends on this one.

- [ ] **Step 1: Prove it is unreferenced**

```bash
grep -rn "stepper\|Stepper" --include="*.ts" --include="*.tsx" --include="*.json" packages \
  | grep -v "/dist/" | grep -v node_modules \
  | grep -v "components/reui/stepper.tsx"
```

Expected: **no output.** If anything prints, STOP and report — the component is in use and this task must be skipped.

- [ ] **Step 2: Delete the component and its now-empty directory**

```bash
git rm packages/ui/src/components/reui/stepper.tsx
rmdir packages/ui/src/components/reui
```

- [ ] **Step 3: Remove the `@reui` registry from components.json**

The `reui` registry existed only to fetch that one component. In `packages/ui/components.json`, delete the trailing `registries` block and the comma that precedes it, so the file ends:

```json
  "aliases": {
    "components": "#components",
    "utils": "#lib/utils",
    "ui": "#components",
    "lib": "#lib",
    "hooks": "#hooks"
  }
}
```

- [ ] **Step 4: Verify nothing broke**

```bash
bun run check
```

Expected: PASS. The dashboard is the only consumer of `@aio-proxy/ui` and it never imported the stepper, so no build change is required.

- [ ] **Step 5: Commit**

```bash
git add -A packages/ui
git commit -m "refactor(ui): drop the unused reui stepper component"
```

---

### Task 2: Delete the unused `types/src/aio.ts` module

**Context:** `AioModelMessageSchema` and `AioStreamPartSchema` are never parsed anywhere. The only references are two type-assertion lines in a test that exist purely to make the module look used.

**Files:**
- Delete: `packages/types/src/aio.ts`
- Modify: `packages/types/src/index.ts:2`
- Modify: `packages/types/__tests__/schemas-events.test.ts:4-5,155-158`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Prove no runtime code uses these schemas**

```bash
grep -rn "AioModelMessage\|AioStreamPart\|AioContentPart" --include="*.ts" --include="*.tsx" packages \
  | grep -v "/dist/" | grep -v node_modules
```

Expected: hits **only** in `packages/types/src/aio.ts`, `packages/types/src/index.ts`, and `packages/types/__tests__/schemas-events.test.ts`. If any other file appears, STOP and report.

- [ ] **Step 2: Delete the module**

```bash
git rm packages/types/src/aio.ts
```

- [ ] **Step 3: Remove the barrel export**

In `packages/types/src/index.ts`, delete this line (line 2):

```typescript
export * from './aio';
```

- [ ] **Step 4: Remove the two dead test lines and their imports**

In `packages/types/__tests__/schemas-events.test.ts`, delete these two lines from the import block:

```typescript
  type AioModelMessage,
  type AioStreamPart,
```

Then delete these four lines near the end of the file:

```typescript
const _message: AioModelMessage = { role: 'user', content: 'hello' };
const _part: AioStreamPart = { type: 'text-delta', textDelta: 'hi' };
void _message;
void _part;
```

- [ ] **Step 5: Run the types tests**

```bash
cd packages/types && bun test ./__tests__ ./src
```

Expected: PASS, with two fewer files' worth of nothing — the remaining assertions are unaffected.

- [ ] **Step 6: Commit**

```bash
git add -A packages/types
git commit -m "refactor(types): remove the unused aio message and stream schemas"
```

---

### Task 3: Extract `abortableSleep` into plugin-sdk

**Context:** `abortableSleep` is hand-written in four plugins. Three copies (kimi-code, cursor, muse-code) are byte-identical; github-copilot's differs only in style.

**Do NOT replace this with `es-toolkit`'s `delay` or `node:timers/promises`.** Both reject with a generic `AbortError` and **discard `signal.reason`**. The codebase depends on that reason surviving: `packages/core/src/plugins/account-login/deadline.ts:104` aborts with an `OAuthLoginTimeoutError` to distinguish a login timeout from a user cancel, and `deadline.ts:92` re-throws `signal.reason`. Swapping in `delay` would silently turn every login timeout into a generic abort. The correct move is one shared copy of the existing semantics.

**Files:**
- Create: `packages/plugin-sdk/src/abortable-sleep/index.ts`
- Create: `packages/plugin-sdk/src/abortable-sleep/abortable-sleep.ts`
- Create: `packages/plugin-sdk/src/abortable-sleep/abortable-sleep.test.ts`
- Modify: `packages/plugin-sdk/src/index.ts`
- Modify: `packages/plugins/kimi-code/src/oauth.ts` (import; delete local fn at ~line 213)
- Modify: `packages/plugins/cursor/src/oauth/oauth.ts` (import; delete local fn at ~line 103)
- Modify: `packages/plugins/muse-code/src/oauth/oauth.ts` (import; delete local fn at ~line 256)
- Modify: `packages/plugins/github-copilot/src/github-api/login.ts` (import; delete local fn at ~line 139)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void>`, exported from `@aio-proxy/plugin-sdk`. Rejects with `signal.reason` both when already aborted and when aborted mid-flight.

- [ ] **Step 1: Write the failing test**

Create `packages/plugin-sdk/src/abortable-sleep/abortable-sleep.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';

import { abortableSleep } from './abortable-sleep';

describe('abortableSleep', () => {
  test('resolves after the delay when never aborted', async () => {
    const started = Date.now();
    await abortableSleep(20, new AbortController().signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  test('rejects with signal.reason when the signal is already aborted', async () => {
    const reason = new Error('already gone');
    const controller = new AbortController();
    controller.abort(reason);
    expect(abortableSleep(1_000, controller.signal)).rejects.toBe(reason);
  });

  test('rejects with signal.reason when aborted mid-flight', async () => {
    const reason = new Error('cancelled midway');
    const controller = new AbortController();
    setTimeout(() => controller.abort(reason), 10);
    expect(abortableSleep(5_000, controller.signal)).rejects.toBe(reason);
  });

  test('stops listening to the signal once the delay elapses', async () => {
    const controller = new AbortController();
    await abortableSleep(10, controller.signal);
    // Aborting after resolution must not produce an unhandled rejection.
    controller.abort(new Error('too late'));
    expect(controller.signal.aborted).toBe(true);
  });
});
```

The third and fourth tests are the ones that matter: they pin the `signal.reason` identity that `es-toolkit`'s `delay` would break, and they pin listener cleanup.

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd packages/plugin-sdk && bun test ./src/abortable-sleep
```

Expected: FAIL — cannot resolve module `./abortable-sleep`.

- [ ] **Step 3: Write the implementation**

Create `packages/plugin-sdk/src/abortable-sleep/abortable-sleep.ts`. This is the existing kimi/cursor/muse body verbatim — it rejects with `signal.reason`, which is the contract callers rely on:

```typescript
/**
 * Sleeps for `milliseconds`, rejecting with `signal.reason` if aborted.
 *
 * Deliberately not `es-toolkit`'s `delay` or `node:timers/promises`: both reject with a generic
 * `AbortError` and discard `signal.reason`. Login deadlines abort with an `OAuthLoginTimeoutError`
 * to tell a timeout apart from a user cancel, so the reason has to survive.
 */
export function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
```

Create `packages/plugin-sdk/src/abortable-sleep/index.ts`:

```typescript
export { abortableSleep } from './abortable-sleep';
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd packages/plugin-sdk && bun test ./src/abortable-sleep
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Export it from the SDK entry point**

In `packages/plugin-sdk/src/index.ts`, add this line, keeping the existing alphabetical grouping (it goes directly after the `export * from './config';` line):

```typescript
export { abortableSleep } from './abortable-sleep/index';
```

- [ ] **Step 6: Commit the new helper**

```bash
git add packages/plugin-sdk/src/abortable-sleep packages/plugin-sdk/src/index.ts
git commit -m "feat(plugin-sdk): add a shared abortableSleep helper"
```

- [ ] **Step 7: Switch kimi-code to the shared helper**

In `packages/plugins/kimi-code/src/oauth.ts`, line 1 is a type-only import:

```typescript
import type { LocalizedText, OAuthLoginContext, RuntimeFetch } from '@aio-proxy/plugin-sdk';
```

Rewrite it as a value import (see Global Constraints):

```typescript
import { abortableSleep, type LocalizedText, type OAuthLoginContext, type RuntimeFetch } from '@aio-proxy/plugin-sdk';
```

Then delete the entire local `function abortableSleep(...) { ... }` block (~lines 213–228). Leave the `const sleep = dependencies.sleep ?? abortableSleep;` call site untouched — it now resolves to the import.

- [ ] **Step 8: Verify kimi-code**

```bash
cd packages/plugins/kimi-code && bun test --preload=./test/setup.ts
```

Expected: PASS (21 tests in `src/oauth.test.ts` alone were green at baseline).

- [ ] **Step 9: Switch cursor to the shared helper**

In `packages/plugins/cursor/src/oauth/oauth.ts`, rewrite the type-only line 1 as:

```typescript
import {
  abortableSleep,
  type LocalizedText,
  type OAuthLoginContext,
  type OAuthLoginResult,
  type RuntimeFetch,
} from '@aio-proxy/plugin-sdk';
```

Delete the local `function abortableSleep(...) { ... }` block (~lines 103–118).

- [ ] **Step 10: Verify cursor**

```bash
cd packages/plugins/cursor && bun test
```

Expected: PASS (22 oauth tests were green at baseline).

- [ ] **Step 11: Switch muse-code to the shared helper**

In `packages/plugins/muse-code/src/oauth/oauth.ts`, rewrite the type-only line 1 as:

```typescript
import {
  abortableSleep,
  type CredentialPort,
  type LocalizedText,
  type OAuthLoginContext,
  type RuntimeFetch,
} from '@aio-proxy/plugin-sdk';
```

Delete the local `function abortableSleep(...) { ... }` block (~lines 256–271).

- [ ] **Step 12: Verify muse-code**

```bash
cd packages/plugins/muse-code && bun test
```

Expected: PASS (16 oauth tests were green at baseline).

- [ ] **Step 13: Switch github-copilot to the shared helper**

In `packages/plugins/github-copilot/src/github-api/login.ts`, rewrite the type-only line 1 as:

```typescript
import { abortableSleep, type LocalizedText, type OAuthLoginContext, type RuntimeFetch } from '@aio-proxy/plugin-sdk';
```

Delete the local `function abortableSleep(...) { ... }` block (~lines 139–153).

Note this copy's semantics differ subtly: it calls `signal.throwIfAborted()` (throws synchronously) where the shared version returns a rejected promise, and `throwIfAborted` throws `signal.reason` — the same value the shared version rejects with. Both call sites (`login.ts:109` and `:114`) immediately `await` the result, so a synchronous throw and a rejected promise are indistinguishable there. The swap is safe.

- [ ] **Step 14: Verify github-copilot**

```bash
cd packages/plugins/github-copilot && bun test --preload=./test/setup.ts
```

Expected: PASS (58 tests were green at baseline).

- [ ] **Step 15: Confirm every copy is gone**

```bash
grep -rn "function abortableSleep" --include="*.ts" packages | grep -v "/dist/" | grep -v node_modules
```

Expected: exactly one hit — `packages/plugin-sdk/src/abortable-sleep/abortable-sleep.ts`.

- [ ] **Step 16: Commit**

```bash
bun run check
git add -A packages/plugins
git commit -m "refactor(plugins): use the shared abortableSleep helper"
```

---

### Task 4: Extract `dedupeItemIds` into plugin-sdk

**Context:** Three plugins each carry a 13-line `dedupeItemIds`. openai-chatgpt and google-antigravity are byte-identical; xai-grok differs only in using `_` instead of `-` as the suffix separator. All three already depend on `@aio-proxy/plugin-sdk`, which owns the `OAuthQuotaItem` type.

**Files:**
- Create: `packages/plugin-sdk/src/quota-items/index.ts`
- Create: `packages/plugin-sdk/src/quota-items/quota-items.ts`
- Create: `packages/plugin-sdk/src/quota-items/quota-items.test.ts`
- Modify: `packages/plugin-sdk/src/index.ts`
- Modify: `packages/plugins/openai-chatgpt/src/quota/quota.ts:39` and local fn at ~205
- Modify: `packages/plugins/xai-grok/src/quota.ts:46` and local fn at ~186
- Modify: `packages/plugins/google-antigravity/src/quota/quota.ts:176` and local fn at ~262

**Interfaces:**
- Consumes: `OAuthQuotaItem` from `@aio-proxy/plugin-sdk` (already exported, defined at `packages/plugin-sdk/src/oauth.ts:130`).
- Produces: `dedupeQuotaItemIds(items: readonly OAuthQuotaItem[], separator?: string): readonly OAuthQuotaItem[]`. `separator` defaults to `'-'`. Preserves input order; the first occurrence of an id keeps it, later ones get `${id}${separator}${n}` starting at `n = 2`.

- [ ] **Step 1: Write the failing test**

Create `packages/plugin-sdk/src/quota-items/quota-items.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';

import type { OAuthQuotaItem } from '../oauth';
import { dedupeQuotaItemIds } from './quota-items';

const item = (id: string): OAuthQuotaItem => ({ id, displayName: id });

describe('dedupeQuotaItemIds', () => {
  test('leaves already-unique ids untouched', () => {
    const items = [item('a'), item('b')];
    expect(dedupeQuotaItemIds(items).map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  test('suffixes repeats from 2 upward, keeping the first occurrence bare', () => {
    const items = [item('a'), item('a'), item('a')];
    expect(dedupeQuotaItemIds(items).map((entry) => entry.id)).toEqual(['a', 'a-2', 'a-3']);
  });

  test('honours a custom separator', () => {
    const items = [item('a'), item('a')];
    expect(dedupeQuotaItemIds(items, '_').map((entry) => entry.id)).toEqual(['a', 'a_2']);
  });

  test('skips a generated id that already exists in the input', () => {
    const items = [item('a'), item('a-2'), item('a')];
    expect(dedupeQuotaItemIds(items).map((entry) => entry.id)).toEqual(['a', 'a-2', 'a-3']);
  });

  test('preserves the other fields of a renamed item', () => {
    const items: OAuthQuotaItem[] = [
      { id: 'a', displayName: 'First' },
      { id: 'a', displayName: 'Second', remainingRatio: 0.5 },
    ];
    expect(dedupeQuotaItemIds(items)[1]).toEqual({ id: 'a-2', displayName: 'Second', remainingRatio: 0.5 });
  });

  test('returns an empty array unchanged', () => {
    expect(dedupeQuotaItemIds([])).toEqual([]);
  });
});
```

The fourth test is the one worth having: it pins the collision-avoidance loop that a naive counter would get wrong.

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd packages/plugin-sdk && bun test ./src/quota-items
```

Expected: FAIL — cannot resolve module `./quota-items`.

- [ ] **Step 3: Write the implementation**

Create `packages/plugin-sdk/src/quota-items/quota-items.ts`:

```typescript
import type { OAuthQuotaItem } from '../oauth';

/**
 * Makes quota item ids unique. The core validator rejects a snapshot containing duplicate ids
 * outright, so two entries naming the same metered feature or window must not both keep the id —
 * a suffix beats losing the whole card.
 *
 * The first occurrence keeps the bare id; later ones become `${id}${separator}${n}` from n = 2.
 * Every id handed out is reserved, generated ones included, so the counter walks past a suffix
 * an original id already occupies.
 */
export function dedupeQuotaItemIds(
  items: readonly OAuthQuotaItem[],
  separator = '-',
): readonly OAuthQuotaItem[] {
  const taken = new Set<string>();
  return items.map((item) => {
    if (!taken.has(item.id)) {
      taken.add(item.id);
      return item;
    }
    let count = 2;
    while (taken.has(`${item.id}${separator}${count}`)) count += 1;
    const id = `${item.id}${separator}${count}`;
    taken.add(id);
    return { ...item, id };
  });
}
```

That doc comment merges the three plugins' existing explanations, so their local comments go away with their local functions in Steps 7–11.

Create `packages/plugin-sdk/src/quota-items/index.ts`:

```typescript
export { dedupeQuotaItemIds } from './quota-items';
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd packages/plugin-sdk && bun test ./src/quota-items
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Export it from the SDK entry point**

In `packages/plugin-sdk/src/index.ts`, add:

```typescript
export { dedupeQuotaItemIds } from './quota-items/index';
```

- [ ] **Step 6: Commit the new helper**

```bash
git add packages/plugin-sdk/src/quota-items packages/plugin-sdk/src/index.ts
git commit -m "feat(plugin-sdk): add a shared dedupeQuotaItemIds helper"
```

- [ ] **Step 7: Switch openai-chatgpt**

In `packages/plugins/openai-chatgpt/src/quota/quota.ts`, the SDK import (lines 1–9) is type-only. Rewrite it as a value import:

```typescript
import {
  type AccountContext,
  dedupeQuotaItemIds,
  type LocalizedText,
  type OAuthQuotaItem,
  type OAuthQuotaResetCredit,
  type OAuthQuotaResetCredits,
  type OAuthQuotaSnapshot,
  type RuntimeFetch,
} from '@aio-proxy/plugin-sdk';
```

Change line 39 from:

```typescript
  const items = dedupeItemIds([...laneItems(usage), ...additionalItems(usage)]);
```

to:

```typescript
  const items = dedupeQuotaItemIds([...laneItems(usage), ...additionalItems(usage)]);
```

Delete the local `function dedupeItemIds(...) { ... }` block (~lines 205–218) **and the two-line comment above it** (~lines 203–204) — the SDK helper's doc comment now covers it. This plugin used `-`, which is the new default, so no separator argument is needed.

- [ ] **Step 8: Verify openai-chatgpt**

```bash
cd packages/plugins/openai-chatgpt && bun test --preload=./test/setup.ts
```

Expected: PASS (9 quota tests were green at baseline).

- [ ] **Step 9: Switch google-antigravity**

In `packages/plugins/google-antigravity/src/quota/quota.ts`, the SDK import (lines 1–7) is type-only. Rewrite it as a value import:

```typescript
import {
  type AccountContext,
  dedupeQuotaItemIds,
  type LocalizedText,
  type OAuthQuotaItem,
  type OAuthQuotaSnapshot,
  type RuntimeFetch,
} from '@aio-proxy/plugin-sdk';
```

Change line 176 from:

```typescript
  const items = dedupeItemIds(groupItems(Reflect.get(payload, 'groups')));
```

to:

```typescript
  const items = dedupeQuotaItemIds(groupItems(Reflect.get(payload, 'groups')));
```

Delete the local `function dedupeItemIds(...) { ... }` block (~lines 262–275) **and the two-line comment above it** (~lines 260–261). This plugin also used `-`, so no separator argument.

- [ ] **Step 10: Verify google-antigravity**

```bash
cd packages/plugins/google-antigravity && bun test --preload=./test/setup.ts
```

Expected: PASS.

- [ ] **Step 11: Switch xai-grok, preserving its `_` separator**

In `packages/plugins/xai-grok/src/quota.ts`, rewrite the type-only line 1 as a value import:

```typescript
import {
  type AccountContext,
  dedupeQuotaItemIds,
  type OAuthQuotaItem,
  type OAuthQuotaSnapshot,
} from '@aio-proxy/plugin-sdk';
```

This plugin used `_`, not `-`, so **the separator argument is required** — omitting it would change the ids this provider reports. Replace lines 46–49:

```typescript
  const items = dedupeItemIds([
    ...(weekly.status === 'fulfilled' ? weekly.value : []),
    ...(monthly.status === 'fulfilled' ? monthly.value : []),
  ]);
```

with:

```typescript
  const items = dedupeQuotaItemIds(
    [
      ...(weekly.status === 'fulfilled' ? weekly.value : []),
      ...(monthly.status === 'fulfilled' ? monthly.value : []),
    ],
    '_',
  );
```

Delete the local `function dedupeItemIds(...) { ... }` block (~lines 186–199). **Keep the explanatory comment above it** (~lines 182–185, about `grok build` collisions) only if you move it to the new call — otherwise delete it too, since the SDK helper carries its own doc comment.

- [ ] **Step 12: Verify xai-grok**

```bash
cd packages/plugins/xai-grok && bun test
```

Expected: PASS (9 quota tests were green at baseline). If a test fails on an id like `a-2` where it expected `a_2`, the separator argument was omitted in Step 11.

- [ ] **Step 13: Confirm every copy is gone**

```bash
grep -rn "function dedupeItemIds" --include="*.ts" packages | grep -v "/dist/" | grep -v node_modules
```

Expected: **no output.**

- [ ] **Step 14: Commit**

```bash
bun run check
git add -A packages/plugins
git commit -m "refactor(plugins): use the shared dedupeQuotaItemIds helper"
```

---

### Task 5: Extract `optionalString` into plugin-sdk

**Context:** `optionalString` is hand-written six times across five plugins in two shapes:

- `(record, key)` — kimi-code (×2), cursor, muse-code. Returns the value when it is a non-empty string, else `undefined`. **Does not trim.** google-antigravity has the same signature but **does** trim.
- `(value: unknown)` — claude-code (×2). Trims, then returns `undefined` for empty.

**Unify on the single-argument `(value: unknown)` form, with trimming.** It is the more general of the two: every `(record, key)` call converts mechanically to `optionalString(record[key])`, but the reverse is impossible. claude-code calls it on zod-parsed object properties (`optionalString(source.account_id)`) and on already-narrowed locals (`optionalString(account['uuid'])` where `account` came out of an `isPlainObject` guard); forcing those into a `(record, key)` shape would mean inventing a record just to index it.

Trimming changes behavior only for a value that is entirely whitespace — which the four non-trimming copies would have returned as a truthy string. That is a latent bug in each of them, and the changeset must call the fix out.

**Files:**
- Create: `packages/plugin-sdk/src/optional-string/index.ts`
- Create: `packages/plugin-sdk/src/optional-string/optional-string.ts`
- Create: `packages/plugin-sdk/src/optional-string/optional-string.test.ts`
- Modify: `packages/plugin-sdk/src/index.ts`
- Modify: `packages/plugins/kimi-code/src/oauth.ts` (7 calls + local fn at ~196)
- Modify: `packages/plugins/kimi-code/src/oauth/credential.ts` (3 calls + local fn at ~111)
- Modify: `packages/plugins/cursor/src/oauth/credential.ts` (3 calls + local fn at ~116)
- Modify: `packages/plugins/muse-code/src/oauth/oauth.ts` (6 calls + local fn at ~239)
- Modify: `packages/plugins/google-antigravity/src/oauth/flow.ts` (3 calls + local fn at ~101)
- Modify: `packages/plugins/claude-code/src/oauth/identity.ts` (local fn at ~123 only — calls unchanged)
- Modify: `packages/plugins/claude-code/src/plugin/plugin.ts` (local fn at ~156 only — calls unchanged)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `optionalString(value: unknown): string | undefined`. Returns the trimmed value when `value` is a string with non-whitespace content, else `undefined`.

- [ ] **Step 1: Write the failing test**

Create `packages/plugin-sdk/src/optional-string/optional-string.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';

import { optionalString } from './optional-string';

describe('optionalString', () => {
  test('returns the value for a non-empty string', () => {
    expect(optionalString('alice')).toBe('alice');
  });

  test('trims surrounding whitespace', () => {
    expect(optionalString('  alice  ')).toBe('alice');
  });

  test('returns undefined for an empty string', () => {
    expect(optionalString('')).toBeUndefined();
  });

  test('returns undefined for a whitespace-only string', () => {
    expect(optionalString('   ')).toBeUndefined();
  });

  test('returns undefined for undefined and null', () => {
    expect(optionalString(undefined)).toBeUndefined();
    expect(optionalString(null)).toBeUndefined();
  });

  test('returns undefined for non-string values', () => {
    expect(optionalString(42)).toBeUndefined();
    expect(optionalString(['a'])).toBeUndefined();
    expect(optionalString({ toString: () => 'a' })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd packages/plugin-sdk && bun test ./src/optional-string
```

Expected: FAIL — cannot resolve module `./optional-string`.

- [ ] **Step 3: Write the implementation**

Create `packages/plugin-sdk/src/optional-string/optional-string.ts`:

```typescript
/**
 * Reads an optional string out of a parsed upstream payload, treating blank as absent.
 *
 * Trims before the emptiness check: a whitespace-only field is upstream saying "nothing here",
 * and returning it as a truthy string leaks padding into ids and display names.
 */
export function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
```

Create `packages/plugin-sdk/src/optional-string/index.ts`:

```typescript
export { optionalString } from './optional-string';
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd packages/plugin-sdk && bun test ./src/optional-string
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Export it from the SDK entry point**

In `packages/plugin-sdk/src/index.ts`, add:

```typescript
export { optionalString } from './optional-string/index';
```

- [ ] **Step 6: Commit the new helper**

```bash
git add packages/plugin-sdk/src/optional-string packages/plugin-sdk/src/index.ts
git commit -m "feat(plugin-sdk): add a shared optionalString helper"
```

- [ ] **Step 7: Switch claude-code — the local functions are already identical**

Both claude-code copies are byte-identical to the new SDK helper, so only the import and the local definition change. **Do not touch any call site in these two files.**

In `packages/plugins/claude-code/src/oauth/identity.ts`: rewrite the type-only line 1 as `import { optionalString, type RuntimeFetch } from '@aio-proxy/plugin-sdk';`, then delete lines 123–127:

```typescript
function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
```

Leave `normalizeEmail` (line 129) alone — it calls `optionalString` and now resolves to the import.

In `packages/plugins/claude-code/src/plugin/plugin.ts`: its SDK import (lines 1–9) is already a value import, so just add `optionalString` to the member list. Then delete lines 156–160. Leave `nestedString` (line 152) alone; it calls `optionalString` too.

- [ ] **Step 8: Verify claude-code**

```bash
cd packages/plugins/claude-code && bun test
```

Expected: PASS. Behavior is bit-for-bit unchanged here — this is a pure move.

- [ ] **Step 9: Commit the trivial half**

```bash
bun run check
git add -A packages/plugins/claude-code
git commit -m "refactor(plugin-claude-code): use the shared optionalString helper"
```

- [ ] **Step 10: Switch google-antigravity**

`packages/plugins/google-antigravity/src/oauth/flow.ts` also trims, so it is behavior-identical too — but its signature is `(payload, key)`, so **its three call sites must be rewritten**.

Rewrite the type-only line 1 as `import { optionalString, type RuntimeFetch } from '@aio-proxy/plugin-sdk';`, delete the local block at lines 101–105, then rewrite:

| Line | From | To |
|---|---|---|
| 59 | `optionalString(payload, 'token_type')` | `optionalString(payload['token_type'])` |
| 60 | `optionalString(payload, 'scope')` | `optionalString(payload['scope'])` |
| 96 | `optionalString(payload, key)` | `optionalString(payload[key])` |

- [ ] **Step 11: Verify google-antigravity**

```bash
cd packages/plugins/google-antigravity && bun test --preload=./test/setup.ts
```

Expected: PASS.

- [ ] **Step 12: Switch the four non-trimming `(record, key)` copies**

These four are the ones whose behavior actually changes: they returned a whitespace-only string as-is, and will now return `undefined`. That is the fix described in the Context block.

For each file: bring `optionalString` into the `@aio-proxy/plugin-sdk` import per the Global Constraints rule, delete the local `function optionalString(value: Record<string, unknown>, key: string) { ... }` block, and rewrite every call from `optionalString(obj, 'key')` to `optionalString(obj['key'])`.

`packages/plugins/kimi-code/src/oauth.ts` — the type-only line 1 becomes:

```typescript
import {
  type LocalizedText,
  type OAuthLoginContext,
  optionalString,
  type RuntimeFetch,
} from '@aio-proxy/plugin-sdk';
```

(If Task 3 already converted this line, `abortableSleep` is on it — keep it and add `optionalString`.) Local fn at 196–199, calls at lines 113, 114, 115, 116, 140, 141, 143.

`packages/plugins/kimi-code/src/oauth/credential.ts` — line 1 is already a value import; add `optionalString` to it. Local fn at 111–114, calls at lines 85, 86, 95.

`packages/plugins/cursor/src/oauth/credential.ts` — line 1 is already a value import; add `optionalString` to it. Local fn at 116–119, calls at lines 93, 94, 102.

`packages/plugins/muse-code/src/oauth/oauth.ts` — convert line 1 as in Task 3, adding `optionalString`. Local fn at 239–242, calls at lines 107, 108, 110 (**two calls on line 110**), 162, 164.

Leave every neighbouring `optionalPositiveNumber` alone — out of scope.

- [ ] **Step 13: Verify those four**

```bash
cd packages/plugins/kimi-code && bun test --preload=./test/setup.ts
```

```bash
cd packages/plugins/cursor && bun test
```

```bash
cd packages/plugins/muse-code && bun test
```

Expected: PASS for all three packages. If a test fails because it asserted that a whitespace-only field survives, that assertion was pinning the bug — update the test to expect `undefined` and note it in the final report.

- [ ] **Step 14: Confirm every copy is gone**

```bash
grep -rn "function optionalString" --include="*.ts" packages | grep -v "/dist/" | grep -v node_modules
```

Expected: exactly one hit — `packages/plugin-sdk/src/optional-string/optional-string.ts`.

Also confirm no two-argument call survived — the new signature takes one argument, so any comma at the top level of the call is a leftover:

```bash
grep -rn "optionalString([a-zA-Z_$][a-zA-Z0-9_$]*, " --include="*.ts" packages | grep -v "/dist/" | grep -v node_modules
```

Expected: no output. (`bun run lint:types` in Task 6 would also catch these, but failing here is a faster signal.)

- [ ] **Step 15: Commit**

```bash
bun run check
git add -A packages/plugins
git commit -m "refactor(plugins): use the shared optionalString helper"
```

---

### Task 6: Unexport internal-only types

**Context:** Three modules export types that no other file imports. Dropping the `export` keyword shrinks the public surface without touching behavior. These are type-level only — no runtime change is possible.

**Files:**
- Modify: `packages/server/src/server-log.ts` (17 types)
- Modify: `packages/core/src/ai-sdk-bridge/index.ts` (6 types)
- Modify: `packages/cli/src/open-browser.ts` (2 types + 1 function)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Purely subtractive.

- [ ] **Step 1: Unexport the 17 internal `*Log` types**

In `packages/server/src/server-log.ts`, change `export type X = {` to `type X = {` for exactly these, all of which are reachable only through the `ServerLog` union declared in the same file:

`ConfigOAuthLeftoverModelsLog`, `DashboardAuthUnavailableLog`, `AutoUpdateFailedLog`, `RequestRejectedLog`, `SafeExceptionLog`, `RequestProviderAttemptFailedLog`, `RequestInboundSnapshotLog`, `RequestUpstreamSnapshotLog`, `RequestUpstreamResultLog`, `RequestFailedLog`, `RequestRecorderInvariantLog`, `RequestFeatureDowngradedLog`, `TracePersistenceFailedLog`, `UsageAccountingDroppedLog`, `RealtimeCallCreatedLog`, `RealtimeSidebandOpenedLog`, `RealtimeSidebandClosedLog`.

**Keep exported:** `ServerLog`, `ServerLogSink`, `ConfigReloadLog` (re-exported by `server-state/types.ts:109`), `RealtimeCallFailedLog`, `RequestBodyChunkLog`, `RequestBodyTerminalLog`, and the `logServerEvent` / `serverErrorType` functions.

- [ ] **Step 2: Unexport the 6 internal ai-sdk-bridge types**

In `packages/core/src/ai-sdk-bridge/index.ts`, drop `export` from: `AiSdkRuntimeProvider`, `AiSdkCallableProvider`, `AiSdkModelCatalogEntry`, `AiSdkModelCatalogProvider`, `AiSdkTextStreamRequest`, `AiSdkTextStreamResult`.

Each is referenced only within this file — the first four by `LoadedAiSdkRuntimeProvider`, the last two by `streamAiSdkText`'s signature. Keep `LoadedAiSdkRuntimeProvider`, `AiSdkLanguageModel`, `AiSdkCallSettings`, `streamAiSdkText`, and the whole re-export block exported.

- [ ] **Step 3: Unexport the open-browser internals**

In `packages/cli/src/open-browser.ts`, drop `export` from `BrowserCommand`, `OpenBrowserDeps`, and `browserCommand`.

**Keep `createOpenBrowser` exported** — `packages/cli/__tests__/open-browser.test.ts:3` imports it. Keep `openBrowser` exported; it is the module's main consumer-facing value.

- [ ] **Step 4: Delete the dead `cli/src/browser.ts` re-export**

`packages/cli/src/browser.ts` is a single line, `export { openBrowser } from './open-browser';`, with zero importers — every caller already imports from `./open-browser`. Confirm, then delete:

```bash
grep -rn "from '\./browser'\|from '\.\./browser'\|cli/src/browser" --include="*.ts" packages | grep -v "/dist/" | grep -v node_modules
```

Expected: no output. Then:

```bash
git rm packages/cli/src/browser.ts
```

- [ ] **Step 5: Typecheck the three packages**

```bash
bun run lint:types
```

Expected: PASS. If it reports an unresolved import for one of the unexported names, that name had a consumer the audit missed — restore its `export` and note which one.

- [ ] **Step 6: Run the affected test suites**

```bash
cd packages/cli && bun test --preload=./__tests__/setup.ts --timeout 20000
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
bun run check
git add -A packages/server packages/core packages/cli
git commit -m "refactor: unexport types with no external consumers"
```

---

### Task 7: Add the changeset and open the PR

**Files:**
- Create: `.changeset/<generated-name>.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: the release note and the PR.

- [ ] **Step 1: Write the changeset**

Per CLAUDE.md, a changeset must target a **product** package — internal-only targets produce an empty CHANGELOG and the GitHub Release is silently skipped. This branch touches `@aio-proxy/plugin-sdk` (a product package, published with release notes) and several internal packages, so list the internal ones **alongside** `aio-proxy`.

Create `.changeset/ponytail-audit-cleanup.md`:

```markdown
---
'@aio-proxy/plugin-sdk': patch
'@aio-proxy/plugin-claude-code': patch
'@aio-proxy/plugin-cursor': patch
'@aio-proxy/plugin-github-copilot': patch
'@aio-proxy/plugin-google-antigravity': patch
'@aio-proxy/plugin-kimi-code': patch
'@aio-proxy/plugin-muse-code': patch
'@aio-proxy/plugin-openai-chatgpt': patch
'@aio-proxy/plugin-xai-grok': patch
'@aio-proxy/core': patch
'@aio-proxy/server': patch
'@aio-proxy/cli': patch
'@aio-proxy/types': patch
'@aio-proxy/ui': patch
'aio-proxy': patch
---

Removed dead code and consolidated helpers that had been copy-pasted across provider plugins. The
plugin SDK now exports `abortableSleep`, `dedupeQuotaItemIds`, and `optionalString`, which several
plugins previously each carried their own copy of. One behavior fix rides along: an OAuth or quota
field that upstream sends as nothing but whitespace is now treated as absent instead of being
accepted as a real value.
```

That is 5 lines of body, at the limit. Do not append to it in follow-up work — rewrite it.

Verify every name above is in the `fixed` group of `.changeset/config.json` before committing.

- [ ] **Step 2: Verify the full check passes**

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 3: Confirm you did not make the baseline worse**

```bash
bun run test:unit 2>&1 | tail -20
```

Expected: the **same** pre-existing `@aio-proxy/core#build` declaration-file failure at `packages/core/src/protocol/tools.ts:39` described in Global Constraints, and **no other failure**. If any additional package fails, that one is yours — fix it before opening the PR.

- [ ] **Step 4: Commit the changeset**

```bash
git add .changeset
git commit -m "chore: add changeset for the audit cleanup"
```

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin claude/priceless-jang-8e6ad7
```

Then open the PR with a Conventional Commits title:

```bash
gh pr create --title "refactor: remove dead code and consolidate duplicated plugin helpers" --body "$(cat <<'EOF'
## Summary

Repo-wide over-engineering audit cleanup. Pure refactor — no user-visible behavior change except one
noted fix.

- Deleted `reui/stepper.tsx` (415 lines); its only consumer was removed in `d4a3ee3e4`
- Deleted `types/src/aio.ts` (60 lines); the schemas were never parsed anywhere
- Consolidated `abortableSleep` (4 copies), `dedupeQuotaItemIds` (3 copies), and `optionalString`
  (6 copies) into `@aio-proxy/plugin-sdk`
- Unexported 25 types that had no consumer outside their own file

## Behavior note

`optionalString` now trims before its emptiness check, so a whitespace-only upstream field reads as
absent. Four of the six previous copies did not trim and would have returned `"   "` as a valid
value — a latent bug in each.

`abortableSleep` deliberately keeps its hand-written body rather than adopting `es-toolkit`'s
`delay`: `delay` rejects with a generic `AbortError` and discards `signal.reason`, which would turn
every `OAuthLoginTimeoutError` into an indistinguishable generic abort.

## Testing

Every touched package's suite passes. `bun run test:unit` still shows the pre-existing
`@aio-proxy/core#build` declaration failure at `packages/core/src/protocol/tools.ts:39`, which is
present on the base commit and untouched by this branch.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Deliberately Out of Scope

Recorded so a later reader does not re-litigate them:

- **58 dead `z.input`/`z.output` aliases in `packages/types/src`.** Real, but they sit next to live schemas in files the dashboard imports heavily; removing them is a large mechanical diff with a real chance of catching a live alias. Worth its own PR.
- **`cli/src/upgrade/registry.ts`.** The audit flagged it as a one-line delegate worth inlining, but it has two real tests exercising its `fetchImpl` seam. Inlining would delete genuine coverage.
- **`ui/src/lib/utils.ts`** (`export { cn } from 'cn'`). 68 importers for one line saved; churn outweighs the gain.
- **`throwIfAborted` hand-rolled 6×.** The four google-antigravity copies differ subtly in how they fall back when `signal.reason` is undefined. Untangling that needs its own behavioral review.
- **The pre-existing `core/src/protocol/tools.ts:39` type error.** Unrelated to this audit; needs its own fix.
