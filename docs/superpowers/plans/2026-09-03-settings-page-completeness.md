# Settings Page Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Settings page owns every setting a user can change from the Dashboard — appearance and language, a manual config reload, `server.password`, and `server.apiKeys` — instead of leaving three of them unreachable and one buried in the sidebar.

**Architecture:** Appearance and language stay pure client-side preferences (next-themes `localStorage`, Paraglide `setLocale` + reload) and move out of the sidebar footer into a Settings card, so there is exactly one entry point and one source of state. The reload button calls the already-mounted `POST /dashboard/api/reload`; no server change. Password and API keys extend the existing `DashboardSettingsViewSchema` / `DashboardSettingsMutationSchema` wire contract and the single `PUT /dashboard/api/settings` route, keeping the established mask-on-read / write-only-on-mutate discipline: the view never carries a secret, and the mutation carries a plaintext password (hashed with Argon2id in the route before it reaches disk) or a per-row `retain` index that keeps an authored `{{env.X}}` API-key template byte-identical.

**Tech Stack:** TypeScript, Zod 4, Hono typed RPC, Bun test (`packages/server`, `packages/types`, `packages/i18n`), rstest + @testing-library/react (`packages/dashboard`), TanStack Form/Query, Base UI shadcn components from `@aio-proxy/ui`, Paraglide i18n, Changesets.

## Global Constraints

- Domain terms: Provider ID, provider priority, provider weight. Do not write "provider name", "order", or "rank".
- Scope is items 1–4 only. `router.modelContextAggregation` belongs on the Routing page and is explicitly **out of scope** — do not add it to any settings schema, route, or card.
- `DashboardSettingsViewSchema` must never carry a `password` field or a raw API key. `packages/types/src/dashboard/control-plane/control-plane.test.ts:72` asserts this; keep that assertion.
- The settings route test asserts no secret leaks in the GET response body: `expect(text).not.toMatch(/password-preserved|user:password|SETTINGS_|root-preserved/u)`. Every view field you add must still satisfy it.
- Plaintext passwords never reach disk. Hash with `Bun.password.hash` (Argon2id) in the route, matching the existing `normalizeDashboardPassword` path in `packages/server/src/dashboard-auth/password.ts`.
- Authored `{{env.NAME}}` templates in the config file must survive a write untouched. For API keys this is what the `retain` index is for.
- Static API keys must keep rejecting the reserved `aio_agent_at_` / `aio_agent_rt_` prefixes (`hasReservedAgentTokenPrefix`, exported from `@aio-proxy/types`).
- `server.logging.dir` stays out of the dashboard contract. `packages/server/src/dashboard-routes/settings/settings.test.ts` asserts it is byte-preserved.
- All user-facing copy goes through i18n keys added to **all five** message files (`packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json`) before use, then `bun run i18n:compile`. Message files are **nested** JSON (`dashboard.settings.x`), not flat dotted keys. `packages/i18n/__tests__/locale-parity.test.ts` fails on any missing key, extra key, or placeholder drift.
- Dashboard rules in `packages/dashboard/AGENTS.md` are authoritative: dashboard API types come from `@aio-proxy/server`/`@aio-proxy/types`; no `fetch` outside `src/modules/<domain>/services/`; every input/select/checkbox must be driven by TanStack Form; one component per `.tsx` typed `React.FC<XProps>` with a `<ComponentName>Props` interface and a kebab-case filename; cross-module code lives in `src/lib/`; nothing in `lib` imports React or the dashboard client.
- Colocated tests in same-name directories. Do not add files under `_test/`.
- Non-test implementation files stay under 500 lines; evaluate splitting at 400.
- Prefer `es-toolkit` narrow imports over hand-written generic utilities. `isPlainObject` from `es-toolkit/predicate` for parsed config data.
- Every changeset targets `aio-proxy` **plus** the internal packages actually touched, at the same bump level. Never author a changeset that targets only internal packages.
- Already on branch `claude/hopeful-davinci-87b721` in worktree `.claude/worktrees/hopeful-davinci-87b721`. Do not create another worktree.
- Before considering a task complete run `bun run check` plus the affected package tests. Run `bun run preflight` once at the end of Task 4.

---

## File map

**Task 1 — appearance + language card**

- Create: `packages/dashboard/src/lib/reload-dashboard/reload-dashboard.ts` — `reloadDashboard()`, moved out of the side-menu directory so two modules can share it.
- Create: `packages/dashboard/src/lib/reload-dashboard/index.ts` — barrel.
- Create: `packages/dashboard/src/modules/settings/components/settings-preferences-group/settings-preferences-group.tsx` — the Appearance & language card.
- Create: `packages/dashboard/src/modules/settings/components/settings-preferences-group/index.ts` — barrel.
- Create: `packages/dashboard/src/modules/settings/components/settings-preferences-group/settings-preferences-group.test.tsx`
- Delete: `packages/dashboard/src/components/side-menu/reload-dashboard.ts`
- Delete: `packages/dashboard/src/components/side-menu/sidebar-preferences.tsx`
- Delete: `packages/dashboard/src/components/side-menu/sidebar-preferences.test.tsx`
- Modify: `packages/dashboard/src/components/side-menu/side-menu.tsx` — inline the footer, render `SidebarLogout` directly.
- Modify: `packages/dashboard/src/components/side-menu/side-menu.test.tsx` — mock `./sidebar-logout` instead of the deleted `./sidebar-preferences`.
- Modify: `packages/dashboard/src/modules/settings/templates/settings-page/settings-page.tsx` — render the preferences card.
- Modify: `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json` — add `dashboard.settings.preferences_group`, `dashboard.settings.appearance_description`, `dashboard.settings.language_description`.
- Create: `.changeset/settings-preferences-card.md`

**Task 2 — reload button**

- Create: `packages/dashboard/src/modules/settings/services/reload-service/reload-service.ts` — `reloadConfigMutationFn()`.
- Create: `packages/dashboard/src/modules/settings/services/reload-service/index.ts` — barrel.
- Create: `packages/dashboard/src/modules/settings/hooks/use-reload-mutation/use-reload-mutation.ts`
- Create: `packages/dashboard/src/modules/settings/hooks/use-reload-mutation/index.ts` — barrel.
- Create: `packages/dashboard/src/modules/settings/hooks/use-reload-mutation/use-reload-mutation.test.tsx`
- Create: `packages/dashboard/src/modules/settings/components/settings-reload-button/settings-reload-button.tsx`
- Create: `packages/dashboard/src/modules/settings/components/settings-reload-button/index.ts` — barrel.
- Create: `packages/server/src/dashboard-routes/reload/reload.test.ts` — first coverage for the existing route.
- Modify: `packages/dashboard/src/modules/settings/templates/settings-page/settings-page.tsx` — pass the button as `extra`.
- Modify: `packages/i18n/messages/*.json` — add `dashboard.settings.reload`, `reload_succeeded`, `reload_failed`.
- Create: `.changeset/settings-reload-button.md`

**Task 3 — `server.password` set/clear**

- Modify: `packages/types/src/dashboard/control-plane/control-plane.ts` — export `DashboardPasswordSchema`, add `password` to the mutation.
- Modify: `packages/types/src/dashboard/control-plane/control-plane.test.ts` — stop asserting `password` is rejected by the mutation; assert the new accept/reject cases.
- Modify: `packages/server/src/dashboard-routes/settings/settings.ts` — hash and apply the password.
- Modify: `packages/server/src/dashboard-routes/settings/settings.test.ts` — Argon2id on disk, clear, no plaintext leak.
- Create: `packages/dashboard/src/modules/settings/components/settings-form/settings-password-field.tsx`
- Modify: `packages/dashboard/src/modules/settings/components/settings-form/settings-service-group.tsx` — swap the read-only field for the new component.
- Modify: `packages/dashboard/src/modules/settings/components/settings-form/settings-form-contract.ts` — export `passwordSchema`.
- Modify: `packages/dashboard/src/modules/settings/templates/settings-page/settings-page.test.tsx` — replace the read-only-password test.
- Modify: `packages/i18n/messages/*.json` — add `password_save`, `password_clear`, `password_too_short`; reword `password_description`.
- Create: `.changeset/settings-dashboard-password.md`

**Task 4 — `server.apiKeys` add/edit/remove**

- Modify: `packages/types/src/dashboard/control-plane/control-plane.ts` — `apiKeys` in the view and the mutation.
- Modify: `packages/types/src/dashboard/control-plane/control-plane.test.ts` — retain/replace/reject contract.
- Modify: `packages/server/src/dashboard-routes/settings/settings.ts` — view projection and `retain` resolution.
- Modify: `packages/server/src/dashboard-routes/settings/settings.test.ts` — template preservation, removal, reserved prefix.
- Create: `packages/dashboard/src/modules/settings/components/settings-form/settings-api-keys-group.tsx`
- Modify: `packages/dashboard/src/modules/settings/components/settings-form/settings-form-contract.ts` — export `apiKeysSchema`.
- Modify: `packages/dashboard/src/modules/settings/components/settings-form/settings-form.tsx` — render the group.
- Modify: `packages/dashboard/src/modules/settings/templates/settings-page/settings-page.test.tsx` — fixture gains `apiKeys`; add/remove/save coverage.
- Modify: `packages/i18n/messages/*.json` — add the `api_keys_*` keys.
- Create: `.changeset/settings-api-keys.md`

---

### Task 1: Appearance & language card in Settings

Pure frontend. The server already rejects `theme` and `language` in the settings mutation with 422 and unchanged config bytes (`control-plane.test.ts:62`, the last test in `settings.test.ts`). Do **not** route these through `useSettingsMutation`.

**Files:**
- Create: `packages/dashboard/src/lib/reload-dashboard/reload-dashboard.ts`
- Create: `packages/dashboard/src/lib/reload-dashboard/index.ts`
- Create: `packages/dashboard/src/modules/settings/components/settings-preferences-group/settings-preferences-group.tsx`
- Create: `packages/dashboard/src/modules/settings/components/settings-preferences-group/index.ts`
- Test: `packages/dashboard/src/modules/settings/components/settings-preferences-group/settings-preferences-group.test.tsx`
- Delete: `packages/dashboard/src/components/side-menu/reload-dashboard.ts`
- Delete: `packages/dashboard/src/components/side-menu/sidebar-preferences.tsx`
- Delete: `packages/dashboard/src/components/side-menu/sidebar-preferences.test.tsx`
- Modify: `packages/dashboard/src/components/side-menu/side-menu.tsx:1-20,102-134`
- Modify: `packages/dashboard/src/components/side-menu/side-menu.test.tsx:14`
- Modify: `packages/dashboard/src/modules/settings/templates/settings-page/settings-page.tsx`
- Modify: `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json`
- Create: `.changeset/settings-preferences-card.md`

**Interfaces:**
- Produces: `reloadDashboard(): void` from `@/lib/reload-dashboard` (Task 1 only consumer is the preferences card).
- Produces: `SettingsPreferencesGroup: React.FC` from `../../components/settings-preferences-group`, rendered by `SettingsPage`.
- Consumes: existing `dashboard.preferences.{appearance,language,theme_system,theme_light,theme_dark}` i18n keys — reuse them, do not duplicate under `dashboard.settings`.

- [ ] **Step 1: Add the three new i18n keys to all five locales**

In each `packages/i18n/messages/<locale>.json`, add three keys inside the existing nested `dashboard.settings` object (alphabetical position does not matter; put them after `service_group`).

`en.json`:

```json
      "preferences_group": "Appearance & language",
      "appearance_description": "Applies to this browser only.",
      "language_description": "Reloads the Dashboard to apply.",
```

`zh-Hans.json`:

```json
      "preferences_group": "外观与语言",
      "appearance_description": "仅对当前浏览器生效。",
      "language_description": "切换后会重新加载控制台以应用。",
```

`zh-Hant.json`:

```json
      "preferences_group": "外觀與語言",
      "appearance_description": "僅對目前瀏覽器生效。",
      "language_description": "切換後會重新載入控制台以套用。",
```

`ja.json`:

```json
      "preferences_group": "外観と言語",
      "appearance_description": "このブラウザーにのみ適用されます。",
      "language_description": "変更を反映するためダッシュボードを再読み込みします。",
```

`ko.json`:

```json
      "preferences_group": "모양 및 언어",
      "appearance_description": "이 브라우저에만 적용됩니다.",
      "language_description": "적용하려면 대시보드를 다시 불러옵니다.",
```

- [ ] **Step 2: Compile messages and run the parity test**

```bash
bun run i18n:compile && bun test packages/i18n/__tests__/locale-parity.test.ts
```

Expected: PASS. If it reports missing keys, a locale file was skipped in Step 1.

- [ ] **Step 3: Move `reloadDashboard` into `src/lib`**

Create `packages/dashboard/src/lib/reload-dashboard/reload-dashboard.ts`:

```ts
export const reloadDashboard = () => window.location.reload();
```

Create `packages/dashboard/src/lib/reload-dashboard/index.ts`:

```ts
export * from './reload-dashboard';
```

Delete `packages/dashboard/src/components/side-menu/reload-dashboard.ts`.

- [ ] **Step 4: Write the failing test for the preferences card**

Create `packages/dashboard/src/modules/settings/components/settings-preferences-group/settings-preferences-group.test.tsx`:

```tsx
import { expect, rs, test, waitFor } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { SettingsPreferencesGroup } from './settings-preferences-group';

const mocks = rs.hoisted(() => ({
  reloadDashboard: rs.fn(),
  setLocale: rs.fn().mockResolvedValue(undefined),
  setTheme: rs.fn(),
}));

rs.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'system', setTheme: mocks.setTheme }),
}));

rs.mock('@aio-proxy/i18n', () => ({
  getLocale: () => 'en',
  getLocaleName: (locale: string) => (locale === 'en' ? 'English' : '简体中文'),
  locales: ['en', 'zh-Hans'],
  setLocale: mocks.setLocale,
  m: {
    'dashboard.preferences.appearance': () => 'Appearance',
    'dashboard.preferences.language': () => 'Language',
    'dashboard.preferences.theme_system': () => 'System',
    'dashboard.preferences.theme_light': () => 'Light',
    'dashboard.preferences.theme_dark': () => 'Dark',
    'dashboard.settings.preferences_group': () => 'Appearance & language',
    'dashboard.settings.appearance_description': () => 'Applies to this browser only.',
    'dashboard.settings.language_description': () => 'Reloads the Dashboard to apply.',
  },
}));

rs.mock('@/lib/reload-dashboard', () => ({ reloadDashboard: mocks.reloadDashboard }));

const pick = async (trigger: HTMLElement, option: string) => {
  fireEvent.click(trigger);
  const item = await screen.findByRole('option', { name: option });
  fireEvent.pointerDown(item, { pointerType: 'mouse' });
  fireEvent.click(item);
};

test('stores the appearance without touching the settings mutation', async () => {
  render(<SettingsPreferencesGroup />);

  await pick(screen.getByLabelText('Appearance'), 'Dark');

  expect(mocks.setTheme).toHaveBeenCalledWith('dark');
});

test('stores a different language and reloads the Dashboard', async () => {
  render(<SettingsPreferencesGroup />);

  await pick(screen.getByLabelText('Language'), '简体中文');

  await waitFor(() => {
    expect(mocks.setLocale).toHaveBeenCalledWith('zh-Hans');
    expect(mocks.reloadDashboard).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

```bash
cd packages/dashboard && bun x rstest run src/modules/settings/components/settings-preferences-group
```

Expected: FAIL — cannot resolve `./settings-preferences-group`.

- [ ] **Step 6: Implement the preferences card**

Create `packages/dashboard/src/modules/settings/components/settings-preferences-group/settings-preferences-group.tsx`:

```tsx
import { getLocale, getLocaleName, type Locale, locales, m, setLocale } from '@aio-proxy/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Field, FieldDescription } from '@aio-proxy/ui/components/field';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { useForm } from '@tanstack/react-form';
import { useTheme } from 'next-themes';

import { reloadDashboard } from '@/lib/reload-dashboard';

const themes = [
  ['system', () => m['dashboard.preferences.theme_system']()],
  ['light', () => m['dashboard.preferences.theme_light']()],
  ['dark', () => m['dashboard.preferences.theme_dark']()],
] as const;

export const SettingsPreferencesGroup: React.FC = () => {
  const { theme = 'system', setTheme } = useTheme();
  const form = useForm({ defaultValues: { locale: getLocale(), theme } });

  const changeLocale = async (locale: Locale) => {
    if (locale === getLocale()) return;
    await setLocale(locale);
    reloadDashboard();
  };

  return (
    <Card data-testid="settings-group-preferences">
      <CardHeader>
        <CardTitle>
          <h2>{m['dashboard.settings.preferences_group']()}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-5 md:grid-cols-2">
          <form.Field name="theme">
            {(field) => (
              <Field>
                <Label htmlFor={field.name}>{m['dashboard.preferences.appearance']()}</Label>
                <Select
                  value={field.state.value}
                  onValueChange={(value) => {
                    const next = String(value);
                    field.handleChange(next);
                    setTheme(next);
                  }}
                >
                  <SelectTrigger id={field.name} className="w-full" aria-label={m['dashboard.preferences.appearance']()}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {themes.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>{m['dashboard.settings.appearance_description']()}</FieldDescription>
              </Field>
            )}
          </form.Field>
          <form.Field name="locale">
            {(field) => (
              <Field>
                <Label htmlFor={field.name}>{m['dashboard.preferences.language']()}</Label>
                <Select
                  value={field.state.value}
                  onValueChange={(value) => {
                    const next = value as Locale;
                    field.handleChange(next);
                    void changeLocale(next);
                  }}
                >
                  <SelectTrigger id={field.name} className="w-full" aria-label={m['dashboard.preferences.language']()}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {locales.map((locale) => (
                      <SelectItem key={locale} value={locale}>
                        {getLocaleName(locale)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>{m['dashboard.settings.language_description']()}</FieldDescription>
              </Field>
            )}
          </form.Field>
        </div>
      </CardContent>
    </Card>
  );
};
```

Create `packages/dashboard/src/modules/settings/components/settings-preferences-group/index.ts`:

```ts
export * from './settings-preferences-group';
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
cd packages/dashboard && bun x rstest run src/modules/settings/components/settings-preferences-group
```

Expected: PASS (2 tests). `screen.getByLabelText('Appearance')` resolves to the `SelectTrigger` through its `aria-label`; the `Label htmlFor`/`id` pair keeps the visible label associated too.

- [ ] **Step 8: Render the card on the Settings page**

In `packages/dashboard/src/modules/settings/templates/settings-page/settings-page.tsx`, add the import and render the card **outside** the query-state branch — appearance and language do not depend on the settings request succeeding.

Add after the existing `SettingsForm` import:

```tsx
import { SettingsPreferencesGroup } from '../../components/settings-preferences-group';
```

Replace the returned `<div>` body:

```tsx
      <div className="mx-auto w-full max-w-3xl space-y-6">
        {content}
        <SettingsPreferencesGroup />
      </div>
```

- [ ] **Step 9: Delete the sidebar dropdowns and inline the footer**

Delete `packages/dashboard/src/components/side-menu/sidebar-preferences.tsx` and `packages/dashboard/src/components/side-menu/sidebar-preferences.test.tsx`. With both dropdowns gone the wrapper holds nothing but `SidebarLogout`, so it stops earning a file.

In `packages/dashboard/src/components/side-menu/side-menu.tsx`, extend the sidebar import list with `SidebarFooter`:

```tsx
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@aio-proxy/ui/components/sidebar';
```

Replace the `SidebarPreferences` import:

```tsx
import { SidebarLogout } from './sidebar-logout';
```

Replace `<SidebarPreferences />` at the end of the returned tree:

```tsx
      <SidebarFooter>
        <SidebarMenu>
          <SidebarLogout />
        </SidebarMenu>
      </SidebarFooter>
```

- [ ] **Step 10: Repoint the side-menu test mock**

In `packages/dashboard/src/components/side-menu/side-menu.test.tsx`, replace line 14:

```tsx
rs.mock('./sidebar-logout', () => ({ SidebarLogout: () => null }));
```

- [ ] **Step 11: Run the dashboard suites touched by this task**

```bash
cd packages/dashboard && bun x rstest run src/components/side-menu src/modules/settings
```

Expected: PASS. The existing settings-page tests still pass — the new card adds an `h2` but every assertion there queries headings by name.

- [ ] **Step 12: Write the changeset**

Create `.changeset/settings-preferences-card.md`:

```markdown
---
'@aio-proxy/dashboard': minor
'@aio-proxy/i18n': minor
'aio-proxy': minor
---

Move appearance and language into Settings as an "Appearance & language" card and drop the sidebar dropdowns, so every preference has one entry point.
```

- [ ] **Step 13: Lint, format, commit**

```bash
bun run check
```

```bash
git add -A && git commit -m "feat(dashboard): move appearance and language into Settings"
```

---

### Task 2: Manual config reload button

`POST /dashboard/api/reload` is already mounted at `packages/server/src/dashboard-routes/config.ts:61` and has **zero** callers and zero tests. This task surfaces it. Scope it honestly:

- The config file watcher is on by default whenever a `configPath` exists, so external edits already auto-reload. This button is a "re-read now" escape hatch and, more usefully, the only way to *see* a reload failure (`{ ok: false, error, stage }`, HTTP 409).
- `password`, `apiKeys`, and `retryAfterCapMs` are read live per request from `state.currentConfig()`. They need neither restart nor reload.
- `host`/`port` (bound once in `Bun.serve` at CLI boot) and `logging.level` (read once during lifecycle setup) genuinely need a process restart. Reload cannot fix them. **Keep the existing `restart_required` notice exactly as it is** — do not reword it to suggest the button is sufficient.

**Files:**
- Create: `packages/dashboard/src/modules/settings/services/reload-service/reload-service.ts`
- Create: `packages/dashboard/src/modules/settings/services/reload-service/index.ts`
- Create: `packages/dashboard/src/modules/settings/hooks/use-reload-mutation/use-reload-mutation.ts`
- Create: `packages/dashboard/src/modules/settings/hooks/use-reload-mutation/index.ts`
- Test: `packages/dashboard/src/modules/settings/hooks/use-reload-mutation/use-reload-mutation.test.tsx`
- Create: `packages/dashboard/src/modules/settings/components/settings-reload-button/settings-reload-button.tsx`
- Create: `packages/dashboard/src/modules/settings/components/settings-reload-button/index.ts`
- Test: `packages/server/src/dashboard-routes/reload/reload.test.ts`
- Modify: `packages/dashboard/src/modules/settings/templates/settings-page/settings-page.tsx`
- Modify: `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json`
- Create: `.changeset/settings-reload-button.md`

**Interfaces:**
- Produces: `ReloadProviderDiff` — `{ providerIds: { added: readonly string[]; removed: readonly string[] } }`, declared in the service. It mirrors the server's `config.changed` payload; declaring it locally rather than importing `ConfigChangedData` avoids reaching into `@aio-proxy/server`'s non-exported `server-state` types, and the shape is pinned by the Step 1 route test.
- Produces: `reloadConfigMutationFn(): Promise<ReloadProviderDiff>` from `../../services/reload-service`.
- Produces: `ReloadFailedError` with `readonly stage: string` — thrown when the endpoint answers 409.
- Produces: `useReloadMutation()` from `../../hooks/use-reload-mutation` — a `useMutation` that invalidates `queryKeys.settings` and `queryKeys.providers` on success.
- Produces: `SettingsReloadButton: React.FC` from `../../components/settings-reload-button`, passed as `PageContainer`'s `extra`.
- Consumes: `queryKeys.settings`, `queryKeys.providers` from `@/lib/query-keys`; `toast.add` from `@aio-proxy/ui/components/toast`.

- [ ] **Step 1: Write the failing server test for the existing reload route**

The endpoint has no test at all. Cover both branches before touching the frontend.

Create `packages/server/src/dashboard-routes/reload/reload.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRuntimeConfig, Router } from '@aio-proxy/core';

import { createServerState } from '#server-test-lifecycle';

import { disabledDashboardAuthentication } from '../../dashboard-auth/test-support';
import { createDashboardRoutes } from '../config';

const authoredConfig = { plugins: [], providers: {}, router: {}, server: { port: 9_317 } };

async function withReloadFixture(
  run: (fixture: { readonly configPath: string; readonly routes: ReturnType<typeof createDashboardRoutes> }) => Promise<void>,
  options: { readonly rejectReload?: { value: boolean } } = {},
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'aio-dashboard-reload-'));
  const configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify(authoredConfig, null, 2));
  const rejectReload = options.rejectReload;
  const state = await createServerState({
    config: parseRuntimeConfig(authoredConfig),
    configPath,
    dbHome: directory,
    watchConfig: false,
    ...(rejectReload === undefined
      ? {}
      : {
          __test: {
            createRouter: (providers) => {
              if (rejectReload.value) throw new Error('reload rejected for test');
              return new Router(providers);
            },
          },
        }),
  });

  try {
    await run({ configPath, routes: createDashboardRoutes(state, disabledDashboardAuthentication) });
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

const reload = (routes: ReturnType<typeof createDashboardRoutes>): Promise<Response> =>
  routes.request('/reload', { method: 'POST' });

test('POST /reload re-reads the config file and reports the provider diff', async () => {
  await withReloadFixture(async ({ configPath, routes }) => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          ...authoredConfig,
          providers: {
            added: { kind: 'api', protocol: 'openai-compatible', baseUrl: 'https://api.example/v1', apiKey: 'sk-test' },
          },
        },
        null,
        2,
      ),
    );

    const response = await reload(routes);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, diff: { providerIds: { added: ['added'], removed: [] } } });
  });
});

test('POST /reload reports the failing stage without applying the snapshot', async () => {
  const rejectReload = { value: false };
  await withReloadFixture(
    async ({ routes }) => {
      rejectReload.value = true;

      const response = await reload(routes);

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ ok: false, stage: 'providers' });
    },
    { rejectReload },
  );
});
```

- [ ] **Step 2: Run the server test to verify it passes as written**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/dashboard-routes/reload/reload.test.ts
```

Expected: PASS (2 tests). This one is characterization, not TDD — the route already exists, and the point is to pin its contract before a client depends on it. If it FAILS, the route's real shape differs from `config.ts:61`; fix the test to match the route (do not change the route), and carry the corrected shape into Step 4.

- [ ] **Step 3: Add the three reload i18n keys to all five locales**

In each `packages/i18n/messages/<locale>.json`, inside nested `dashboard.settings`:

`en.json`:

```json
      "reload": "Reload config",
      "reload_succeeded": "Configuration reloaded from disk.",
      "reload_failed": "Reload failed at the {stage} stage.",
```

`zh-Hans.json`:

```json
      "reload": "重新加载配置",
      "reload_succeeded": "已从磁盘重新加载配置。",
      "reload_failed": "重新加载在 {stage} 阶段失败。",
```

`zh-Hant.json`:

```json
      "reload": "重新載入設定",
      "reload_succeeded": "已從磁碟重新載入設定。",
      "reload_failed": "重新載入在 {stage} 階段失敗。",
```

`ja.json`:

```json
      "reload": "設定を再読み込み",
      "reload_succeeded": "ディスクから設定を再読み込みしました。",
      "reload_failed": "{stage} 段階で再読み込みに失敗しました。",
```

`ko.json`:

```json
      "reload": "설정 다시 불러오기",
      "reload_succeeded": "디스크에서 설정을 다시 불러왔습니다.",
      "reload_failed": "{stage} 단계에서 다시 불러오기가 실패했습니다.",
```

Then:

```bash
bun run i18n:compile && bun test packages/i18n/__tests__/locale-parity.test.ts
```

Expected: PASS. `reload_failed` carries a `{stage}` placeholder in every locale — the parity test compares placeholder sets, so all five must have it.

- [ ] **Step 4: Add the reload service**

Create `packages/dashboard/src/modules/settings/services/reload-service/reload-service.ts`:

```ts
import { createDashboardClient } from '@/lib/dashboard-client';

const dashboardClient = createDashboardClient();

export interface ReloadProviderDiff {
  readonly providerIds: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
  };
}

export class ReloadFailedError extends Error {
  constructor(readonly stage: string) {
    super(`config reload failed at ${stage}`);
  }
}

export const reloadConfigMutationFn = async (): Promise<ReloadProviderDiff> => {
  const response = await dashboardClient.dashboard.api.reload.$post();
  const result = await response.json();
  if (!result.ok) throw new ReloadFailedError(result.stage);
  return result.diff;
};
```

Create `packages/dashboard/src/modules/settings/services/reload-service/index.ts`:

```ts
export * from './reload-service';
```

If the typed client narrows `result` such that `result.stage` is not visible on the failure arm, the route's `context.json(..., 409)` union is being widened by Hono. In that case discriminate on the HTTP status instead — `if (!response.ok) { const failure = result as { readonly stage: string }; throw new ReloadFailedError(failure.stage); }` — and keep everything else identical.

- [ ] **Step 5: Write the failing hook test**

Create `packages/dashboard/src/modules/settings/hooks/use-reload-mutation/use-reload-mutation.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, rs, test, waitFor } from '@rstest/core';
import { renderHook } from '@testing-library/react';

import { queryKeys } from '@/lib/query-keys';

import { useReloadMutation } from './use-reload-mutation';

const mocks = rs.hoisted(() => ({ reloadConfigMutationFn: rs.fn() }));

rs.mock('../../services/reload-service', () => ({
  reloadConfigMutationFn: mocks.reloadConfigMutationFn,
}));

const renderReloadMutation = () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidateQueries = rs.spyOn(queryClient, 'invalidateQueries');
  const view = renderHook(() => useReloadMutation(), {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  return { invalidateQueries, result: view.result };
};

test('refreshes settings and providers after a successful reload', async () => {
  mocks.reloadConfigMutationFn.mockReset().mockResolvedValue({ providerIds: { added: [], removed: [] } });
  const { invalidateQueries, result } = renderReloadMutation();

  result.current.mutate();

  await waitFor(() => {
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.settings });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.providers });
  });
});

test('does not refresh anything when the reload is rejected', async () => {
  mocks.reloadConfigMutationFn.mockReset().mockRejectedValue(new Error('providers'));
  const { invalidateQueries, result } = renderReloadMutation();

  result.current.mutate();

  await waitFor(() => {
    expect(result.current.isError).toBe(true);
  });
  expect(invalidateQueries).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: Run the hook test to verify it fails**

```bash
cd packages/dashboard && bun x rstest run src/modules/settings/hooks/use-reload-mutation
```

Expected: FAIL — cannot resolve `./use-reload-mutation`.

- [ ] **Step 7: Implement the hook**

Create `packages/dashboard/src/modules/settings/hooks/use-reload-mutation/use-reload-mutation.ts`:

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import { reloadConfigMutationFn } from '../../services/reload-service';

export const useReloadMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: reloadConfigMutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      await queryClient.invalidateQueries({ queryKey: queryKeys.providers });
    },
  });
};
```

Create `packages/dashboard/src/modules/settings/hooks/use-reload-mutation/index.ts`:

```ts
export * from './use-reload-mutation';
```

No new `queryKeys` entry is needed — a reload is a mutation, not a cached query, and it only invalidates two keys that already exist. Do not add one.

- [ ] **Step 8: Run the hook test to verify it passes**

```bash
cd packages/dashboard && bun x rstest run src/modules/settings/hooks/use-reload-mutation
```

Expected: PASS (2 tests).

- [ ] **Step 9: Implement the reload button**

Create `packages/dashboard/src/modules/settings/components/settings-reload-button/settings-reload-button.tsx`:

```tsx
import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { toast } from '@aio-proxy/ui/components/toast';
import { RefreshCw } from 'lucide-react';

import { ReloadFailedError } from '../../services/reload-service';
import { useReloadMutation } from '../../hooks/use-reload-mutation';

export const SettingsReloadButton: React.FC = () => {
  const reload = useReloadMutation();

  return (
    <Button
      type="button"
      variant="outline"
      disabled={reload.isPending}
      onClick={() =>
        reload.mutate(undefined, {
          onError: (error) => {
            toast.add({
              type: 'error',
              title: m['dashboard.settings.reload_failed']({
                stage: error instanceof ReloadFailedError ? error.stage : 'unknown',
              }),
            });
          },
          onSuccess: () => {
            toast.add({ type: 'success', title: m['dashboard.settings.reload_succeeded']() });
          },
        })
      }
    >
      <RefreshCw />
      {m['dashboard.settings.reload']()}
    </Button>
  );
};
```

Create `packages/dashboard/src/modules/settings/components/settings-reload-button/index.ts`:

```ts
export * from './settings-reload-button';
```

`'unknown'` is a protocol-level fallback for a non-`ReloadFailedError` rejection (network failure), not translatable copy — it stays inline per the i18n rule for identifiers.

- [ ] **Step 10: Wire the button into the page header**

In `packages/dashboard/src/modules/settings/templates/settings-page/settings-page.tsx`, add the import:

```tsx
import { SettingsReloadButton } from '../../components/settings-reload-button';
```

and add `extra` to `PageContainer`, keeping the existing `title`, `subtitle`, and `breadcrumbs` props unchanged:

```tsx
      extra={<SettingsReloadButton />}
```

- [ ] **Step 11: Run the settings suite**

```bash
cd packages/dashboard && bun x rstest run src/modules/settings
```

Expected: PASS. The existing settings-page tests do not mock `use-reload-mutation`, so the real hook runs — and it needs a `QueryClientProvider` that those tests do not mount. If any settings-page test now throws "No QueryClient set", add this mock alongside the two existing `rs.mock` calls in `settings-page.test.tsx`:

```tsx
rs.mock('../../hooks/use-reload-mutation', () => ({
  useReloadMutation: () => ({ isPending: false, mutate: rs.fn() }),
}));
```

- [ ] **Step 12: Write the changeset**

Create `.changeset/settings-reload-button.md`:

```markdown
---
'@aio-proxy/dashboard': minor
'@aio-proxy/i18n': minor
'@aio-proxy/server': minor
'aio-proxy': minor
---

Add a "Reload config" action to Settings that re-reads the config file on demand and surfaces the failing reload stage. Host, port, and log level still require a restart.
```

`@aio-proxy/server` is listed because this task adds the first test coverage for its reload route; if Step 2 ends up changing no server file at all, drop that line and keep the other three.

- [ ] **Step 13: Lint, test, commit**

```bash
bun run check
```

```bash
git add -A && git commit -m "feat(dashboard): add a manual config reload action to Settings"
```

---

### Task 3: `server.password` set and clear

The wire contract gains one write-only field. `DashboardSettingsViewSchema` keeps carrying only `hasPassword` — never the password or its hash.

Two consequences to handle deliberately:

- The dashboard session token is HMAC-signed with a key derived from the password hash (`packages/server/src/dashboard-auth/dashboard-auth.ts`). Setting, changing, or clearing the password rotates that key and **invalidates every live session**, including the one making the request. The client already handles this: `dashboardFetch` maps 401 to `handleDashboardUnauthorized()` → `markDashboardSessionExpired()` → `{ status: 'unauthenticated', reason: 'expired' }`, and `dashboard.auth.login.expired` copy already exists. Nothing new to build — but do not "fix" the forced re-login, it is correct.
- `reloadConfigFile` runs `normalizeDashboardPassword` on every read, so a plaintext password on disk would be hashed in place on the next reload. Do not rely on that: hash in the route so plaintext never touches the file.

**Files:**
- Modify: `packages/types/src/dashboard/control-plane/control-plane.ts:97-109`
- Test: `packages/types/src/dashboard/control-plane/control-plane.test.ts:48-75`
- Modify: `packages/server/src/dashboard-routes/settings/settings.ts`
- Test: `packages/server/src/dashboard-routes/settings/settings.test.ts`
- Create: `packages/dashboard/src/modules/settings/components/settings-form/settings-password-field.tsx`
- Modify: `packages/dashboard/src/modules/settings/components/settings-form/settings-service-group.tsx:36-52`
- Modify: `packages/dashboard/src/modules/settings/components/settings-form/settings-form-contract.ts`
- Test: `packages/dashboard/src/modules/settings/templates/settings-page/settings-page.test.tsx:63-71`
- Modify: `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json`
- Create: `.changeset/settings-dashboard-password.md`

**Interfaces:**
- Produces: `DashboardSettingsMutationSchema.shape.password` — `z.union([z.string().min(8), z.null()]).optional()`. A string sets the password; `null` clears it; omission preserves it.
- Produces: `passwordSchema` from `./settings-form-contract` — `DashboardSettingsMutationSchema.shape.password.unwrap()`, used by the field for client-side validation.
- Produces: `SettingsPasswordField: React.FC<SettingsPasswordFieldProps>` with `{ readonly disabled: boolean; readonly settings: DashboardSettingsView; readonly onSave: (input: DashboardSettingsMutationInput) => void }`. It owns its own draft (a private composite control exposing one value), so it does **not** take the shared `SettingsFormApi`.
- Consumes: `settings.hasPassword` from `DashboardSettingsView` (unchanged).

- [ ] **Step 1: Update the types contract test to expect `password`**

In `packages/types/src/dashboard/control-plane/control-plane.test.ts`, replace the field-rejection loop at lines 62-64:

```ts
    for (const field of ['theme', 'language', 'router', 'hasPassword']) {
      expect(mutation.safeParse({ [field]: field === 'router' ? {} : 'value' }).success).toBe(false);
    }
```

Then add a new test after the `'rejects unsupported proxies and server-unowned settings'` test:

```ts
  test('distinguishes preserving, setting, and clearing the dashboard password', () => {
    const mutation = schema('DashboardSettingsMutationSchema');

    expect(mutation.parse({})).not.toHaveProperty('password');
    expect(mutation.parse({ password: null })).toEqual({ password: null });
    expect(mutation.parse({ password: 'correct horse battery' })).toEqual({ password: 'correct horse battery' });
    for (const password of ['', 'short12', 42, {}]) {
      expect(mutation.safeParse({ password }).success).toBe(false);
    }
  });
```

`'short12'` is 7 characters, one below the floor, so it pins the boundary.

- [ ] **Step 2: Run the types test to verify the new test fails**

```bash
cd packages/types && bun test src/dashboard/control-plane/control-plane.test.ts
```

Expected: FAIL — the new test fails on `mutation.parse({ password: null })` because `strictObject` rejects the unknown key. The edited rejection loop passes either way (a `password` of `'value'` is 5 characters, still under the floor), which is why the new test is what actually drives the change.

- [ ] **Step 3: Add `password` to the mutation schema**

In `packages/types/src/dashboard/control-plane/control-plane.ts`, add above `DashboardSettingsViewSchema`:

```ts
const DashboardPasswordSchema = z
  .string()
  .min(8)
  .describe('New dashboard password in plaintext; the server stores only an Argon2id hash.');
```

and add one line to `DashboardSettingsMutationSchema`, after `proxy`:

```ts
  password: z.union([DashboardPasswordSchema, z.null()]).optional(),
```

Leave `DashboardSettingsViewSchema` untouched — it must keep rejecting `password`.

- [ ] **Step 4: Run the types test to verify it passes**

```bash
cd packages/types && bun test src/dashboard/control-plane/control-plane.test.ts
```

Expected: PASS (8 tests). The view test at what is now roughly line 72 still asserts `view.safeParse({ ...settings, password: 'secret' }).success === false`; that must stay green.

- [ ] **Step 5: Write the failing server tests**

In `packages/server/src/dashboard-routes/settings/settings.test.ts`, append:

```ts
test('a new password is stored only as an Argon2id hash and never in plaintext', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const response = await put(routes, { password: 'correct horse battery' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, settings: { hasPassword: true } });

    const stored = onDisk(configPath);
    expect(stored.server.password).toStartWith('$argon2id$');
    expect(await Bun.password.verify('correct horse battery', stored.server.password)).toBe(true);
    expect(readFileSync(configPath, 'utf8')).not.toContain('correct horse battery');
  });
});

test('a null password removes the authored dashboard password', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const response = await put(routes, { password: null });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, settings: { hasPassword: false } });
    expect(onDisk(configPath).server).not.toHaveProperty('password');
  });
});

test('a password below the minimum length is rejected without changing config bytes', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const before = readFileSync(configPath, 'utf8');

    const response = await put(routes, { password: 'short12' });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, error: { code: 'config_rejected' } });
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
});

test('a password write does not require restart', async () => {
  await withSettingsFixture(async ({ routes }) => {
    const response = await put(routes, { password: 'correct horse battery' });

    expect(await response.json()).toMatchObject({ ok: true, restartRequired: false });
  });
});
```

The last test pins the live-read behavior: `createDashboardAuthentication` reads `state.currentConfig().server.password` through a closure on every request, so a password change takes effect immediately.

- [ ] **Step 6: Run the server tests to verify they fail**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/dashboard-routes/settings/settings.test.ts
```

Expected: FAIL — three of the four new tests fail with 422 `config_rejected` (the route's Zod parse now accepts `password`, but `applySettingsMutation` ignores it, so `hasPassword` never flips and `server.password` keeps its authored value). Read the failures carefully: the *reject* test passes already, which is fine.

- [ ] **Step 7: Apply the password in the settings route**

In `packages/server/src/dashboard-routes/settings/settings.ts`, `applySettingsMutation` is synchronous but hashing is async, so hash **before** the mutation callback and pass the result in.

Change the signature and add the branch:

```ts
async function applySettingsMutation(
  current: Record<string, unknown>,
  mutation: DashboardSettingsMutation,
): Promise<{ readonly next: Record<string, unknown>; readonly restartRequired: boolean }> {
```

Add this block immediately before the closing `return { next, restartRequired };`:

```ts
  if (Object.hasOwn(mutation, 'password')) {
    const server = section(next['server'], 'server');
    if (mutation.password === null) {
      if (Object.hasOwn(server, 'password')) {
        const { password: _password, ...withoutPassword } = server;
        next = { ...next, server: withoutPassword };
      }
    } else if (mutation.password !== undefined) {
      next = { ...next, server: { ...server, password: await Bun.password.hash(mutation.password) } };
    }
  }
```

Reading `next['server']` rather than `current['server']` matters: an earlier branch in the same call may already have replaced the server section, and reading `current` would discard those edits.

Then make the caller await it — in the `.put` handler, change:

```ts
        await state.configStore.mutateConfig(async (current) => {
          const result = await applySettingsMutation(current, mutation);
          restartRequired = result.restartRequired;
          return result.next;
        });
```

`mutateConfig` already accepts `Record<string, unknown> | Promise<Record<string, unknown>>` from its callback, so no signature change is needed there.

`Bun.password.hash` produces `$argon2id$v=19$m=65536,t=2,p=1$...` by default, which sits inside `ARGON2ID_LIMITS` in `packages/server/src/dashboard-auth/password.ts`, so `normalizeDashboardPassword` accepts it verbatim on the next reload instead of rejecting or re-hashing it.

- [ ] **Step 8: Run the server tests to verify they pass**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/dashboard-routes/settings/settings.test.ts
```

Expected: PASS (14 tests). The pre-existing `'PUT /settings changes only owned authoring fields'` test asserts `stored.server.password` is preserved when the mutation omits `password` — `Object.hasOwn` keeps that green.

- [ ] **Step 9: Add and reword the password i18n keys in all five locales**

Three new keys, plus a reword of `password_description` (it currently claims the field is read-only, which stops being true).

`en.json`:

```json
      "password_description": "Used to sign in to this Dashboard. Changing it signs out every session.",
      "password_save": "Set password",
      "password_clear": "Clear password",
      "password_too_short": "Use at least 8 characters.",
```

`zh-Hans.json`:

```json
      "password_description": "用于登录控制台。修改后所有会话都会退出登录。",
      "password_save": "设置密码",
      "password_clear": "清除密码",
      "password_too_short": "至少需要 8 个字符。",
```

`zh-Hant.json`:

```json
      "password_description": "用於登入控制台。修改後所有工作階段都會登出。",
      "password_save": "設定密碼",
      "password_clear": "清除密碼",
      "password_too_short": "至少需要 8 個字元。",
```

`ja.json`:

```json
      "password_description": "このダッシュボードへのサインインに使用します。変更するとすべてのセッションがサインアウトされます。",
      "password_save": "パスワードを設定",
      "password_clear": "パスワードを消去",
      "password_too_short": "8 文字以上で入力してください。",
```

`ko.json`:

```json
      "password_description": "이 대시보드에 로그인할 때 사용합니다. 변경하면 모든 세션이 로그아웃됩니다.",
      "password_save": "비밀번호 설정",
      "password_clear": "비밀번호 지우기",
      "password_too_short": "8자 이상 입력하세요.",
```

Then:

```bash
bun run i18n:compile && bun test packages/i18n/__tests__/locale-parity.test.ts
```

Expected: PASS.

- [ ] **Step 10: Rewrite the dashboard password test**

In `packages/dashboard/src/modules/settings/templates/settings-page/settings-page.test.tsx`, replace the whole `'shows only masked read-only password state without password mutation actions'` test (lines 63-71) with three tests:

```tsx
test('sets a new dashboard password from a writable field', () => {
  renderPage();

  const password = screen.getByLabelText(/Dashboard password|控制台密码|控制台密碼/u);
  expect(password).toHaveAttribute('type', 'password');
  expect(password).not.toHaveAttribute('readonly');

  fireEvent.change(password, { target: { value: 'correct horse battery' } });
  fireEvent.click(screen.getByRole('button', { name: /Set password|设置密码|設定密碼/u }));

  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(mocks.mutate).toHaveBeenCalledWith({ password: 'correct horse battery' });
});

test('refuses to submit a password below the minimum length', () => {
  renderPage();

  const password = screen.getByLabelText(/Dashboard password|控制台密码|控制台密碼/u);
  fireEvent.change(password, { target: { value: 'short12' } });
  fireEvent.click(screen.getByRole('button', { name: /Set password|设置密码|設定密碼/u }));

  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(screen.getByText(/at least 8 characters|至少需要 8|8 文字以上|8자 이상/u)).toBeInTheDocument();
});

test('clears a configured password', () => {
  renderPage();

  fireEvent.click(screen.getByRole('button', { name: /Clear password|清除密码|清除密碼/u }));

  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(mocks.mutate).toHaveBeenCalledWith({ password: null });
});
```

- [ ] **Step 11: Run the dashboard test to verify it fails**

```bash
cd packages/dashboard && bun x rstest run src/modules/settings/templates/settings-page
```

Expected: FAIL — the field is still `readOnly` and there are no `Set password` / `Clear password` buttons.

- [ ] **Step 12: Export `passwordSchema` from the form contract**

Append to `packages/dashboard/src/modules/settings/components/settings-form/settings-form-contract.ts`:

```ts
export const passwordSchema = DashboardSettingsMutationSchema.shape.password.unwrap();
```

`.unwrap()` strips the `.optional()`, leaving the `z.union([z.string().min(8), z.null()])` — so `passwordSchema.safeParse(draft)` validates a candidate string and `passwordSchema.safeParse(null)` validates a clear.

- [ ] **Step 13: Implement the password field**

Create `packages/dashboard/src/modules/settings/components/settings-form/settings-password-field.tsx`:

```tsx
import { m } from '@aio-proxy/i18n';
import type { DashboardSettingsMutationInput, DashboardSettingsView } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Field, FieldDescription, FieldError } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { useForm } from '@tanstack/react-form';

import { passwordSchema } from './settings-form-contract';

interface SettingsPasswordFieldProps {
  readonly disabled: boolean;
  readonly settings: DashboardSettingsView;
  readonly onSave: (input: DashboardSettingsMutationInput) => void;
}

export const SettingsPasswordField: React.FC<SettingsPasswordFieldProps> = ({ disabled, settings, onSave }) => {
  const form = useForm({ defaultValues: { password: '' } });

  return (
    <form.Field name="password">
      {(field) => {
        const draft = field.state.value;
        const tooShort = draft !== '' && !passwordSchema.safeParse(draft).success;
        return (
          <Field>
            <Label htmlFor="dashboard-password">{m['dashboard.settings.password']()}</Label>
            <Input
              id="dashboard-password"
              type="password"
              autoComplete="new-password"
              value={draft}
              disabled={disabled}
              aria-invalid={tooShort}
              placeholder={
                settings.hasPassword
                  ? m['dashboard.settings.password_configured']()
                  : m['dashboard.settings.password_not_configured']()
              }
              onChange={(event) => field.handleChange(event.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={disabled || draft === '' || tooShort}
                onClick={() => {
                  const parsed = passwordSchema.safeParse(draft);
                  if (!parsed.success) return;
                  onSave({ password: parsed.data });
                  field.handleChange('');
                }}
              >
                {m['dashboard.settings.password_save']()}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || !settings.hasPassword}
                onClick={() => {
                  onSave({ password: null });
                  field.handleChange('');
                }}
              >
                {m['dashboard.settings.password_clear']()}
              </Button>
            </div>
            <FieldDescription>
              {settings.hasPassword
                ? m['dashboard.settings.password_configured']()
                : m['dashboard.settings.password_not_configured']()}{' '}
              {m['dashboard.settings.password_description']()}
            </FieldDescription>
            <FieldError>{tooShort ? m['dashboard.settings.password_too_short']() : null}</FieldError>
          </Field>
        );
      }}
    </form.Field>
  );
};
```

The draft lives in this component's own `useForm` rather than the shared `SettingsFormApi`, because `SettingsForm` resets that form from the server view on every mutation and a password draft has no server-side counterpart to reset from. This is the "self-contained composite control keeps its private draft" case in `packages/dashboard/CLAUDE.md`.

Note the `disabled` on the Set button: the test in Step 10 clicks it after typing `'short12'` and expects no mutation plus visible error text. A disabled button satisfies both — `fireEvent.click` on a disabled button dispatches nothing, and `aria-invalid` plus `FieldError` render from `tooShort`.

- [ ] **Step 14: Swap the read-only field for the new component**

In `packages/dashboard/src/modules/settings/components/settings-form/settings-service-group.tsx`, replace the entire `<Field>` block at lines 36-52 with:

```tsx
        <SettingsPasswordField disabled={disabled} settings={settings} onSave={onSave} />
```

Add the import:

```tsx
import { SettingsPasswordField } from './settings-password-field';
```

Drop the now-unused imports from this file — `Field`, `FieldDescription`, and `Label` are still used by the `proxy` field, but `Input` is too, so check what actually became unused before deleting; `bun run check` will flag anything left over.

- [ ] **Step 15: Run the dashboard tests to verify they pass**

```bash
cd packages/dashboard && bun x rstest run src/modules/settings
```

Expected: PASS. If the `'refuses to submit a password below the minimum length'` test fails on the error text, confirm `bun run i18n:compile` ran in Step 9 — the compiled accessor is what `m['dashboard.settings.password_too_short']()` resolves through.

- [ ] **Step 16: Write the changeset**

Create `.changeset/settings-dashboard-password.md`:

```markdown
---
'@aio-proxy/dashboard': minor
'@aio-proxy/i18n': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'aio-proxy': minor
---

Set and clear the Dashboard password from Settings. The password is stored only as an Argon2id hash, and changing it signs out every existing session.
```

- [ ] **Step 17: Lint, test, commit**

```bash
bun run check
```

```bash
git add -A && git commit -m "feat(settings): set and clear the dashboard password"
```

---

### Task 4: `server.apiKeys` add, edit, and remove

The largest task. API keys are secrets, so the view masks them and the mutation is write-only — same discipline as `redactSecrets`, which already special-cases `apiKeys` arrays by masking each entry's `key` to `****` while leaving `label` readable.

The one genuinely tricky requirement: authored keys may be `{{env.NAME}}` templates. The runtime config the route sees has already had templates expanded by `resolveConfigTemplates`, so the route cannot recover the original template from the config it reads — but `configStore.mutateConfig` hands it the *authored* record, which still has the template. So the mutation identifies rows to keep by their **index into the authored array** rather than by value:

- `{ retain: <index>, label?: <string> }` — keep the authored `key` at that index byte-for-byte (template intact), optionally updating the label.
- `{ key: <string>, label?: <string> }` — a new or replaced key in plaintext.

The submitted array is the complete desired list, in order. Omitting `apiKeys` preserves the authored array untouched; sending `[]` removes every key.

**Files:**
- Modify: `packages/types/src/dashboard/control-plane/control-plane.ts`
- Test: `packages/types/src/dashboard/control-plane/control-plane.test.ts`
- Modify: `packages/server/src/dashboard-routes/settings/settings.ts`
- Test: `packages/server/src/dashboard-routes/settings/settings.test.ts`
- Create: `packages/dashboard/src/modules/settings/components/settings-form/settings-api-keys-group.tsx`
- Modify: `packages/dashboard/src/modules/settings/components/settings-form/settings-form-contract.ts`
- Modify: `packages/dashboard/src/modules/settings/components/settings-form/settings-form.tsx`
- Test: `packages/dashboard/src/modules/settings/templates/settings-page/settings-page.test.tsx`
- Modify: `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json`
- Create: `.changeset/settings-api-keys.md`

**Interfaces:**
- Produces: `DashboardApiKeyViewSchema` = `z.strictObject({ key: z.literal('****'), label: z.string().min(1).optional() })`; `DashboardSettingsViewSchema.apiKeys` = `z.array(DashboardApiKeyViewSchema)`.
- Produces: `DashboardApiKeyMutationSchema` = `z.union([z.strictObject({ retain: z.number().int().min(0), label: z.string().min(1).optional() }), z.strictObject({ key: StaticApiKey, label: z.string().min(1).optional() })])`; `DashboardSettingsMutationSchema.apiKeys` = `z.array(DashboardApiKeyMutationSchema).optional()`.
- Produces: `DashboardApiKeyView`, `DashboardApiKeyMutation` type exports.
- Produces: `SettingsApiKeysGroup: React.FC<SettingsApiKeysGroupProps>` with `{ readonly disabled: boolean; readonly settings: DashboardSettingsView; readonly onSave: (input: DashboardSettingsMutationInput) => void }` — owns its own row draft like `SettingsPasswordField` does.
- Consumes: `apiKeysSchema` from `./settings-form-contract`.
- Consumes: `hasReservedAgentTokenPrefix` — already exported from `@aio-proxy/types`.

- [ ] **Step 1: Write the failing types contract test**

In `packages/types/src/dashboard/control-plane/control-plane.test.ts`, extend the shared `settings` fixture at lines 12-19 with an `apiKeys` field:

```ts
const settings = {
  host: '127.0.0.1',
  port: 9317,
  proxy: 'https://proxy.example',
  logging: { enabled: true, retentionDays: 3, level: 'info' },
  retryAfterCapMs: 30_000,
  hasPassword: true,
  apiKeys: [{ key: '****', label: 'ci' }, { key: '****' }],
} as const;
```

Then add a new test inside the `'dashboard settings control-plane contracts'` describe block:

```ts
  test('masks API keys in the view and distinguishes retained from replaced keys in the mutation', () => {
    const view = schema('DashboardSettingsViewSchema');
    const mutation = schema('DashboardSettingsMutationSchema');

    expect(view.parse(settings)).toEqual(settings);
    expect(view.safeParse({ ...settings, apiKeys: [{ key: 'sk-real-secret' }] }).success).toBe(false);
    expect(view.safeParse({ ...settings, apiKeys: [{ key: '****', label: '' }] }).success).toBe(false);

    expect(mutation.parse({})).not.toHaveProperty('apiKeys');
    expect(mutation.parse({ apiKeys: [] })).toEqual({ apiKeys: [] });
    expect(mutation.parse({ apiKeys: [{ retain: 0 }, { retain: 1, label: 'renamed' }, { key: 'sk-new' }] })).toEqual({
      apiKeys: [{ retain: 0 }, { retain: 1, label: 'renamed' }, { key: 'sk-new' }],
    });
    for (const entry of [
      { retain: -1 },
      { retain: 1.5 },
      { retain: 0, key: 'sk-both' },
      { key: '' },
      { key: 'aio_agent_at_forged' },
      { key: 'aio_agent_rt_forged' },
      { label: 'no key' },
      {},
    ]) {
      expect(mutation.safeParse({ apiKeys: [entry] }).success).toBe(false);
    }
  });
```

`{ retain: 0, key: 'sk-both' }` must fail: both arms are `strictObject`, so a mixed object matches neither.

- [ ] **Step 2: Run the types test to verify it fails**

```bash
cd packages/types && bun test src/dashboard/control-plane/control-plane.test.ts
```

Expected: FAIL — every test using the `settings` fixture now fails too, because `DashboardSettingsViewSchema` is a `strictObject` that rejects the unknown `apiKeys` key. That is expected; Step 3 fixes all of them at once.

- [ ] **Step 3: Add `apiKeys` to both schemas**

In `packages/types/src/dashboard/control-plane/control-plane.ts`, the static-key rule lives in `packages/types/src/config/config.ts` as a private `StaticApiKeySchema`. Rather than exporting that (which would widen the config module's public surface for one consumer), reuse the underlying predicate — it is already exported.

Add the import at the top, next to the existing type imports:

```ts
import { hasReservedAgentTokenPrefix } from '../../agent-integration';
```

Then add above `DashboardSettingsViewSchema`:

```ts
const DashboardApiKeyLabelSchema = z.string().min(1);

const DashboardApiKeySecretSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !hasReservedAgentTokenPrefix(value),
    'Static API keys cannot use reserved aio_agent_at_ or aio_agent_rt_ prefixes',
  );

export const DashboardApiKeyViewSchema = z.strictObject({
  key: z.literal('****'),
  label: DashboardApiKeyLabelSchema.optional(),
});

export const DashboardApiKeyMutationSchema = z.union([
  z.strictObject({ retain: z.number().int().min(0), label: DashboardApiKeyLabelSchema.optional() }),
  z.strictObject({ key: DashboardApiKeySecretSchema, label: DashboardApiKeyLabelSchema.optional() }),
]);
```

Add one line to `DashboardSettingsViewSchema`, after `hasPassword`:

```ts
  apiKeys: z.array(DashboardApiKeyViewSchema),
```

Add one line to `DashboardSettingsMutationSchema`, after `password`:

```ts
  apiKeys: z.array(DashboardApiKeyMutationSchema).optional(),
```

And two type exports at the bottom:

```ts
export type DashboardApiKeyView = z.output<typeof DashboardApiKeyViewSchema>;
export type DashboardApiKeyMutation = z.output<typeof DashboardApiKeyMutationSchema>;
```

Verify the import path for `hasReservedAgentTokenPrefix` resolves from `src/dashboard/control-plane/` — it is defined in `packages/types/src/agent-integration/agent-integration.ts` and re-exported from that directory's barrel, so `'../../agent-integration'` is correct. If oxlint reports an unresolved path, match whatever specifier `packages/types/src/config/config.ts:4` uses, adjusted for the extra directory level.

- [ ] **Step 4: Run the types test to verify it passes**

```bash
cd packages/types && bun test src/dashboard/control-plane/control-plane.test.ts
```

Expected: PASS (9 tests).

- [ ] **Step 5: Write the failing server tests**

In `packages/server/src/dashboard-routes/settings/settings.test.ts`, first give the fixture some authored keys. Change the `server` block of `authoredConfig` to include:

```ts
    apiKeys: [{ key: '{{env.SETTINGS_API_KEY}}', label: 'ci' }, { key: 'sk-plain-preserved' }],
```

and add the env var to both the `previous` snapshot and the assignments in `withSettingsFixture`:

```ts
  const previous = {
    SETTINGS_API_KEY: process.env['SETTINGS_API_KEY'],
    SETTINGS_HOST: process.env['SETTINGS_HOST'],
    SETTINGS_LOG_DIR: process.env['SETTINGS_LOG_DIR'],
    SETTINGS_PROXY_HOST: process.env['SETTINGS_PROXY_HOST'],
    SETTINGS_ROOT_PROXY: process.env['SETTINGS_ROOT_PROXY'],
  };
  process.env['SETTINGS_API_KEY'] = 'sk-from-env';
```

Update the existing GET assertion (lines 107-115) to expect the masked array and to guard the new secrets:

```ts
    expect(JSON.parse(text)).toEqual({
      apiKeys: [{ key: '****', label: 'ci' }, { key: '****' }],
      hasPassword: true,
      host: '127.0.0.1',
      logging: { enabled: false, level: 'info', retentionDays: 3 },
      port: 9_317,
      proxy: '****',
      retryAfterCapMs: 30_000,
    });
    expect(text).not.toMatch(
      /password-preserved|user:password|SETTINGS_|root-preserved|sk-from-env|sk-plain-preserved/u,
    );
```

Then append the new tests:

```ts
test('a retained API key keeps its authored template byte-for-byte', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const response = await put(routes, { apiKeys: [{ retain: 0, label: 'ci-renamed' }, { retain: 1 }] });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      settings: { apiKeys: [{ key: '****', label: 'ci-renamed' }, { key: '****' }] },
    });
    expect(onDisk(configPath).server.apiKeys).toEqual([
      { key: '{{env.SETTINGS_API_KEY}}', label: 'ci-renamed' },
      { key: 'sk-plain-preserved' },
    ]);
  });
});

test('a new API key is appended and an unlisted authored key is removed', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const response = await put(routes, { apiKeys: [{ retain: 0, label: 'ci' }, { key: 'sk-added', label: 'laptop' }] });

    expect(response.status).toBe(200);
    expect(onDisk(configPath).server.apiKeys).toEqual([
      { key: '{{env.SETTINGS_API_KEY}}', label: 'ci' },
      { key: 'sk-added', label: 'laptop' },
    ]);
  });
});

test('an empty API key array removes every authored key', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const response = await put(routes, { apiKeys: [] });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, settings: { apiKeys: [] } });
    expect(onDisk(configPath).server.apiKeys).toEqual([]);
  });
});

test('an omitted API key array preserves the authored keys', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const response = await put(routes, { retryAfterCapMs: 11_000 });

    expect(response.status).toBe(200);
    expect(onDisk(configPath).server.apiKeys).toEqual(authoredConfig.server.apiKeys);
  });
});

test('a retain index outside the authored array and a reserved-prefix key are rejected', async () => {
  await withSettingsFixture(async ({ configPath, routes }) => {
    const before = readFileSync(configPath, 'utf8');
    for (const apiKeys of [[{ retain: 5 }], [{ key: 'aio_agent_at_forged' }]]) {
      const response = await put(routes, { apiKeys });

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ ok: false, error: { code: 'config_rejected' } });
      expect(readFileSync(configPath, 'utf8')).toBe(before);
    }
  });
});

test('an API key write does not require restart', async () => {
  await withSettingsFixture(async ({ routes }) => {
    const response = await put(routes, { apiKeys: [{ retain: 0 }] });

    expect(await response.json()).toMatchObject({ ok: true, restartRequired: false });
  });
});
```

`{ key: 'aio_agent_at_forged' }` is rejected by the Zod validator before the route runs; `{ retain: 5 }` passes Zod (it is a valid non-negative integer) and must be rejected by the route, which is what makes both cases worth testing together.

- [ ] **Step 6: Run the server tests to verify they fail**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/dashboard-routes/settings/settings.test.ts
```

Expected: FAIL — the GET test fails because the view has no `apiKeys` yet, and the retain/append/empty tests fail because `applySettingsMutation` ignores the field.

- [ ] **Step 7: Project `apiKeys` into the settings view**

In `packages/server/src/dashboard-routes/settings/settings.ts`, add to `settingsView`'s returned object, keeping the existing alphabetical ordering:

```ts
    apiKeys: config.server.apiKeys.map((entry) => ({
      key: '****' as const,
      ...(entry.label === undefined ? {} : { label: entry.label }),
    })),
```

Spreading conditionally rather than writing `label: entry.label` matters: `DashboardApiKeyViewSchema` is strict about `label` being a non-empty string when present, and an explicit `label: undefined` would serialize the key away in JSON but still fail a direct schema parse in tests.

- [ ] **Step 8: Resolve `retain` indices in the mutation**

Still in `packages/server/src/dashboard-routes/settings/settings.ts`, add a helper above `applySettingsMutation`:

```ts
function resolveApiKeys(
  authored: unknown,
  submitted: readonly DashboardApiKeyMutation[],
): readonly Record<string, unknown>[] {
  const previous = Array.isArray(authored) ? authored : [];
  return submitted.map((entry) => {
    const label = entry.label === undefined ? {} : { label: entry.label };
    if (!('retain' in entry)) return { key: entry.key, ...label };
    const kept = previous[entry.retain];
    if (!isPlainObject(kept) || typeof kept['key'] !== 'string') {
      throw new TypeError(`server.apiKeys[${entry.retain}] cannot be retained`);
    }
    return { ...kept, key: kept['key'], ...label };
  });
}
```

`{ ...kept, key: kept['key'], ...label }` preserves any unknown authored fields on that entry (forward compatibility, same as the `future*` sentinels elsewhere in the config) while making the retained `key` explicit and letting a submitted `label` override the authored one. A submitted entry with no `label` drops an authored label — that is intentional: the submitted array is the complete desired state.

Add the import for the type at the top of the file, extending the existing `@aio-proxy/types` import block:

```ts
  type DashboardApiKeyMutation,
```

Then add this block inside `applySettingsMutation`, right after the `password` block:

```ts
  if (mutation.apiKeys !== undefined) {
    const server = section(next['server'], 'server');
    next = { ...next, server: { ...server, apiKeys: resolveApiKeys(server['apiKeys'], mutation.apiKeys) } };
  }
```

The `TypeError` thrown by `resolveApiKeys` is already mapped to 422 `config_rejected` by the route's existing catch block, which is what the `{ retain: 5 }` case relies on.

- [ ] **Step 9: Run the server tests to verify they pass**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/dashboard-routes/settings/settings.test.ts
```

Expected: PASS (20 tests).

- [ ] **Step 10: Add the API key i18n keys to all five locales**

`en.json`:

```json
      "api_keys_group": "Caller API keys",
      "api_keys_description": "Keys that clients present to this proxy. Stored keys are never shown again.",
      "api_keys_empty": "No API keys configured.",
      "api_keys_label": "Label",
      "api_keys_value": "Key",
      "api_keys_stored": "Stored",
      "api_keys_add": "Add key",
      "api_keys_remove": "Remove key {label}",
      "api_keys_unnamed": "without a label",
      "api_keys_save": "Save keys",
```

`zh-Hans.json`:

```json
      "api_keys_group": "调用方 API 密钥",
      "api_keys_description": "客户端访问本代理时使用的密钥。已保存的密钥不会再次显示。",
      "api_keys_empty": "尚未配置 API 密钥。",
      "api_keys_label": "标签",
      "api_keys_value": "密钥",
      "api_keys_stored": "已保存",
      "api_keys_add": "添加密钥",
      "api_keys_remove": "移除密钥 {label}",
      "api_keys_unnamed": "（无标签）",
      "api_keys_save": "保存密钥",
```

`zh-Hant.json`:

```json
      "api_keys_group": "呼叫方 API 金鑰",
      "api_keys_description": "用戶端存取本代理時使用的金鑰。已儲存的金鑰不會再次顯示。",
      "api_keys_empty": "尚未設定 API 金鑰。",
      "api_keys_label": "標籤",
      "api_keys_value": "金鑰",
      "api_keys_stored": "已儲存",
      "api_keys_add": "新增金鑰",
      "api_keys_remove": "移除金鑰 {label}",
      "api_keys_unnamed": "（無標籤）",
      "api_keys_save": "儲存金鑰",
```

`ja.json`:

```json
      "api_keys_group": "呼び出し元 API キー",
      "api_keys_description": "クライアントがこのプロキシに提示するキーです。保存済みのキーは再表示されません。",
      "api_keys_empty": "API キーは設定されていません。",
      "api_keys_label": "ラベル",
      "api_keys_value": "キー",
      "api_keys_stored": "保存済み",
      "api_keys_add": "キーを追加",
      "api_keys_remove": "キー {label} を削除",
      "api_keys_unnamed": "（ラベルなし）",
      "api_keys_save": "キーを保存",
```

`ko.json`:

```json
      "api_keys_group": "호출자 API 키",
      "api_keys_description": "클라이언트가 이 프록시에 제시하는 키입니다. 저장된 키는 다시 표시되지 않습니다.",
      "api_keys_empty": "구성된 API 키가 없습니다.",
      "api_keys_label": "라벨",
      "api_keys_value": "키",
      "api_keys_stored": "저장됨",
      "api_keys_add": "키 추가",
      "api_keys_remove": "키 {label} 제거",
      "api_keys_unnamed": "(라벨 없음)",
      "api_keys_save": "키 저장",
```

Then:

```bash
bun run i18n:compile && bun test packages/i18n/__tests__/locale-parity.test.ts
```

Expected: PASS. `api_keys_remove` carries `{label}` in all five locales.

- [ ] **Step 11: Write the failing dashboard tests**

In `packages/dashboard/src/modules/settings/templates/settings-page/settings-page.test.tsx`, first extend the fixture at lines 22-29:

```tsx
const settings: DashboardSettingsView = {
  apiKeys: [{ key: '****', label: 'ci' }, { key: '****' }],
  hasPassword: true,
  host: '127.0.0.1',
  logging: { enabled: true, level: 'info', retentionDays: 3 },
  port: 9317,
  proxy: '****',
  retryAfterCapMs: 30_000,
};
```

Then append:

```tsx
test('lists stored API keys masked and retains them by index when saving', () => {
  renderPage();

  const group = screen.getByTestId('settings-group-api-keys');
  expect(within(group).getAllByDisplayValue('****')).toHaveLength(2);

  fireEvent.change(within(group).getAllByLabelText(/Label|标签|標籤|ラベル|라벨/u)[0] as HTMLElement, {
    target: { value: 'ci-renamed' },
  });
  fireEvent.click(within(group).getByRole('button', { name: /Save keys|保存密钥|儲存金鑰|キーを保存|키 저장/u }));

  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(mocks.mutate).toHaveBeenCalledWith({
    apiKeys: [{ retain: 0, label: 'ci-renamed' }, { retain: 1 }],
  });
});

test('adds a new API key and sends it in plaintext exactly once', () => {
  renderPage();

  const group = screen.getByTestId('settings-group-api-keys');
  fireEvent.click(within(group).getByRole('button', { name: /Add key|添加密钥|新增金鑰|キーを追加|키 추가/u }));

  const values = within(group).getAllByLabelText(/^Key$|^密钥$|^金鑰$|^キー$|^키$/u);
  fireEvent.change(values[values.length - 1] as HTMLElement, { target: { value: 'sk-added' } });
  fireEvent.click(within(group).getByRole('button', { name: /Save keys|保存密钥|儲存金鑰|キーを保存|키 저장/u }));

  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(mocks.mutate).toHaveBeenCalledWith({
    apiKeys: [{ retain: 0, label: 'ci' }, { retain: 1 }, { key: 'sk-added' }],
  });
});

test('removes a stored API key', () => {
  renderPage();

  const group = screen.getByTestId('settings-group-api-keys');
  fireEvent.click(within(group).getByRole('button', { name: /Remove key ci|移除密钥 ci|移除金鑰 ci|キー ci|키 ci/u }));
  fireEvent.click(within(group).getByRole('button', { name: /Save keys|保存密钥|儲存金鑰|キーを保存|키 저장/u }));

  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(mocks.mutate).toHaveBeenCalledWith({ apiKeys: [{ retain: 1 }] });
});
```

- [ ] **Step 12: Run the dashboard test to verify it fails**

```bash
cd packages/dashboard && bun x rstest run src/modules/settings/templates/settings-page
```

Expected: FAIL — no element with `data-testid="settings-group-api-keys"`.

- [ ] **Step 13: Export `apiKeysSchema` from the form contract**

Append to `packages/dashboard/src/modules/settings/components/settings-form/settings-form-contract.ts`:

```ts
export const apiKeysSchema = DashboardSettingsMutationSchema.shape.apiKeys.unwrap();
```

- [ ] **Step 14: Implement the API keys card**

Create `packages/dashboard/src/modules/settings/components/settings-form/settings-api-keys-group.tsx`:

```tsx
import { m } from '@aio-proxy/i18n';
import type {
  DashboardApiKeyMutation,
  DashboardSettingsMutationInput,
  DashboardSettingsView,
} from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useRef, useState } from 'react';

import { apiKeysSchema } from './settings-form-contract';

interface ApiKeyRow {
  readonly id: number;
  readonly retain?: number;
  readonly key: string;
  readonly label: string;
}

interface SettingsApiKeysGroupProps {
  readonly disabled: boolean;
  readonly settings: DashboardSettingsView;
  readonly onSave: (input: DashboardSettingsMutationInput) => void;
}

const rowsFromSettings = (settings: DashboardSettingsView): readonly ApiKeyRow[] =>
  settings.apiKeys.map((entry, index) => ({ id: index, key: entry.key, label: entry.label ?? '', retain: index }));

const mutationEntries = (rows: readonly ApiKeyRow[]): readonly DashboardApiKeyMutation[] =>
  rows.flatMap((row) => {
    const label = row.label.trim() === '' ? {} : { label: row.label.trim() };
    if (row.retain !== undefined) return [{ retain: row.retain, ...label }];
    if (row.key.trim() === '') return [];
    return [{ key: row.key.trim(), ...label }];
  });

export const SettingsApiKeysGroup: React.FC<SettingsApiKeysGroupProps> = ({ disabled, settings, onSave }) => {
  const [rows, setRows] = useState<readonly ApiKeyRow[]>(() => rowsFromSettings(settings));
  const nextId = useRef(settings.apiKeys.length);

  const entries = mutationEntries(rows);
  const parsed = apiKeysSchema.safeParse(entries);

  return (
    <Card data-testid="settings-group-api-keys">
      <CardHeader>
        <CardTitle>
          <h2>{m['dashboard.settings.api_keys_group']()}</h2>
        </CardTitle>
        <CardDescription>{m['dashboard.settings.api_keys_description']()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m['dashboard.settings.api_keys_empty']()}</p>
        ) : null}
        {rows.map((row) => (
          <div key={row.id} className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label htmlFor={`api-key-label-${row.id}`} className="text-xs">
                {m['dashboard.settings.api_keys_label']()}
              </Label>
              <Input
                id={`api-key-label-${row.id}`}
                className="h-7 text-xs"
                value={row.label}
                disabled={disabled}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((entry) => (entry.id === row.id ? { ...entry, label: event.target.value } : entry)),
                  )
                }
              />
            </div>
            <div className="flex-1 space-y-1">
              <Label htmlFor={`api-key-value-${row.id}`} className="text-xs">
                {m['dashboard.settings.api_keys_value']()}
              </Label>
              <Input
                id={`api-key-value-${row.id}`}
                className="h-7 font-mono text-xs"
                type={row.retain === undefined ? 'text' : 'password'}
                autoComplete="off"
                value={row.key}
                readOnly={row.retain !== undefined}
                disabled={disabled}
                placeholder={row.retain === undefined ? undefined : m['dashboard.settings.api_keys_stored']()}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((entry) => (entry.id === row.id ? { ...entry, key: event.target.value } : entry)),
                  )
                }
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={disabled}
              aria-label={m['dashboard.settings.api_keys_remove']({
                label: row.label || m['dashboard.settings.api_keys_unnamed'](),
              })}
              onClick={() => setRows((current) => current.filter((entry) => entry.id !== row.id))}
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={disabled}
            onClick={() => {
              const id = nextId.current;
              nextId.current += 1;
              setRows((current) => [...current, { id, key: '', label: '' }]);
            }}
          >
            <PlusIcon data-icon="inline-start" />
            {m['dashboard.settings.api_keys_add']()}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={disabled || !parsed.success}
            onClick={() => {
              if (!parsed.success) return;
              onSave({ apiKeys: parsed.data });
            }}
          >
            {m['dashboard.settings.api_keys_save']()}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
```

A stored row's key input is `readOnly` and shows the `****` the server sent, so a user cannot pretend to edit a value they cannot see. Editing a stored key means removing the row and adding a new one — which is exactly what the wire contract expresses.

The row list is local `useState` rather than a TanStack Form array field for the same reason the password draft is: `SettingsForm` resets its form from the server view on every mutation, and half of these rows (`retain` markers) have no editable server counterpart. This is the "self-contained composite control keeps its private draft" allowance in `packages/dashboard/CLAUDE.md`; the value it exposes is the single `apiKeys` array handed to `onSave`.

- [ ] **Step 15: Render the card in the form**

In `packages/dashboard/src/modules/settings/components/settings-form/settings-form.tsx`, add the import:

```tsx
import { SettingsApiKeysGroup } from './settings-api-keys-group';
```

and render it between `SettingsServiceGroup` and `SettingsLogsGroup`:

```tsx
      <SettingsApiKeysGroup disabled={mutation.isPending} settings={settings} onSave={save} />
```

- [ ] **Step 16: Run the dashboard tests to verify they pass**

```bash
cd packages/dashboard && bun x rstest run src/modules/settings
```

Expected: PASS. Two things to watch:

- The existing group-ordering test asserts the service heading precedes the logs heading. Inserting the API keys card between them keeps that true.
- `SettingsApiKeysGroup` seeds `useState` from `settings` only on first mount. The `'restores authoritative values after a rejected mutation'` test rerenders with the same `settings` object, so nothing there depends on reseeding. If a future test needs the rows to follow a server change, add a `useEffect` reset keyed on `settings.apiKeys` — do not add one speculatively now.

- [ ] **Step 17: Run the full preflight**

```bash
bun run preflight
```

Expected: PASS — oxlint, oxfmt check, and every package's unit tests. This is the first full run across all four tasks; if `@aio-proxy/dashboard` type-checks fail on `DashboardSettingsView` fixtures in unrelated tests, those fixtures need the new `apiKeys` field added (the schema is strict, so the compiler will name each one).

- [ ] **Step 18: Write the changeset**

Create `.changeset/settings-api-keys.md`:

```markdown
---
'@aio-proxy/dashboard': minor
'@aio-proxy/i18n': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'aio-proxy': minor
---

Add, relabel, and remove caller API keys from Settings. Stored keys stay masked and are never sent back to the browser, and authored `{{env.NAME}}` key templates survive a write unchanged.
```

- [ ] **Step 19: Commit**

```bash
git add -A && git commit -m "feat(settings): manage caller API keys from the dashboard"
```
