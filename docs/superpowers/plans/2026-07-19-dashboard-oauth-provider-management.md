# Dashboard OAuth Provider Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard plugin inventory with a searchable OAuth capability picker, browser-based OAuth login/re-login, and full OAuth provider editing.

**Architecture:** The server exposes loaded OAuth capabilities and owns short-lived in-memory login sessions that adapt the existing core `AuthorizationPort` to dashboard polling and callback submissions. Core account login remains the only credential/config commit path; it gains an optional provider patch so OAuth account-option edits and routing edits commit atomically. The dashboard uses TanStack Query/Form and shadcn controls for selection, dynamic account fields, session polling, and provider editing.

**Tech Stack:** Bun, Hono, React, TanStack Router/Query/Form, Zod, shadcn Base UI, Rstest, Bun test.

## Global Constraints

- Keep provider selection model-first and do not alter request routing.
- Use “Provider ID” and “Provider weight” domain language.
- Dashboard requests use the typed Hono client and TanStack Query; forms use TanStack Form and shadcn controls.
- All user-facing copy comes from `packages/i18n/messages/en.json` and `packages/i18n/messages/zh-Hans.json`.
- Never serialize OAuth credentials, stored secret values, callback codes, states, or raw callback URLs in errors/logs.
- OAuth Provider ID, plugin, capability, and account fingerprint remain immutable after creation.
- OAuth discovered models are read-only; aliases may target discovered models.
- Account-option changes require same-account reauthorization; the complete provider draft commits atomically after successful authorization.
- Handwritten files stay under 300 lines; split by responsibility before crossing 240 lines.
- Run `bun run preflight` before completion.

---

### Task 1: Shared OAuth Dashboard Contracts and Capability Endpoint

**Files:**
- Modify: `packages/types/src/dashboard.ts`
- Modify: `packages/types/src/index.ts`
- Modify: `packages/types/src/plugin.test.ts`
- Create: `packages/server/src/dashboard-routes/oauth-capabilities.ts`
- Create: `packages/server/src/dashboard-routes/oauth-capabilities.test.ts`
- Modify: `packages/server/src/server-state/types.ts`
- Modify: `packages/server/src/server-state/index.ts`
- Modify: `packages/server/src/dashboard-routes/config.ts`
- Modify: `packages/server/_test/dashboard-static.test.ts`

**Interfaces:**
- Produces `DashboardOAuthCapability`, `DashboardOAuthCapabilitiesResponse`, serializable OAuth form-field DTOs, and `ServerState.oauthCapabilities()`.
- Produces `GET /dashboard/api/oauth/capabilities`; removes `GET /dashboard/api/plugins` and `ServerState.pluginSummaries()`.

- [ ] **Step 1: Write failing shared-schema tests**

Add a behavior test that parses a capability with localized label/description, icon, and all six supported form field types, and rejects a secret field carrying a value. The desired DTO shape is:

```ts
{
  plugin: "@example/oauth",
  capability: "default",
  label: { default: "Example" },
  description: { default: "Example account" },
  icon: "openai",
  form: [{ type: "secret", key: "token", label: "Token", configured: false }],
  defaults: { deploymentType: "github.com" },
}
```

- [ ] **Step 2: Write failing server capability tests**

Register two fake OAuth adapters and assert `/oauth/capabilities` returns only committed, loaded capabilities in registry order, with inert localized metadata, safe form descriptors, explicitly declared form defaults, and no schema/credential/secret objects. Update the dashboard diagnostics test to assert `/plugins` is 404 and provider diagnostics still redact secrets.

- [ ] **Step 3: Run RED tests**

Run:

```bash
rtk bun test packages/types/src/plugin.test.ts packages/server/src/dashboard-routes/oauth-capabilities.test.ts packages/server/_test/dashboard-static.test.ts
```

Expected: failures for missing schemas, state method, and route.

- [ ] **Step 4: Implement minimal contracts and endpoint**

Add Zod schemas for serializable form fields, secret `configured` state, capability metadata, and the capabilities response. In server state, acquire the current snapshot and map `snapshot.plugins.registry.oauthCapabilities()` through the already validated form metadata; derive defaults only from explicit boolean/JSON form defaults and never execute plugin schemas during listing. Mount the new route and delete the old plugin-summary route/state contract.

- [ ] **Step 5: Run GREEN tests and package typecheck**

Run:

```bash
rtk bun test packages/types/src/plugin.test.ts packages/server/src/dashboard-routes/oauth-capabilities.test.ts packages/server/_test/dashboard-static.test.ts
rtk bun run --filter @aio-proxy/server test:unit
```

Expected: all selected tests pass.

---

### Task 2: Core Atomic OAuth Provider Patches

**Files:**
- Modify: `packages/core/src/plugins/account-login/login.ts`
- Modify: `packages/core/src/plugins/account-login/validation.ts`
- Modify: `packages/core/src/plugins/account-login/index.ts`
- Modify: `packages/core/src/plugins/account-login/relogin.test.ts`

**Interfaces:**
- Extends `LoginOAuthAccountOptions` with:

```ts
readonly providerPatch?: {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly weight?: number;
  readonly alias?: ProviderAlias;
};
```

- `providerEntry()` applies the supplied patch while preserving `kind`, `plugin`, `capability`, and the target Provider ID.

- [ ] **Step 1: Write failing relogin tests**

Add tests proving a same-account re-login atomically commits new public account options plus name/enabled/weight/alias, and proving fingerprint mismatch leaves both config and repository account unchanged.

- [ ] **Step 2: Run RED test**

Run:

```bash
rtk bun test packages/core/src/plugins/account-login/relogin.test.ts
```

Expected: the provider patch assertion fails because the existing entry is preserved unchanged.

- [ ] **Step 3: Implement the minimal patch path**

Validate the patch alias through existing alias validation, pass the patch into `providerEntry()`, and construct the staged provider entry inside the same `AtomicConfigFile.transaction()` already used for credential/account writes. Do not add a second mutation or partial-save path.

- [ ] **Step 4: Run GREEN core tests**

Run:

```bash
rtk bun test packages/core/src/plugins/account-login/relogin.test.ts packages/core/src/plugins/account-login/create.test.ts packages/core/src/plugins/account-login/compensation.test.ts
```

Expected: all selected tests pass.

---

### Task 3: Server OAuth Login Session Manager

**Files:**
- Create: `packages/server/src/oauth-login-session/types.ts`
- Create: `packages/server/src/oauth-login-session/callback.ts`
- Create: `packages/server/src/oauth-login-session/authorization.ts`
- Create: `packages/server/src/oauth-login-session/manager.ts`
- Create: `packages/server/src/oauth-login-session/manager.test.ts`
- Create: `packages/server/src/dashboard-routes/oauth-login.ts`
- Create: `packages/server/src/dashboard-routes/oauth-login.test.ts`
- Modify: `packages/server/src/server-state/types.ts`
- Modify: `packages/server/src/server-state/index.ts`
- Modify: `packages/server/src/dashboard-routes/config.ts`

**Interfaces:**
- Produces `OAuthLoginSessionManager` with `start`, `get`, `submitCallback`, `cancel`, and `close`.
- Produces dashboard endpoints:

```text
POST   /oauth/sessions
GET    /oauth/sessions/:id
POST   /oauth/sessions/:id/callback
DELETE /oauth/sessions/:id
```

- Session states are `preparing`, `device_code`, `loopback`, `discovering`, `succeeded`, `failed`, and `cancelled`.

- [ ] **Step 1: Write failing manager tests**

Cover: device-code publication; loopback authorization URL publication; automatic localhost callback; manual full callback submission; state/redirect mismatch rejection without settling; cancellation; 20-minute core timeout mapping; duplicate-account terminal result carrying the existing Provider ID; catalog failure returning success with warning; session lookup after page refresh; and `close()` aborting listeners/sessions.

- [ ] **Step 2: Write failing route tests**

Assert request schemas reject unknown capability, secret values never appear in JSON/errors, session IDs are unguessable UUIDs, callback submissions return only safe codes, and a reauthorization request locks plugin/capability to the target provider.

- [ ] **Step 3: Run RED tests**

Run:

```bash
rtk bun test packages/server/src/oauth-login-session/manager.test.ts packages/server/src/dashboard-routes/oauth-login.test.ts
```

Expected: module-not-found failures.

- [ ] **Step 4: Implement callback validation and authorization adapter**

Use `Bun.serve()` for the requested localhost/dynamic port. Validate scheme, host, port, path, state, absence of userinfo/hash, and presence of `code`; never expose the raw callback in thrown/public errors. Publish the authorization URL before awaiting completion. Device-code presentation publishes URL/code/instructions and then returns immediately so the adapter can poll upstream.

- [ ] **Step 5: Implement the session manager and routes**

Start `loginOAuthAccount()` in the background with an AbortController, safe account-option rendering, progress publication, and optional provider patch. Store only safe public session snapshots. Keep terminal sessions long enough for route refresh, expire inactive sessions, reject conflicting input after settlement, and abort all sessions/listeners on server close.

- [ ] **Step 6: Run GREEN tests**

Run:

```bash
rtk bun test packages/server/src/oauth-login-session/manager.test.ts packages/server/src/dashboard-routes/oauth-login.test.ts packages/server/_test/dashboard-providers-mutation.oauth.test.ts
```

Expected: all selected tests pass.

---

### Task 4: OAuth Provider Edit Contract

**Files:**
- Modify: `packages/types/src/provider.ts`
- Modify: `packages/types/src/dashboard.ts`
- Modify: `packages/types/src/plugin.test.ts`
- Create: `packages/server/src/dashboard-routes/oauth-provider-edit.ts`
- Create: `packages/server/src/dashboard-routes/oauth-provider-edit.test.ts`
- Modify: `packages/server/src/dashboard-routes/config.ts`

**Interfaces:**
- Produces an OAuth common-field mutation schema for no-reauth edits:

```ts
{
  kind: "oauth",
  id: string,
  name?: string,
  enabled?: boolean,
  weight?: number,
  alias?: Record<string, AliasConfig>,
}
```

- Extends OAuth edit view with safe account metadata, account form descriptors/current public values/secret configured flags, and read-only discovered model IDs.

- [ ] **Step 1: Write failing contract and route tests**

Assert common fields and aliases update without reauthorization, plugin/capability/options/Provider ID cannot be changed through the common PUT route, edit-view includes catalog model IDs, and secrets are represented only as configured booleans.

- [ ] **Step 2: Run RED tests**

Run:

```bash
rtk bun test packages/types/src/plugin.test.ts packages/server/src/dashboard-routes/oauth-provider-edit.test.ts
```

Expected: OAuth mutation validation and edit-view assertions fail.

- [ ] **Step 3: Implement minimal edit route behavior**

Allow OAuth common-field bodies in `ProviderMutationBodySchema`, but build the replacement by preserving existing `plugin`, `capability`, and `options`. Resolve account form/current public values/secret presence and repository catalog through server state helpers; never return repository secrets or credentials.

- [ ] **Step 4: Run GREEN tests**

Run:

```bash
rtk bun test packages/types/src/plugin.test.ts packages/server/src/dashboard-routes/oauth-provider-edit.test.ts packages/server/_test/dashboard-providers-mutation-basic.test.ts packages/server/_test/dashboard-providers-mutation-aliases.test.ts
```

Expected: all selected tests pass.

---

### Task 5: Dashboard OAuth Add, Login, Reauthorization, and Editing UI

**Files:**
- Generate via shadcn CLI: `packages/dashboard/src/components/ui/combobox.tsx` and required managed UI dependencies
- Create: `packages/dashboard/src/modules/providers/services/oauth-service.ts`
- Create: `packages/dashboard/src/modules/providers/hooks/use-oauth-session.ts`
- Create: `packages/dashboard/src/modules/providers/components/oauth-capability-combobox.tsx`
- Create: `packages/dashboard/src/modules/providers/components/oauth-account-fields.tsx`
- Create: `packages/dashboard/src/modules/providers/components/oauth-authorization-panel.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-form-fields-oauth.tsx`
- Create: `packages/dashboard/src/modules/providers/templates/oauth-provider-page.tsx`
- Create: `packages/dashboard/src/modules/providers/templates/oauth-provider-page.test.tsx`
- Modify: `packages/dashboard/src/routes/providers/new.$kind.tsx`
- Modify: `packages/dashboard/src/routes/providers/$id.edit.tsx`
- Modify: `packages/dashboard/src/modules/providers/hooks/use-provider-form.ts`
- Modify: `packages/dashboard/src/modules/providers/templates/provider-form-page.tsx`
- Modify: `packages/dashboard/src/modules/providers/services/providers-service.ts`
- Modify: `packages/dashboard/src/modules/providers/components/provider-actions-menu.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/provider-state-cell.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/provider-state-cell.test.tsx`
- Modify: `packages/dashboard/src/modules/providers/templates/providers-page.tsx`
- Modify: `packages/dashboard/src/modules/providers/templates/providers-page.test.tsx`
- Delete: `packages/dashboard/src/modules/providers/components/plugins-table.tsx`
- Delete: `packages/dashboard/src/modules/providers/components/plugins-table.test.tsx`
- Delete: `packages/dashboard/src/modules/providers/services/plugins-service.ts`

**Interfaces:**
- `oauthCapabilitiesQueryOptions()` loads the combobox.
- `useOAuthSession()` starts/polls/submits callback/cancels and keeps the session ID in route search state.
- OAuth add success navigates to `/providers` with a transient `focus` search value; OAuth edit reuses the same session UI with locked Provider ID.

- [ ] **Step 1: Add the managed shadcn combobox**

Run from `packages/dashboard`:

```bash
rtk bunx --bun shadcn@latest add combobox --overwrite
```

Expected: managed Base UI combobox files/dependencies are generated; do not hand-edit `src/components/ui/*`.

- [ ] **Step 2: Write failing page/component tests**

Cover: provider page no longer queries/renders plugins; OAuth appears in the new-provider menu; combobox searches capability labels; selecting a capability renders conditional account fields; secret fields show configured/retain/clear semantics; device code and loopback states render correct actions; callback submission preserves the raw value only in the request; refresh resumes a session ID; duplicate/success navigation focuses the provider; OAuth edit renders common fields, read-only models, aliases, reauthorize, and delete; credential diagnostics render a reauthorize button instead of CLI text.

- [ ] **Step 3: Run RED dashboard tests**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- providers-page oauth-provider-page provider-state-cell
```

Expected: failures for missing routes/components and obsolete plugin assertions.

- [ ] **Step 4: Implement services, forms, and session UI**

Use the typed Hono client for all requests. Use TanStack Form for capability/account/common/alias fields and TanStack Query for capability/edit/session server state. Pre-open a blank tab synchronously on the Continue click, assign the loopback URL when published, and render a normal link if popup opening is blocked. Poll active sessions; stop polling terminal sessions. Keep manual callback input local and clear it after submission.

- [ ] **Step 5: Implement OAuth edit and recovery actions**

Save common-only edits through the provider PUT endpoint. If public/secret account options changed, start a locked reauthorization session carrying the complete provider patch and navigate only after session success. Reject fingerprint mismatch with specific copy. Link OAuth row edit actions and repairable diagnostics into the same page.

- [ ] **Step 6: Run GREEN dashboard tests and build**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit
rtk bun run --filter @aio-proxy/dashboard build
```

Expected: all dashboard tests and build pass.

---

### Task 6: Internationalization, Cleanup, Review, and Verification

**Files:**
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Modify/delete obsolete plugin-list message usages
- Modify: generated Paraglide outputs via `bun run i18n:compile`

**Interfaces:**
- Provides all OAuth picker, form, authorization state, success/warning/error, secret, reauthorization, duplicate-account, remote callback, and accessibility copy.

- [ ] **Step 1: Add complete bilingual messages**

Add matching English and Simplified Chinese keys for every new visible string and remove keys used only by the deleted plugin table when no remaining caller exists.

- [ ] **Step 2: Compile i18n and run focused checks**

Run:

```bash
rtk bun run i18n:compile
rtk bun run check
rtk bun test packages/core/src/plugins/account-login packages/server/src/oauth-login-session packages/server/src/dashboard-routes
rtk bun run --filter @aio-proxy/dashboard test:unit
```

Expected: exit 0; pre-existing informational Biome diagnostics may remain, but no errors.

- [ ] **Step 3: Run full verification**

Run:

```bash
rtk bun run preflight
```

Expected: exit 0.

- [ ] **Step 4: Review the diff**

Use the `code-review` skill against the branch base. Resolve every correctness, security, secret-redaction, accessibility, or project-standard finding, then rerun the smallest affected tests and `bun run preflight` if code changed.

- [ ] **Step 5: Commit**

Run:

```bash
rtk git add docs/superpowers/plans/2026-07-19-dashboard-oauth-provider-management.md packages/core packages/types packages/server packages/dashboard packages/i18n
rtk git commit -m "feat(dashboard): manage oauth providers visually" -m "Co-authored-by: Codex <noreply@openai.com>"
```

Expected: commit succeeds without staging `.reference`.

---

## Self-Review

- Spec coverage: capability selection, plugin-list migration, dynamic options, device-code/loopback/manual callback, resumable sessions, multi-account/duplicate behavior, full editing, atomic reauth edits, read-only models, aliases, secret semantics, diagnostics actions, and success warnings are assigned to Tasks 1–5.
- Placeholder scan: no TODO/TBD steps; each behavior has an owning task and verification command.
- Type consistency: dashboard contracts use `plugin + capability`; session routes and UI share the same session DTO; core patch fields match the OAuth common mutation fields.
- Deliberate limits: no plugin marketplace/installation; no Provider ID/service/account replacement; no persistence across server restart.
