# Dashboard Appearance and Language Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent appearance and language dropdowns to the bottom of the dashboard sidebar.

**Architecture:** Reuse the existing root `ThemeProvider`, sidebar primitives, and dropdown radio items. Keep the controls in one focused sidebar-footer component; theme changes use `useTheme`, while locale changes call the existing i18n runtime and reload the current page so all compiled messages update consistently.

**Tech Stack:** React 19, next-themes 0.4, Paraglide JS, Base UI dropdown menu, Bun test.

## Global Constraints

- Appearance options are exactly system, light, and dark.
- Language options are exactly Simplified Chinese (`zh-Hans`) and English (`en`).
- Theme changes are immediate and persisted by the existing `next-themes` provider.
- Language changes preserve the current dashboard URL and reload once after the locale is stored.
- Reuse existing dependencies and UI primitives; add no new dependency or general settings framework.

---

### Task 1: Add the sidebar preference controls

**Files:**
- Create: `packages/dashboard/src/components/side-menu/sidebar-preferences.tsx`
- Modify: `packages/dashboard/src/components/side-menu/side-menu.tsx`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Test: `packages/dashboard/_test/sidebar-preferences.test.ts`

**Interfaces:**
- Consumes: `getLocale(): "en" | "zh-Hans"`, `setLocale(locale): void | Promise<void>`, `useTheme(): { theme, setTheme }`, existing `SidebarFooter`, `SidebarMenu`, and dropdown radio primitives.
- Produces: `SidebarPreferences: React.FC`, rendered once at the bottom of `SideMenu`.

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, expect, test } from "bun:test";

const preferencesPath = `${import.meta.dir}/../src/components/side-menu/sidebar-preferences.tsx`;
const sideMenuPath = `${import.meta.dir}/../src/components/side-menu/side-menu.tsx`;
const enPath = `${import.meta.dir}/../../i18n/messages/en.json`;
const zhPath = `${import.meta.dir}/../../i18n/messages/zh-Hans.json`;

describe("sidebar preferences", () => {
  test("renders persistent appearance and language menus in the sidebar footer", async () => {
    const [preferences, sideMenu, en, zh] = await Promise.all([
      Bun.file(preferencesPath).text(),
      Bun.file(sideMenuPath).text(),
      Bun.file(enPath).json(),
      Bun.file(zhPath).json(),
    ]);

    expect(sideMenu).toContain("<SidebarPreferences />");
    expect(preferences).toContain("<SidebarFooter>");
    expect(preferences).toContain('setTheme(value)');
    expect(preferences).toContain('await setLocale(locale)');
    expect(preferences).toContain('window.location.reload()');
    expect(en.dashboard.preferences.appearance).toBe("Appearance");
    expect(en.dashboard.preferences.language).toBe("Language");
    expect(zh.dashboard.preferences.appearance).toBe("外观");
    expect(zh.dashboard.preferences.language).toBe("语言");
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `rtk bun test packages/dashboard/_test/sidebar-preferences.test.ts`

Expected: FAIL because `sidebar-preferences.tsx` and the new translation keys do not exist.

- [ ] **Step 3: Add the translated labels**

Add this object under `dashboard` in `packages/i18n/messages/en.json`:

```json
"preferences": {
  "appearance": "Appearance",
  "language": "Language",
  "theme_system": "System",
  "theme_light": "Light",
  "theme_dark": "Dark",
  "language_zh_hans": "简体中文",
  "language_en": "English"
}
```

Add the same keys under `dashboard` in `packages/i18n/messages/zh-Hans.json`:

```json
"preferences": {
  "appearance": "外观",
  "language": "语言",
  "theme_system": "跟随系统",
  "theme_light": "浅色",
  "theme_dark": "深色",
  "language_zh_hans": "简体中文",
  "language_en": "English"
}
```

Run `rtk bun run --cwd packages/i18n build` so generated Paraglide messages expose the new keys.

- [ ] **Step 4: Implement the minimal preference component**

Create `sidebar-preferences.tsx` with:

```tsx
import { getLocale, m, setLocale, type Locale } from "@aio-proxy/i18n";
import { Languages, MonitorCog } from "lucide-react";
import { useTheme } from "next-themes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarFooter, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

const themes = [
  ["system", () => m["dashboard.preferences.theme_system"]()],
  ["light", () => m["dashboard.preferences.theme_light"]()],
  ["dark", () => m["dashboard.preferences.theme_dark"]()],
] as const;

const languages = [
  ["zh-Hans", () => m["dashboard.preferences.language_zh_hans"]()],
  ["en", () => m["dashboard.preferences.language_en"]()],
] as const;

export const SidebarPreferences: React.FC = () => {
  const { theme = "system", setTheme } = useTheme();
  const changeLocale = async (locale: Locale) => {
    if (locale === getLocale()) return;
    await setLocale(locale);
    window.location.reload();
  };

  return (
    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger render={<SidebarMenuButton />}>
              <MonitorCog />
              <span>{m["dashboard.preferences.appearance"]()}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="end">
              <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value)}>
                {themes.map(([value, label]) => (
                  <DropdownMenuRadioItem key={value} value={value}>{label()}</DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger render={<SidebarMenuButton />}>
              <Languages />
              <span>{m["dashboard.preferences.language"]()}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="end">
              <DropdownMenuRadioGroup value={getLocale()} onValueChange={(value) => void changeLocale(value as Locale)}>
                {languages.map(([value, label]) => (
                  <DropdownMenuRadioItem key={value} value={value}>{label()}</DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
};
```

Import `SidebarPreferences` in `side-menu.tsx` and render `<SidebarPreferences />` immediately after `</SidebarContent>`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `rtk bun test packages/dashboard/_test/sidebar-preferences.test.ts`

Expected: PASS with 1 test and 0 failures.

- [ ] **Step 6: Run formatting, dashboard tests, and build**

Run:

```bash
rtk bunx biome check packages/dashboard/src/components/side-menu packages/dashboard/_test/sidebar-preferences.test.ts packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json
rtk bun run --cwd packages/dashboard test:unit
rtk bun run --cwd packages/dashboard build
```

Expected: all commands exit 0 with no test failures or build errors.

- [ ] **Step 7: Commit the implementation**

```bash
git add packages/dashboard/src/components/side-menu/sidebar-preferences.tsx \
  packages/dashboard/src/components/side-menu/side-menu.tsx \
  packages/dashboard/_test/sidebar-preferences.test.ts \
  packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json \
  packages/i18n/src/paraglide
git commit -m "feat(dashboard): add appearance and language switchers" \
  -m "Co-authored-by: Codex <noreply@openai.com>"
```
