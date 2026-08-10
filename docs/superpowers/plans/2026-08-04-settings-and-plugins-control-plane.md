# Settings and Plugins Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add production Settings and Plugins pages with a secure, typed local control plane for config edits and plugin lifecycle operations.

**Architecture:** Generalise the existing config-store/provider-mutation safety model into narrow settings and plugin routes rather than exposing a writable raw config editor. Each mutation validates authoring and materialized values, preserves templates and redacted secrets, writes atomically through ConfigStore, and reports reload rejection. Dashboard uses typed services, TanStack Form, and query invalidation; plugins have a separate install confirmation and uninstall boundary.

**Tech Stack:** Bun, TypeScript, Zod 4, Hono, React 19, TanStack Query/Form/Router, Base UI, plugin runtime, Rstest.

## Global Constraints

- Settings is a single vertical form grouped as service/access/network, logs/retries, and appearance/language. Request logging uses a Switch in the logs/retries group header.
- Secret values stay redacted and omitted values preserve the authored template or secret; no generic raw-config write endpoint is exposed.
- Plugin built-ins are identified and cannot be uninstalled. Third-party rows own uninstall; only plugin options open configuration drawers.
- Plugin install requires package name, optional registry, explicit local-code trust confirmation when untrusted, and then enables the installed package.
- Install/uninstall must use the existing npm lock/error taxonomy from @aio-proxy/core; do not shell out from a React component.
- All endpoint writes remain protected by existing Dashboard loopback, CSRF, and dashboard-auth middleware.
- All UI copy is i18n; use shared Dialog/Drawer/Switch/Table/Button components and TanStack Form for editable data.

---

## File Map

- packages/types/src/dashboard.ts: settings/plugin dashboard DTOs and mutation schemas.
- packages/server/src/dashboard-routes/settings.ts and plugins.ts: narrow read/write routes.
- packages/server/src/config-store/: one public atomic mutation helper for non-provider config fields if existing APIs cannot express it.
- packages/dashboard/src/modules/settings and modules/plugins: typed services, hooks, components, and templates.
- packages/dashboard/src/routes/settings/index.tsx and routes/plugins/index.tsx: routes; never edit route-tree.gen.ts.
- packages/dashboard/src/components/side-menu/side-menu.tsx: Configuration links.

### Task 1: Define redacted Settings and Plugin DTOs

**Files:**
- Modify: packages/types/src/dashboard.ts, packages/types/src/config/config.ts
- Test: packages/types/src/dashboard.test.ts

**Interfaces:**
- Produces DashboardSettingsViewSchema, DashboardSettingsMutationSchema, DashboardPluginSummarySchema, DashboardPluginsResponseSchema, and DashboardPluginOptionsMutationSchema.

- [ ] **Step 1: Write failing schema tests.** Assert Settings accepts server host/port, default proxy, logging enabled/retention/level, retry cap, theme, and language; password is only hasPassword boolean. Assert plugin summary includes packageName, version optional, builtin, enabled, state, and hasOptions but not options/secrets.
- [ ] **Step 2: Run and verify failure.** Run: cd packages/types && bun test src/dashboard.test.ts. Expected: FAIL because DTO schemas do not exist.
- [ ] **Step 3: Implement schemas with authoring/materialized separation.** Reuse ConfigTemplateStringSchema, HttpProxyUrlSchema, PluginPackageNameSchema, and existing logging/retry limits. Limit mutable Settings fields to those named above; theme/language are browser preferences persisted client-side and never written into proxy config.
- [ ] **Step 4: Run schema tests.** Run: cd packages/types && bun test src/dashboard.test.ts.
- [ ] **Step 5: Commit.** git add packages/types/src && git commit -m "feat(types): define dashboard settings and plugin DTOs"

### Task 2: Add safe Settings read/write routes

**Files:**
- Create: packages/server/src/dashboard-routes/settings.ts, settings.test.ts
- Modify: packages/server/src/dashboard-routes/config.ts, packages/server/src/config-store files only if an atomic non-provider mutation helper is missing

**Interfaces:**
- Produces GET /dashboard/api/settings and PUT /dashboard/api/settings; success returns settings view.

- [ ] **Step 1: Write failing route tests.** Assert GET redacts proxy credentials and only reports hasPassword; PUT changes logging enabled/retention and proxy while retaining an existing password/template; invalid port or SOCKS proxy returns 422 and leaves the authored config file byte-for-byte unchanged.
- [ ] **Step 2: Run and verify failure.** Run: cd packages/server && bun test src/dashboard-routes/settings.test.ts. Expected: FAIL with 404.
- [ ] **Step 3: Implement atomic mutation.** Parse authoring input, expand templates, validate materialized config, merge only allowed server, proxy, and router subfields, retain redacted values through existing secret/template helpers, call ConfigStore once, and map ConfigReloadRejectedError to 422 and missing configPath to 409.
- [ ] **Step 4: Run Settings tests.** Run: cd packages/server && bun test src/dashboard-routes/settings.test.ts.
- [ ] **Step 5: Commit.** git add packages/server/src/dashboard-routes packages/server/src/config-store && git commit -m "feat(server): add safe dashboard settings API"

### Task 3: Add Plugin listing, options, install, and uninstall routes

**Files:**
- Create: packages/server/src/dashboard-routes/plugins.ts, plugins.test.ts
- Modify: packages/server/src/dashboard-routes/config.ts, packages/server/src/config-store files, packages/core/src/npm files only when a public uninstall operation is absent

**Interfaces:**
- Produces GET /dashboard/api/plugins, PUT /dashboard/api/plugins/:packageName/options, POST /dashboard/api/plugins/install, and DELETE /dashboard/api/plugins/:packageName.

- [ ] **Step 1: Write failing route tests.** Assert built-ins list with builtin true and DELETE returns 409; third-party install without confirmed true returns confirmation_required; successful install writes enablement; options update preserves a tuple package name; uninstall removes enablement and package only when no Provider still references it.
- [ ] **Step 2: Run and verify failure.** Run: cd packages/server && bun test src/dashboard-routes/plugins.test.ts. Expected: FAIL with 404.
- [ ] **Step 3: Implement lifecycle routes.** Read runtime plugin registry for installed/version/state and config authoring for enablement/options. Reuse npmAdd and its typed errors; add the minimal paired uninstall helper under the same lock. Before deletion, scan authored providers for kind oauth and matching plugin, then return 409 with dependent Provider IDs instead of orphaning them.
- [ ] **Step 4: Run Plugin tests.** Run: cd packages/server && bun test src/dashboard-routes/plugins.test.ts.
- [ ] **Step 5: Commit.** git add packages/server/src/dashboard-routes packages/core/src/npm packages/server/src/config-store && git commit -m "feat(server): manage dashboard plugins safely"

### Task 4: Build the Settings page

**Files:**
- Create: packages/dashboard/src/modules/settings/services/settings-service.ts, hooks/use-settings-query.ts, hooks/use-settings-mutation.ts, templates/settings-page.tsx, templates/settings-page.test.tsx
- Modify: packages/dashboard/src/components/side-menu/side-menu.tsx, packages/dashboard/src/routes/settings/index.tsx, packages/i18n/messages files

**Interfaces:**
- Consumes settingsQueryOptions() and useSettingsMutation().
- Produces /settings single-column TanStack Form with immediate routine saves and confirmed access-impacting host/port changes. Password remains a masked read-only state indicator.

- [ ] **Step 1: Write failing page tests.** Assert all three groups render in order; logging Switch is in the logs/retries group header; no password input, clear, or refill control renders; changing a routine value submits once; changing port opens a confirmation dialog before the mutation executes.
- [ ] **Step 2: Run and verify failure.** Run: cd packages/dashboard && bun test src/modules/settings/templates/settings-page.test.tsx.
- [ ] **Step 3: Implement the form.** Use useForm fields, Switch, Input, Select, and shared confirm Dialog. Keep theme/language in existing client preference/i18n layer; keep proxy/backend values in Settings API. Invalidate Settings and Provider queries after a successful proxy update.
- [ ] **Step 4: Run Settings tests and build.** Run: cd packages/dashboard && bun test src/modules/settings && bun run build.
- [ ] **Step 5: Commit.** git add packages/dashboard/src/modules/settings packages/dashboard/src/routes/settings packages/dashboard/src/components/side-menu packages/i18n/messages && git commit -m "feat(dashboard): add settings page"

### Task 5: Build the Plugins page

**Files:**
- Create: packages/dashboard/src/modules/plugins/services/plugins-service.ts, hooks/use-plugins-query.ts, hooks/use-plugin-mutations.ts, components/plugin-install-drawer.tsx, plugin-options-drawer.tsx, plugin-uninstall-dialog.tsx, templates/plugins-page.tsx and colocated tests
- Modify: packages/dashboard/src/routes/plugins/index.tsx, packages/dashboard/src/components/side-menu/side-menu.tsx, packages/i18n/messages files

**Interfaces:**
- Consumes pluginsQueryOptions() and typed mutations from Task 3.
- Produces /plugins configuration table, Header-owned Add Plugin drawer, built-in marker, options drawer only when hasOptions, and uninstall only for third party.

- [ ] **Step 1: Write failing interaction tests.** Assert Header owns Add Plugin, built-ins lack uninstall buttons, third-party rows expose confirmation dialog, an option-bearing row opens its drawer, and untrusted package installation cannot submit until trust confirmation is checked.
- [ ] **Step 2: Run and verify failure.** Run: cd packages/dashboard && bun test src/modules/plugins.
- [ ] **Step 3: Implement query-backed UI.** Use shared Table, Drawer, Dialog, and TanStack Form; keep package/registry/trust in install drawer local state; show dependent Provider IDs from a 409 in the uninstall dialog rather than swallowing the refusal; invalidate Plugin and Provider queries after mutations.
- [ ] **Step 4: Run Plugin UI tests and build.** Run: cd packages/dashboard && bun test src/modules/plugins && bun run build.
- [ ] **Step 5: Commit.** git add packages/dashboard/src/modules/plugins packages/dashboard/src/routes/plugins packages/dashboard/src/components/side-menu packages/i18n/messages && git commit -m "feat(dashboard): add plugin management page"

### Task 6: Generate routes, release, and verify

**Files:**
- Generated: packages/dashboard/src/route-tree.gen.ts
- Create: .changeset/dashboard-control-plane.md

- [ ] **Step 1: Generate route tree through Dashboard build.** Run: bun run build:dashboard. Do not hand-edit route-tree.gen.ts.
- [ ] **Step 2: Compile all locales and run affected suites.** Run: bun run i18n:compile && cd packages/server && bun test src/dashboard-routes/settings.test.ts src/dashboard-routes/plugins.test.ts && cd ../dashboard && bun test src/modules/settings src/modules/plugins.
- [ ] **Step 3: Create changeset.** Target aio-proxy, @aio-proxy/types, @aio-proxy/core, and @aio-proxy/server at minor; explicitly mention authenticated local Settings and Plugin control-plane management.
- [ ] **Step 4: Run repository verification.** Run: bun run preflight && bun run build:dashboard.
- [ ] **Step 5: Commit.** git add packages/dashboard/src/route-tree.gen.ts packages/i18n .changeset && git commit -m "docs: release dashboard settings and plugins"

## Self-Review Notes

- Settings and Plugins are deliberately isolated from Provider redesign because they need new write contracts, config atomicity, and package-lifecycle safety.
- The plan never exposes unrestricted config editing or raw secret-bearing request data.
- UI implementation is blocked only on the explicitly specified server tasks, not on undecided visual work.

## Review Amendments

The following corrections supersede earlier references in this plan.

- Plugin package names never occupy one URL path segment because scoped names contain a slash. Options update and uninstall use a JSON request body containing packageName, while list/install paths remain unambiguous.
- Add a plugin edit-view contract before the options drawer: serializable field definitions, public values, configured-secret booleans, and a revision/digest. Its mutation carries public replacements, explicit secret replacements, and clear-secret keys. Reuse the OAuth edit-view boundary instead of exposing plugin secrets.
- Installation holds withInstalledNpmPackage through descriptor classification, option validation, and the ConfigStore commit. It checks configPath before installation and tests invalid descriptors, required options, install/uninstall races, and setup failure.
- Uninstall resolves templates and checks every Provider dependency, including OAuth plugin and AI SDK packageName, inside the ConfigStore transaction and again in removeNpmPackageCache canRemove. A concurrent reference addition therefore prevents removal.
- Settings API is split from browser preferences: theme/language remain SidebarPreferences client state. Server Settings contain only explicit runtime config fields. Root proxy is tri-state: omitted preserves, null deletes, URL/template replaces. Router fields stay excluded until a specific UI requirement and test add them.
- Host, port, and logging writes return restartRequired and are presented as persisted/restart-needed, because the live server binds/configures them once at boot. Proxy and retry changes may report live application only when reload actually applies them.
- The real config store lives at packages/server/src/config-store.ts. New server route implementation/tests use same-name directories, for example dashboard-routes/settings/settings.ts and settings.test.ts; commit paths reflect those files.
- Add and compile i18n messages before Settings/Plugins components build. Dashboard tests use bun run --filter @aio-proxy/dashboard test:unit -- <path>; server tests use their package test script with preloads and dependency builds.
- Final changeset is created with bun changeset and includes aio-proxy, @aio-proxy/types, @aio-proxy/server, @aio-proxy/dashboard, and @aio-proxy/i18n at minor, plus @aio-proxy/core only when lifecycle code changes.
