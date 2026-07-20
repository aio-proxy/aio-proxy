# Dashboard Login Brand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse the sidebar's AIO Proxy brand block on the Dashboard login page and match the console's gray background.

**Architecture:** Move the existing logo, wordmark, and localized tagline into a sidebar-independent React component. Render that component from both `SideMenu` and `LoginPage`; keep authentication and navigation behavior unchanged.

**Tech Stack:** React, TypeScript, Tailwind CSS, Rstest, Testing Library, Bun

## Global Constraints

- Use existing Dashboard UI and Tailwind tokens; add no dependency.
- Keep all user-facing copy in `@aio-proxy/i18n`; add no new copy.
- Each `.tsx` file declares exactly one arrow-function React component.
- Change only brand rendering and the login page background.

---

### Task 1: Share the AIO Proxy brand between sidebar and login

**Files:**
- Create: `packages/dashboard/src/components/aio-proxy-brand.tsx`
- Modify: `packages/dashboard/src/components/side-menu/side-menu.tsx`
- Modify: `packages/dashboard/src/modules/auth/templates/login-page.tsx`
- Test: `packages/dashboard/src/modules/auth/templates/login-page.test.tsx`

**Interfaces:**
- Consumes: `m["brand.tagline"]()` from `@aio-proxy/i18n`.
- Produces: `AioProxyBrand: React.FC`, a prop-free shared brand component.

- [ ] **Step 1: Write the failing login presentation check**

Add these assertions immediately after `render(<LoginPage reason="expired" />)` in the existing expired-session test:

```tsx
expect(screen.getByTitle("AIO")).toBeInTheDocument();
expect(screen.getByText("Proxy")).toBeInTheDocument();
expect(screen.getByText("All-in-one Gateway")).toBeInTheDocument();
expect(screen.getByRole("main")).toHaveClass("bg-sidebar");
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- login-page.test.tsx
```

Expected: the expired-session test fails because the login page has no `AIO` SVG title, no separate `Proxy` wordmark or tagline, and its main element uses `bg-background`.

- [ ] **Step 3: Extract the shared brand component**

Create `packages/dashboard/src/components/aio-proxy-brand.tsx`:

```tsx
import { m } from "@aio-proxy/i18n";

export const AioProxyBrand: React.FC = () => {
  return (
    <div>
      <div
        className="mb-1 flex items-center gap-1 font-heading text-[calc(var(--logo-height)*0.75)] font-semibold text-foreground"
        style={{ "--logo-height": "24px" } as React.CSSProperties}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 672 480"
          className="inline-block h-(--logo-height) w-auto fill-current"
        >
          <title>AIO</title>
          <path d="M515.704 110q29.952 0 54.528 10.368 24.96 10.368 43.392 29.184 18.816 18.816 28.8 44.16t9.984 55.296-9.984 55.296-28.8 44.16q-18.432 18.816-43.392 29.184-24.576 10.368-54.528 10.368-29.568 0-54.528-10.368t-43.776-28.8q-18.431-18.816-28.416-44.16Q379 278.96 379 249.008q0-30.336 9.984-55.296 9.984-25.344 28.416-44.16 18.816-18.816 43.776-29.184T515.704 110M379 385h-59L220 116h59zm-114.496-1.2h-59.136l-21.112-56.448H81.113L59.832 383.8H3L108.216 115h51.456zm251.2-219.272q-16.896 0-31.104 6.528-14.208 6.144-24.96 17.664-10.752 11.136-16.512 26.496-5.376 15.36-5.376 33.792t5.376 33.792q5.76 15.36 16.512 26.88t24.96 17.664 31.104 6.144 31.104-6.144q14.592-6.144 24.96-17.664t16.128-26.88q6.144-15.36 6.144-33.792t-6.144-33.792q-5.76-15.36-16.128-26.496-10.369-11.52-24.96-17.664-14.208-6.528-31.104-6.528M132.792 184.12a1365 1365 0 0 1-5.76 19.2 406 406 0 0 1-6.528 18.816 799 799 0 0 0-6.528 18.048L98.63 280.888h68.248l-15.654-41.856a1316 1316 0 0 1-5.76-15.744q-3.072-9.6-6.528-20.352a15412 15412 0 0 1-6.09-18.987z" />
        </svg>
        <span>Proxy</span>
      </div>
      <div className="truncate text-xs text-muted-foreground">{m["brand.tagline"]()}</div>
    </div>
  );
};
```

- [ ] **Step 4: Replace the sidebar's inline brand markup**

Import the component in `side-menu.tsx`:

```tsx
import { AioProxyBrand } from "@/components/aio-proxy-brand";
```

Replace the current contents of `<SidebarHeader>` with:

```tsx
<SidebarHeader>
  <div className="ml-3">
    <AioProxyBrand />
  </div>
</SidebarHeader>
```

- [ ] **Step 5: Reuse the brand and gray console background on login**

Import the component in `login-page.tsx`:

```tsx
import { AioProxyBrand } from "@/components/aio-proxy-brand";
```

Change the login wrapper and card header brand:

```tsx
<main className="flex min-h-dvh items-center justify-center bg-sidebar px-4 py-8">
  <Card className="w-full max-w-sm">
    <CardHeader>
      <div className="mb-4">
        <AioProxyBrand />
      </div>
```

Leave the title, description, form, validation, and login submission code unchanged.

- [ ] **Step 6: Run the focused test and Dashboard checks**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- login-page.test.tsx
rtk bun run --filter @aio-proxy/dashboard build
rtk bun run check
```

Expected: all commands pass.

- [ ] **Step 7: Run repository preflight**

Run:

```bash
rtk bun run preflight
```

Expected: lint, formatting, types, builds, and all unit tests pass.

- [ ] **Step 8: Commit and push the PR branch**

```bash
rtk git add packages/dashboard/src/components/aio-proxy-brand.tsx packages/dashboard/src/components/side-menu/side-menu.tsx packages/dashboard/src/modules/auth/templates/login-page.tsx packages/dashboard/src/modules/auth/templates/login-page.test.tsx docs/superpowers/plans/2026-07-20-dashboard-login-brand.md
rtk git commit -m "feat: share dashboard brand on login" -m "Co-authored-by: Codex <noreply@openai.com>"
rtk git push
```

Expected: `codex/dashboard-password-auth` is updated and the existing Draft PR includes the change.
