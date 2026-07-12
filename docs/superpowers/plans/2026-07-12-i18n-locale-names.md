# i18n Locale Autonyms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize locale autonym generation in `@aio-proxy/i18n` and remove language names from dashboard translation messages.

**Architecture:** Add one pure `getLocaleName` helper backed by `Intl.DisplayNames`, export it from the i18n package, and have the dashboard render the generated `locales` list through that helper. Preserve the existing locale order and language-switch behavior.

**Tech Stack:** TypeScript, Intl.DisplayNames, Paraglide JS, Bun test, Rstest.

## Global Constraints

- Paraglide `locales` remains the only supported-locale list.
- Locale labels use each locale's own language and fall back to the locale code.
- Dashboard translation messages do not contain locale names.
- No static locale-name map or cache is introduced.

---

### Task 1: Export and consume locale autonyms

**Files:**
- Create: `packages/i18n/src/locale-name.ts`
- Create: `packages/i18n/_test/locale-name.test.ts`
- Modify: `packages/i18n/src/index.ts`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Modify: `packages/dashboard/src/components/side-menu/sidebar-preferences.tsx`
- Modify: `packages/dashboard/src/components/side-menu/sidebar-preferences.test.tsx`

**Interfaces:**
- Produces: `getLocaleName(locale: Locale): string` from `@aio-proxy/i18n`.
- Consumes: Paraglide `locales`, `Locale`, and `Intl.DisplayNames`.

- [ ] **Step 1: Write the failing i18n test**

```ts
import { describe, expect, test } from "bun:test";
import { getLocaleName } from "../src/locale-name";

describe("locale names", () => {
  test("uses each locale's autonym", () => {
    expect(getLocaleName("en")).toBe("English");
    expect(getLocaleName("zh-Hans")).toBe("简体中文");
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `rtk bun test packages/i18n/_test/locale-name.test.ts`

Expected: FAIL because `locale-name.ts` does not exist.

- [ ] **Step 3: Implement and export the helper**

```ts
import type { Locale } from "./resolve";

export const getLocaleName = (locale: Locale): string =>
  new Intl.DisplayNames([locale], { type: "language" }).of(locale) ?? locale;
```

Export `getLocaleName` from `packages/i18n/src/index.ts`.

- [ ] **Step 4: Run the i18n test and verify GREEN**

Run: `rtk bun test packages/i18n/_test/locale-name.test.ts`

Expected: 1 test passes.

- [ ] **Step 5: Migrate the dashboard language list**

Import `getLocaleName` and `locales` from `@aio-proxy/i18n`. Delete the local `languages` constant and render:

```tsx
{locales.map((locale) => (
  <DropdownMenuRadioItem key={locale} value={locale}>
    {getLocaleName(locale)}
  </DropdownMenuRadioItem>
))}
```

Remove `language_zh_hans` and `language_en` from both message JSON files. Update the component test mock to expose:

```ts
locales: ["en", "zh-Hans"],
getLocaleName: (locale: string) => (locale === "en" ? "English" : "简体中文"),
```

- [ ] **Step 6: Run focused and full verification**

Run:

```bash
rtk bun run --cwd packages/i18n test:unit
rtk bun run --cwd packages/dashboard test:unit
rtk bunx biome check packages/i18n packages/dashboard
rtk bun run --cwd packages/dashboard build
```

Expected: i18n tests, 77 dashboard tests, Biome, and dashboard build pass.

- [ ] **Step 7: Commit and update the PR**

```bash
git add packages/i18n packages/dashboard docs/superpowers
git commit -m "refactor(i18n): centralize locale display names" \
  -m "Co-authored-by: Codex <noreply@openai.com>"
git push
```
