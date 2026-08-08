# Plugin Presentation Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move plugin display identity into plugin metadata and consistently rename capability and account presentation fields without retaining a v1 compatibility path.

**Architecture:** Plugin descriptor v2 owns `displayName`, `description`, and `icon`; OAuth adapters own only capability presentation and runtime behavior. Core validates descriptor icons, projects plugin presentation through the control plane, and preserves the existing account database column while exposing it as `accountLabel`. The Dashboard reads plugin presentation from `/plugins` for both plugin and OAuth aggregate rows.

**Tech Stack:** Bun, TypeScript, Zod, SQLite, Hono typed client, TanStack Query, React, Rstest.

## Global Constraints

- Break the SDK ABI deliberately: use only descriptor API v2 and return `PLUGIN_API_INCOMPATIBLE` for v1 descriptors.
- Do not add deprecated aliases, dual reads, or database migrations.
- `PluginMetadata.icon` accepts the existing Lobe key, HTTP(S) URL, and safe image data URL forms; invalid values are stripped and logged without their raw value.
- Keep the `oauth_account.label` database column; expose account data as `accountLabel` outside repository internals.
- OAuth capability icons are removed; plugin summaries are the only Dashboard source for plugin display identity.
- Use `displayName` for plugin/capability/quota presentation and `accountLabel` for account presentation.
- Preserve whole-row OAuth expansion, keyboard interaction, and a visible chevron beside the plugin icon.
- Add a major changeset covering `aio-proxy`, `@aio-proxy/plugin-sdk`, and every directly changed internal package.

---

### Task 1: Publish descriptor API v2 and migrate built-in plugins

**Files:**
- Modify: `packages/plugin-sdk/src/plugin/plugin.ts`
- Modify: `packages/plugin-sdk/src/plugin/descriptor-shell.types.ts`
- Modify: `packages/plugin-sdk/src/oauth.ts`
- Test: `packages/plugin-sdk/__tests__/register.types.ts`
- Test: `packages/plugin-sdk/src/plugin/descriptor-shell.types.ts`
- Modify: `packages/plugins/{openai-chatgpt,github-copilot,google-antigravity,kimi-code,xai-grok}/src/plugin.ts`
- Test: each built-in plugin's existing `src/plugin.test.ts`

**Interfaces:**
- Produces `PluginMetadata` with `displayName?: LocalizedText`, `description?: LocalizedText`, `icon?: PluginIcon`, and `options?: ConfigSpec<Options>`.
- Produces descriptor API v2 (`PLUGIN_API_VERSION = 2`, `PLUGIN_DESCRIPTOR_BRAND = Symbol.for('@aio-proxy/plugin-sdk/descriptor/v2')`, supported versions `[2]`).
- Produces `OAuthAdapter.displayName`, `OAuthLoginResult.accountLabel`, credential refresh metadata `accountLabel`, and `OAuthQuotaItem.displayName`.

- [ ] **Step 1: Write failing SDK type assertions**

Assert current names no longer type-check and replacement names do:

```ts
const descriptor = definePlugin(() => {}, { displayName: 'Example', icon: 'openai' });
const adapter: OAuthAdapter = { id: 'default', displayName: 'Sign in', /* required runtime members */ };
// @ts-expect-error v1 label is removed
definePlugin(() => {}, { label: 'Example' });
// @ts-expect-error capability icons belong to plugin metadata
const invalid: OAuthAdapter = { id: 'default', icon: 'openai' };
```

- [ ] **Step 2: Run the focused SDK type test and verify RED**

Run: `rtk bun test packages/plugin-sdk/__tests__/register.types.ts`

Expected: FAIL because v1 fields still exist and v2 fields are absent.

- [ ] **Step 3: Implement the v2 public contracts**

Move the icon union to `PluginIcon`, define it beside plugin metadata, and update the descriptor shell's opaque metadata fields. Rename capability, account, refresh, and quota presentation fields exactly as produced above; do not rename form-field `label` fields.

- [ ] **Step 4: Migrate all five built-in descriptors and assertions**

Place each brand icon beside `displayName` in `definePlugin` metadata. Rename adapter login text to `displayName`, login-result account identity to `accountLabel`, and quota item display strings to `displayName`. Update plugin tests to assert the new ownership.

- [ ] **Step 5: Run focused SDK and plugin tests**

Run: `rtk bun run --filter @aio-proxy/plugin-sdk test:unit && rtk bun run --filter @aio-proxy/plugin-openai-chatgpt test:unit && rtk bun run --filter @aio-proxy/plugin-github-copilot test:unit`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/plugin-sdk packages/plugins
rtk git commit -m "feat(plugin-sdk): define plugin presentation metadata" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Validate and project v2 metadata through Core

**Files:**
- Modify: `packages/core/src/plugins/icon.ts`
- Modify: `packages/core/src/plugins/loader/descriptor/descriptor.ts`
- Modify: `packages/core/src/plugins/loader/index.ts`
- Modify: `packages/core/src/plugins/registry.ts`
- Modify: `packages/core/src/plugins/account-login/validation.ts`
- Modify: `packages/core/src/plugins/account-login/login.ts`
- Modify: `packages/core/src/plugins/credential-port.ts`
- Test: `packages/core/src/plugins/loader/descriptor/descriptor.test.ts`
- Test: `packages/core/src/plugins/registry-adapter-validation.test.ts`
- Test: `packages/core/src/plugins/registry-icon-logging.test.ts`
- Test: `packages/core/src/plugins/account-login/constants-and-validation.test.ts`
- Test: `packages/core/src/plugins/credential-port/*.test.ts`

**Interfaces:**
- Consumes Task 1's v2 descriptor and renamed SDK fields.
- Produces `LoadedPluginState.displayName?: LocalizedText` and `icon?: PluginIcon`.
- Keeps `StoredAccount.label` and `AccountWrite.label` private repository names while mapping all SDK boundary values through `accountLabel`.

- [ ] **Step 1: Write failing Core tests**

Add four behavior tests:

```ts
expect(() => validateDescriptor(v1Descriptor)).toThrow(new PluginHostError('PLUGIN_API_INCOMPATIBLE'));
expect(loadPluginRegistry(invalidMetadataIcon)).toLog('plugin.metadata.icon.invalid');
expect(loadedPlugin).toMatchObject({ displayName: 'Example', icon: 'openai' });
expect(storedAccount.label).toBe(loginResult.accountLabel);
```

Also verify a throwing log sink does not prevent the plugin from becoming ready and that runtime plus control-plane credential refresh update the persisted account label through `metadata.accountLabel`.

- [ ] **Step 2: Run the focused Core tests and verify RED**

Run: `rtk bun test packages/core/src/plugins/loader/descriptor/descriptor.test.ts packages/core/src/plugins/registry-icon-logging.test.ts packages/core/src/plugins/account-login/constants-and-validation.test.ts`

Expected: FAIL because v1 remains accepted and descriptor icons are not yet validated or projected.

- [ ] **Step 3: Implement descriptor ABI and icon validation**

Rename `validateOAuthIcon` to `validatePluginIcon`. Validate descriptor `metadata.displayName`, `description`, and `icon`; on invalid icon, omit only the icon and emit guarded `plugin.metadata.icon.invalid` with `{ plugin: packageName }`. Thread package name and the existing `PluginLogSink` into descriptor validation for both built-in and installed plugins. Keep descriptor metadata failure semantics for invalid names/descriptions.

- [ ] **Step 4: Implement renamed capability and account boundaries**

Validate/read `OAuthAdapter.displayName`; remove icon handling from registry registration. Replace public `label` reads/writes in login validation, staged metadata, in-memory refresh, and credential-port notifications with `accountLabel`. At repository calls, map `accountLabel` to existing internal `label` members and leave SQL/table/migration files unchanged.

- [ ] **Step 5: Run focused Core tests**

Run: `rtk bun run --filter @aio-proxy/core test:unit -- plugins`

Expected: PASS, including ABI rejection, safe icon logging, and account-label refresh behavior.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/core
rtk git commit -m "refactor(core): separate plugin and account presentation" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Migrate CLI and Dashboard transport contracts

**Files:**
- Modify: `packages/types/src/dashboard-oauth.ts`
- Modify: `packages/types/src/dashboard/control-plane/control-plane.ts`
- Modify: `packages/server/src/dashboard-routes/oauth-capabilities.ts`
- Modify: `packages/server/src/plugin-control-plane/read.ts`
- Modify: `packages/cli/src/plugin-commands/provider-login/capability.ts`
- Test: `packages/server/src/dashboard-routes/oauth-capabilities.test.ts`
- Test: `packages/server/src/plugin-control-plane/read.test.ts`
- Test: `packages/cli/src/plugin-commands/provider-login/capability.test.ts`

**Interfaces:**
- Consumes `LoadedPluginState.displayName/icon` and `OAuthAdapter.displayName` from Tasks 1–2.
- Produces `DashboardPluginSummary.displayName?: DashboardLocalizedText` and `icon?: string`.
- Produces `DashboardOAuthCapability.displayName` without `icon`.
- Produces CLI `CapabilityChoice.displayName`.

- [ ] **Step 1: Write failing contract tests**

Update schema and route assertions to require the new field names:

```ts
expect(dashboardOAuthCapabilities(registry)[0]).toMatchObject({ displayName: 'Sign in' });
expect(dashboardOAuthCapabilities(registry)[0]).not.toHaveProperty('icon');
expect(pluginSummary).toMatchObject({ displayName: 'Example', icon: 'openai' });
expect(promptChoice.name).toBe('Localized capability name');
```

- [ ] **Step 2: Run focused contract tests and verify RED**

Run: `rtk bun test packages/server/src/dashboard-routes/oauth-capabilities.test.ts packages/cli/src/plugin-commands/provider-login/capability.test.ts`

Expected: FAIL because current wire schemas use `label` and capability `icon`.

- [ ] **Step 3: Implement wire and CLI field migration**

Rename the strict Zod fields and server projections without accepting old names. Update the CLI selection data shape and localized prompt rendering to consume `displayName`. Ensure plugin control-plane summaries include both descriptor presentation fields.

- [ ] **Step 4: Run focused server, CLI, and type tests**

Run: `rtk bun run --filter @aio-proxy/server test:unit -- oauth-capabilities plugin-control-plane && rtk bun run --filter @aio-proxy/cli test:unit -- capability && rtk bun run --filter @aio-proxy/types test:unit -- dashboard`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/types packages/server packages/cli
rtk git commit -m "refactor(api): rename plugin presentation fields" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 4: Render plugin identity from the plugin summary

**Files:**
- Create: `packages/dashboard/src/components/plugin-icon/plugin-icon.tsx`
- Create: `packages/dashboard/src/components/plugin-icon/index.ts`
- Test: `packages/dashboard/src/components/plugin-icon/plugin-icon.test.tsx`
- Modify: `packages/dashboard/src/modules/plugins/components/plugins-table.tsx`
- Modify: `packages/dashboard/src/modules/providers/services/provider-plugin-labels/provider-plugin-labels.ts`
- Modify: `packages/dashboard/src/modules/providers/components/providers-table/providers-table.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/oauth-provider-group-row/oauth-provider-group-row.tsx`
- Test: `packages/dashboard/src/modules/providers/components/providers-table/providers-table.test.tsx`

**Interfaces:**
- Consumes Task 3's `DashboardPluginSummary.displayName` and `icon` from the existing `/plugins` query.
- Produces `<PluginIcon icon={string} size={16} />`, which uses `LobeIcon` for a Lobe key and a decorative `<img alt="">` for URL/data icons; a failed image renders nothing.
- Produces OAuth aggregate presentation keyed only by plugin package name.

- [ ] **Step 1: Write failing Dashboard tests**

Add a component test for a Lobe key and URL fallback, then seed the plugins query in the Provider table test:

```tsx
expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('src', expect.stringContaining('openai.svg'));
fireEvent.error(screen.getByRole('img', { hidden: true }));
expect(screen.queryByRole('img', { hidden: true })).toBeNull();
expect(within(groupRow).getByLabelText(/Expand provider group/u)).toContainElement(screen.getByRole('img', { hidden: true }));
```

Assert the plugin table renders `displayName`, not the former `label`, and that the aggregate still contains the chevron and changes `aria-expanded` on row and button interaction.

- [ ] **Step 2: Run focused Dashboard tests and verify RED**

Run: `rtk bun run --filter @aio-proxy/dashboard test:unit -- providers-table plugins-table`

Expected: FAIL because presentation fields and aggregate icons are not wired.

- [ ] **Step 3: Implement the shared icon and query mapping**

Use the existing `LobeIcon` component rather than duplicating CDN URL construction. The new component chooses URL/data rendering only for values beginning with `http://`, `https://`, or `data:image/`; otherwise it delegates to `LobeIcon`. Keep the image decorative and hide it after `onError`.

Replace all Dashboard plugin `label` reads with `displayName`. Expand the existing Provider `/plugins` query map from labels to `{ displayName, icon }`; do not add an `/oauth/capabilities` query. Render the icon plus Chevron button content in the aggregate cell and retain the whole-row toggle.

- [ ] **Step 4: Run focused Dashboard tests and UI checks**

Run: `rtk bun run --filter @aio-proxy/dashboard test:unit -- providers-table plugins-table plugin-icon`

Then run: `rtk node /Users/baran/.codex/plugins/cache/impeccable/impeccable/4.0.4/skills/impeccable/scripts/detect.mjs --json packages/dashboard/src/components/plugin-icon packages/dashboard/src/modules/providers packages/dashboard/src/modules/plugins`

Expected: all tests PASS and detector returns `[]`.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/dashboard
rtk git commit -m "feat(dashboard): show plugin presentation icons" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 5: Release note and final verification

**Files:**
- Create: `.changeset/<generated-name>.md`

**Interfaces:**
- Consumes all renamed public contracts from Tasks 1–4.
- Produces a major release note for the SDK and application packages.

- [ ] **Step 1: Create the changeset**

Run `rtk bun changeset`, select major bumps for `@aio-proxy/plugin-sdk` and `aio-proxy`, and include each directly changed internal package at the same major level. Use this note:

```markdown
Move plugin display identity to descriptor metadata. Plugins must upgrade to descriptor API v2: use `metadata.displayName` and `metadata.icon`, `OAuthAdapter.displayName`, and `OAuthLoginResult.accountLabel`; old `label` and OAuth adapter `icon` fields are removed.
```

- [ ] **Step 2: Run formatting and all relevant tests**

Run: `rtk bun run format:check && rtk bun run --filter @aio-proxy/plugin-sdk test:unit && rtk bun run --filter @aio-proxy/core test:unit -- plugins && rtk bun run --filter @aio-proxy/server test:unit -- oauth && rtk bun run --filter @aio-proxy/cli test:unit -- capability && rtk bun run --filter @aio-proxy/dashboard test:unit -- providers-table plugins-table`

Expected: PASS.

- [ ] **Step 3: Run workspace verification**

Run: `rtk bun run preflight && rtk git diff --check`

Expected: PASS. If preflight reports a pre-existing unrelated failure, capture its exact file and error in the PR update rather than masking it.

- [ ] **Step 4: Commit and push**

```bash
rtk git add .changeset
rtk git commit -m "chore(release): note plugin metadata v2" -m "Co-authored-by: Codex <noreply@openai.com>"
rtk git push origin codex/provider-list-aggregation
```

## Plan self-review

- Spec coverage: Tasks 1–2 cover ABI v2, icon validation/logging, and account boundaries; Task 3 covers Dashboard and CLI wire contracts; Task 4 covers the sole UI source and fallback; Task 5 covers release policy and final verification.
- Placeholder scan: no deferred work, unspecified error handling, or unbound interface names remain.
- Type consistency: `PluginIcon`, `displayName`, and `accountLabel` are defined in Task 1 and consumed consistently by all later tasks; repository-private `label` never crosses a public boundary.
