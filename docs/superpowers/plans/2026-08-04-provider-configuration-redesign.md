# Provider Configuration Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Deliver the approved Provider list and four-step API/AI SDK/OAuth configuration workflow using the existing real provider APIs, Alias editor, model metadata support, and request-transform semantics.

**Architecture:** The Provider list stays a TanStack Table backed by providersQueryOptions; OAuth aggregation is a presentation-only parent row whose accounts remain concrete providers. The editor keeps the current TanStack Form and mutation contracts, but composes field groups in four steps; the common Stepper is installed once in @aio-proxy/ui, while request transforms refine the existing domain components rather than replacing their codecs or expression editor.

**Tech Stack:** Bun, TypeScript, Zod 4, React 19, TanStack Form/Query/Table/Router, Base UI, @reui/stepper, existing @react-querybuilder packages and Monaco fallback, Rstest.

## Global Constraints

- First run: cd packages/ui && bunx --bun shadcn@latest add @reui/stepper. Commit the generated shared component, then import it from @aio-proxy/ui/components/stepper.
- Do not build a local Stepper or copy its styles into Dashboard; Provider step state remains closest to ProviderFormPage.
- The Add Provider header menu is the only kind chooser: API, OAuth, or AI SDK. The edit page never repeats kind selection.
- Use Provider ID for the stable config identifier and Provider weight for routing priority; never call either a key/order/rank.
- Every field uses TanStack Form and Zod-backed existing mutation schemas; preserve authored templates and redacted secrets through current provider mutation helpers.
- Alias is not forced into one-model mapping: reuse the current Alias editor and its duplicate/missing-target/preserve-conflict validation.
- Visual request transforms reuse stage-codec, mongo-expression-adapter, RequestTransformFieldSelector, and ExpressionEditor; JSON remains the advanced full-rule fallback, not the normal primitive-value editor.
- All display copy is i18n and all standard controls come from @aio-proxy/ui.

---

## File Map

- packages/ui/src/components/stepper.tsx: generated and exported Stepper primitive.
- packages/dashboard/src/modules/providers/components/providers-table-columns.tsx and new row presenters: Provider table layout and OAuth aggregate expansion.
- packages/server/src/dashboard-routes/provider-write-routes.ts: narrow enabled-state mutation.
- packages/dashboard/src/modules/providers/templates/provider-form-page.tsx: horizontal four-step shell.
- packages/dashboard/src/modules/providers/components/provider-form-step-*.tsx: connection, models/metadata, routing/transforms, and validation/save blocks.
- packages/dashboard/src/modules/providers/components/provider-request-transforms/: refinement of existing visual editor only.

### Task 1: Install and export the shared Stepper

**Files:**
- Create/Modify: generated files from the packages/ui shadcn command; packages/ui/package.json if the generator updates it
- Test: packages/dashboard/src/modules/providers/templates/provider-form-page.test.tsx (added in Task 3)

**Interfaces:**
- Produces imports of Stepper, StepperItem, and StepperTrigger from @aio-proxy/ui/components/stepper.

- [ ] **Step 1: Run the approved generator.** Run: cd packages/ui && bunx --bun shadcn@latest add @reui/stepper.
- [ ] **Step 2: Verify the generated component compiles before Dashboard uses it.** Run: bun run --filter @aio-proxy/ui build. Expected: PASS.
- [ ] **Step 3: Inspect the component export and add it to the package export surface if the generator did not.** Preserve Base UI semantics, keyboard roving behavior, and semantic-token styles; do not edit generated behavior for one page.
- [ ] **Step 4: Rebuild UI.** Run: bun run --filter @aio-proxy/ui build. Expected: PASS.
- [ ] **Step 5: Commit.** git add packages/ui && git commit -m "feat(ui): add shared reui stepper"

### Task 2: Redesign the Provider list, including OAuth aggregation

**Files:**
- Create: packages/dashboard/src/modules/providers/components/oauth-provider-group-row.tsx, provider-enabled-switch.tsx, provider-more-menu.tsx and colocated tests
- Modify: providers-table.tsx, providers-table-columns.tsx, provider-models-cell.tsx, providers-page.tsx, providers-page.test.tsx

**Interfaces:**
- Consumes readonly DashboardProviderSummary[].
- Produces groupProviderRows(providers): readonly ProviderTableRow[], where an OAuth group has groupKey and concrete accounts but no Provider ID, Switch, or more menu.

- [ ] **Step 1: Write failing table tests.** Assert non-OAuth rows show name, Provider ID, kind, plain protocol, model-count Tooltip, Provider weight, Switch, and more menu. Assert an OAuth aggregate has no ID/switch/actions; clicking it inserts aligned indented account rows without another header; each account owns its own Switch/more menu.
- [ ] **Step 2: Run and verify failure.** Run: cd packages/dashboard && bun test src/modules/providers/templates/providers-page.test.tsx src/modules/providers/components/providers-table.test.tsx.
- [ ] **Step 3: Implement row shaping and presentational expansion.** Derive aggregation from OAuth plugin/capability identity, not a fictitious provider ID; keep rows in the same TanStack Table body. Replace protocol badges with text, keep model list behind the existing ProviderModelsCell tooltip, and place Add Provider only in PageContainer.extra.
- [ ] **Step 4: Run table tests and build.** Run: cd packages/dashboard && bun test src/modules/providers && bun run build.
- [ ] **Step 5: Commit.** git add packages/dashboard/src/modules/providers && git commit -m "feat(dashboard): redesign provider configuration table"

### Task 3: Add a safe enabled-state mutation and row actions

**Files:**
- Create: packages/types/src/dashboard-provider-mutation.ts, packages/server/src/dashboard-routes/provider-enable.test.ts, packages/dashboard/src/modules/providers/hooks/use-provider-enabled-mutation.ts
- Modify: packages/types/src/dashboard.ts, packages/types/src/index.ts, packages/server/src/dashboard-routes/provider-write-routes.ts, packages/dashboard/src/modules/providers/services/providers-service.ts

**Interfaces:**
- Produces PATCH /dashboard/api/providers/:id/enabled with a body containing enabled boolean and returns provider summary.

- [ ] **Step 1: Write a failing API test.** Request PATCH /providers/openai-main/enabled with JSON enabled false; assert 200 and returned provider.enabled false.
- [ ] **Step 2: Run and verify failure.** Run: cd packages/server && bun test src/dashboard-routes/provider-enable.test.ts. Expected: FAIL with 404.
- [ ] **Step 3: Implement the narrow update.** Parse the typed body, use state.configStore.mutateProviders to change only enabled, preserve templates/secrets/other fields, map not-found to 404 and reload rejection to 422. In Dashboard optimistically update the providers query, rollback on error, invalidate on settlement; more-menu copy uses clipboard and delete reuses DeleteProviderDialog.
- [ ] **Step 4: Run server and hook tests.** Run: cd packages/server && bun test src/dashboard-routes/provider-enable.test.ts && cd ../dashboard && bun test src/modules/providers.
- [ ] **Step 5: Commit.** git add packages/types packages/server/src/dashboard-routes packages/dashboard/src/modules/providers && git commit -m "feat(providers): toggle concrete provider enablement"

### Task 4: Recompose API and AI SDK forms as the approved four-step editor

**Files:**
- Create: packages/dashboard/src/modules/providers/components/provider-form-step-connection.tsx, provider-form-step-models.tsx, provider-form-step-routing.tsx, provider-form-step-validate.tsx and colocated tests
- Modify: provider-form-page.tsx, provider-form-fields-api.tsx, provider-form-fields-ai-sdk.tsx, provider-form-page.test.tsx, routes/providers/new.$kind.tsx, routes/providers/$id.edit.tsx

**Interfaces:**
- Consumes existing useProviderForm, ProviderFormFieldsApi/AiSdk, Alias drawer, and Provider mutations.
- Produces local activeStep 0 | 1 | 2 | 3; forward navigation validates only fields exposed by the current step, while final submission runs the existing complete validation.

- [ ] **Step 1: Write failing workflow tests.** Assert all four horizontal step labels render; API connection is centered single column with a two-input Key/Value headers row; OAuth and AI SDK both expose optional per-provider proxy; breadcrumb is the sole return control; final step selects an enabled model and runs a test request before Save becomes available.
- [ ] **Step 2: Run and verify failure.** Run: cd packages/dashboard && bun test src/modules/providers/templates/provider-form-page.test.tsx.
- [ ] **Step 3: Compose existing fields into steps.** Put protocol/name/Provider ID/base URL/API key/proxy/headers in Connection; enabled model list, upstream import, batch manual model input, metadata drawer, Alias in Models; Provider weight/enabled/request transforms in Routing; selected-model test request and final save in Validate. Keep footer aligned to the centered form width and remove duplicate page heading/back link.
- [ ] **Step 4: Run workflow tests and build.** Run: cd packages/dashboard && bun test src/modules/providers/templates/provider-form-page.test.tsx src/modules/providers/components && bun run build.
- [ ] **Step 5: Commit.** git add packages/dashboard/src/modules/providers packages/dashboard/src/routes/providers && git commit -m "feat(dashboard): add provider editor stepper workflow"

### Task 5: Finish model catalog/metadata and request transforms without replacing working domain logic

**Files:**
- Modify: provider-models-cell.tsx, provider-form-step-models.tsx, provider-request-transforms/provider-request-transforms-visual-editor.tsx, request-transform-stage-list.tsx, request-transform-stage-value-editor.tsx, request-transform-static-value-editor.tsx
- Test: existing colocated request-transform tests plus provider-form-step-models.test.tsx (create)

**Interfaces:**
- Consumes existing provider catalog endpoint, model metadata schema, Alias editor, stage-codec, and ExpressionEditor.
- Produces batch model entry split on commas/newlines; null static value represented only by selected static type; inline visual rule flow 当 → 则.

- [ ] **Step 1: Write failing UI tests.** Assert a catalog result can be selected into enabled models; a,b plus newline c adds a, b, c once; metadata opens its JSON drawer; Alias retains variants; new transform rule appears below rule list; new operation appends one set row; selecting null leaves no value field.
- [ ] **Step 2: Run and verify failure.** Run: cd packages/dashboard && bun test src/modules/providers/components/provider-request-transforms src/modules/providers/components/provider-form-step-models.test.tsx.
- [ ] **Step 3: Implement only composition and presenters.** Keep catalog failures recoverable through manual input. Use the existing Alias drawer rather than a mapping shortcut. Keep ExpressionEditor for expressions and Monaco only for full JSON; static primitive editor selects text/number/boolean/null, with lightweight parsed JSON drawer only for object/array literals. Do not alter stage serialization semantics.
- [ ] **Step 4: Run focused tests.** Run: cd packages/dashboard && bun test src/modules/providers/components/provider-request-transforms src/modules/providers/components/provider-form-step-models.test.tsx.
- [ ] **Step 5: Commit.** git add packages/dashboard/src/modules/providers && git commit -m "feat(dashboard): refine provider models and transforms"

### Task 6: Localize, release, and verify

**Files:**
- Modify: packages/i18n/messages/en.json, zh-Hans.json, zh-Hant.json, ja.json, ko.json
- Create: .changeset/provider-configuration-redesign.md

- [ ] **Step 1: Add all list/editor/stepper/transform text to i18n.** Include generated defaults such as 规则 {index}, test request statuses, and model batch-input instructions.
- [ ] **Step 2: Compile and run Provider tests.** Run: bun run i18n:compile && cd packages/dashboard && bun test src/modules/providers.
- [ ] **Step 3: Add changeset.** Target aio-proxy, @aio-proxy/types, and @aio-proxy/server at minor; mention the safe enabled-state API and Provider editor redesign.
- [ ] **Step 4: Run repository verification.** Run: bun run preflight && bun run build:dashboard.
- [ ] **Step 5: Commit.** git add packages/i18n .changeset && git commit -m "docs: release provider configuration redesign"

## Self-Review Notes

- OAuth aggregation is explicitly virtual; it cannot accidentally toggle or delete a group.
- The Stepper is shared UI and form semantics remain current TanStack Form/Zod contracts.
- Request-transform work is constrained to presentation and UX; its existing codec and expression behavior remain the persistence authority.

## Review Amendments

The following corrections supersede earlier references in this plan.

- Add a provider-summary contract task before table work. It exposes Provider weight and API protocol from the server; AI SDK renders its package identity as type with protocol unavailable, and invalid Providers expose no edit/toggle controls.
- Move the enabled-state route and Dashboard mutation ahead of the list controls. OAuth group expansion auto-opens when focusProviderId names a concrete child account so post-login focus remains reachable.
- OAuth remains its current dedicated login/edit workflow. The four-step editor covers API and AI SDK only. Their proxy control preserves the actual inherit/disabled/URL tri-state; it is not a simple optional string.
- Extend use-provider-form with a presentation/edit normalization for redacted proxy sentinel values. A configured redacted proxy is represented as unchanged and omitted on submit; cover API and AI SDK edit paths.
- Add typed draft catalog and test-request routes before the editor task, because no current provider catalog/test endpoint exists. Reuse TagsInput for comma/newline/deduplicated manual model entry. The final test request is a validation aid, not a prerequisite for saving an otherwise valid Provider.
- Run the user-specified generator command in packages/ui. Use the generator's actual nested export path, expected to be @aio-proxy/ui/components/reui/stepper, or add an explicit alias after inspecting output. Validate through a Dashboard Rstest consumer because the UI package build is not the useful proof.
- Add/compile i18n keys before every affected UI task. Focused Dashboard tests run with bun run --filter @aio-proxy/dashboard test:unit -- <path>; all final release work uses bun changeset and includes aio-proxy plus types, server, dashboard, i18n, ui, and core only if actually changed.
- Provider breadcrumb work depends on the shared-shell Breadcrumb task. The compact transform task also includes RequestTransformRuleCard, which owns the current condition/action composition.
