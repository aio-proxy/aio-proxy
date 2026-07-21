# Provider Management Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Provider list into an identity-first management surface and give API, AI SDK, and OAuth edit pages a clear section hierarchy and stable terminal action row.

**Architecture:** Keep TanStack Table, TanStack Form, all provider mutations, alias drawers, and OAuth session flows intact. Reduce the table to four consolidated columns, keep direct deletion only for Providers that cannot be edited, and restyle the existing form components in place rather than introducing a new form framework or shared section abstraction.

**Tech Stack:** React 19, TypeScript, TanStack Table/Form/Router/Query, shadcn Base UI components, Tailwind CSS, Rstest, Testing Library, Paraglide i18n.

## Global Constraints

- Reuse existing shadcn/Base UI controls and semantic color tokens; do not add a dependency.
- Keep all user-facing copy in `packages/i18n/messages/en.json` and `packages/i18n/messages/zh-CN.json`.
- Keep one typed arrow React component per `.tsx` file.
- Preserve provider mutations, OAuth sessions, alias validation, credential preservation, focused-row behavior, and route destinations.
- Keep the existing TanStack Table and TanStack Form implementations.
- Do not add auto-save, an unsaved-changes guard, master-detail routing, or a new shared form-section abstraction.
- Prefix every shell command with `rtk`.

---

## File Map

- `packages/dashboard/src/modules/providers/components/providers-table.tsx`: consolidated columns, compact filter, editable-row link, invalid-row delete exception, responsive cells, conditional pagination.
- `packages/dashboard/src/modules/providers/templates/providers-page.tsx`: remove the redundant diagnostics heading.
- `packages/dashboard/src/modules/providers/components/provider-state-cell.tsx`: retain diagnostics but remove the inline reauthorization action now reached through edit.
- `packages/dashboard/src/modules/providers/components/provider-actions-menu.tsx`: delete after the normal row action moves to edit and invalid rows receive a direct delete button.
- `packages/dashboard/src/modules/providers/templates/providers-page.test.tsx`: identity-first list and pagination regression coverage.
- `packages/dashboard/src/modules/providers/components/provider-state-cell.test.tsx`: diagnostic-only state coverage after the inline action is removed.
- `packages/dashboard/src/modules/providers/components/provider-common-fields.tsx`: hide immutable Provider ID inputs in edit mode.
- `packages/dashboard/src/modules/providers/components/provider-form-fields-api.tsx`: Basic information, Connection, and Models and aliases sections.
- `packages/dashboard/src/modules/providers/components/provider-form-fields-ai-sdk.tsx`: matching section hierarchy for AI SDK fields.
- `packages/dashboard/src/modules/providers/templates/provider-form-page.tsx`: centered edit layout, identity summary, and terminal action row.
- `packages/dashboard/src/modules/providers/components/delete-provider-dialog.tsx`: optional post-delete callback for edit-page navigation.
- `packages/dashboard/src/modules/providers/components/delete-provider-dialog.test.tsx`: callback behavior after a confirmed successful delete.
- `packages/dashboard/src/modules/providers/components/provider-form-fields-api.test.tsx`: edit-mode identity and section regression coverage.
- `packages/dashboard/src/modules/providers/components/oauth-provider-edit-fields.tsx`: read-only OAuth metadata and in-section reauthorization.
- `packages/dashboard/src/modules/providers/templates/oauth-provider-edit-page.tsx`: centered layout, stable Save/Cancel/Delete row, and post-delete navigation.
- `packages/dashboard/src/modules/providers/templates/oauth-provider-edit-page.test.tsx`: OAuth action hierarchy and read-only metadata coverage.
- `packages/i18n/messages/en.json`, `packages/i18n/messages/zh-Hans.json`: list, section, and action copy.

---

### Task 1: Identity-first Provider list

**Files:**
- Modify: `packages/dashboard/src/modules/providers/templates/providers-page.test.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/provider-state-cell.test.tsx`
- Modify: `packages/dashboard/src/modules/providers/templates/providers-page.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/providers-table.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/provider-state-cell.tsx`
- Delete: `packages/dashboard/src/modules/providers/components/provider-actions-menu.tsx`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-CN.json`

**Interfaces:**
- Consumes: `ProvidersTableProps { providers, focusProviderId }`, `DeleteProviderDialogRef.open({ id })`, `useDataTable()`.
- Produces: the same `ProvidersTable` public props and Provider edit route `/providers/$id/edit`.

- [ ] **Step 1: Replace obsolete table-control tests with identity-first behavior tests**

In `providers-page.test.tsx`, remove the sorting and column-visibility tests. Keep filtering, multi-page pagination, focused-row, warning, and OAuth metadata coverage. Add these assertions:

```tsx
test("renders one Provider identity column with a direct edit link", () => {
  queryMocks.providers.providers = [
    providerStub({ id: "carpool", name: "Carpool", kind: "api", clientModels: ["model-1"] }),
  ];

  render(<ProvidersPage />);

  const row = within(screen.getByTestId("provider-row-carpool"));
  expect(row.getByText("Carpool")).toBeTruthy();
  expect(row.getByText(/carpool.*API/u)).toBeTruthy();
  expect(row.getByRole("link", { name: /Edit provider carpool|编辑提供商 carpool/u })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Provider columns|提供商列/u })).toBeNull();
  expect(screen.queryByRole("button", { name: /Previous|上一页/u })).toBeNull();
});

test("keeps deletion available for a Provider without an edit route", () => {
  queryMocks.providers.providers = [providerStub({ id: "broken", kind: "invalid" })];

  render(<ProvidersPage />);

  const row = within(screen.getByTestId("provider-row-broken"));
  expect(row.queryByRole("link")).toBeNull();
  expect(row.getByRole("button", { name: /Delete provider broken|删除提供商 broken/u })).toBeTruthy();
});
```

In `provider-state-cell.test.tsx`, remove the entire `provider diagnostics actions` describe block and change both credential-diagnostic tests to assert that no Reauthorize link is rendered in the status cell.

- [ ] **Step 2: Run the focused tests and verify the intended failures**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- providers-page.test.tsx provider-state-cell.test.tsx
```

Expected: FAIL because the old columns, column menu, pagination, action menu, and inline Reauthorize link still render.

- [ ] **Step 3: Add the list copy**

Add matching English and Chinese messages for:

```json
{
  "table": {
    "col_provider": "Provider",
    "col_details": "Details",
    "filter_placeholder": "Search by name or Provider ID"
  },
  "actions": {
    "edit_provider": "Edit provider {id}",
    "delete_provider": "Delete provider {id}"
  }
}
```

Use these Chinese values:

```json
{
  "table": {
    "col_provider": "提供商",
    "col_details": "详情",
    "filter_placeholder": "按名称或提供商 ID 搜索"
  },
  "actions": {
    "edit_provider": "编辑提供商 {id}",
    "delete_provider": "删除提供商 {id}"
  }
}
```

Change `providers_title` and `table.label` from diagnostic wording to `Providers` / `提供商` because the surface is now management-first.

- [ ] **Step 4: Remove the redundant list heading**

In `providers-page.tsx`, replace the loaded-state section with the table directly:

```tsx
{providersQuery.isLoading ? (
  <div className="space-y-2">
    {Array.from({ length: 3 }).map((_, index) => (
      <Skeleton key={index} className="h-12 w-full" />
    ))}
  </div>
) : (
  <ProvidersTable providers={providers} focusProviderId={focusProviderId} />
)}
```

- [ ] **Step 5: Implement the consolidated table**

In `providers-table.tsx`:

1. Keep `useDataTable`, `ProviderModelsCell`, `ProviderStateCell`, `DeleteProviderDialog`, and focused-row paging.
2. Add TanStack Form's `useForm`, Router's `Link`, shadcn `Badge`, `Button`, `Field`, `FieldLabel`, `Input`, and lucide `ChevronRight` / `Trash2`.
3. Remove `DataTableHeaderCell`, `DataTableToolbar`, `ProviderActionsMenu`, sorting handlers, and the column visibility labels.
4. Define editable status with the two existing invalid diagnostic codes:

```tsx
const uneditableDiagnosticCodes = new Set(["PROVIDER_CONFIG_INVALID", "LEGACY_OAUTH_CONFIG_UNSUPPORTED"]);

const canEditProvider = (provider: DashboardProviderSummary): boolean =>
  provider.kind !== "invalid" &&
  (provider.state.diagnostic === undefined || !uneditableDiagnosticCodes.has(provider.state.diagnostic.code));
```

5. Build only `provider`, `status`, `details`, and `models` columns. The Provider accessor must concatenate display name, Provider ID, and kind so global filtering still finds identity fields. Render the display name as a stretched Router `Link` only when `canEditProvider()` is true. Render enabled state, availability, and catalog last-success time in Status; render OAuth account/capability/expiry in Details; keep the existing `ProviderModelsCell` tooltip in Models.
6. Render Details with `hidden lg:table-cell` on both header and body cells. Use a plain `TableHead` so headers no longer look sortable.
7. Give each row relative positioning and stretch the identity link across it. Keep the model tooltip and trailing cell above the stretched link with relative stacking. For editable rows, render a decorative trailing `ChevronRight`. For uneditable rows, render an icon `Button` with `aria-label={m["dashboard.providers.actions.delete_provider"]({ id })}` that opens the existing delete dialog.
8. Replace the toolbar with a local TanStack Form search field:

```tsx
const filterForm = useForm({ defaultValues: { providerFilter: "" } });

<filterForm.Field name="providerFilter">
  {(field) => (
    <Field className="max-w-sm">
      <FieldLabel htmlFor="providers-table-filter" className="sr-only">
        {m["dashboard.providers.table.filter"]()}
      </FieldLabel>
      <Input
        id="providers-table-filter"
        value={field.state.value}
        placeholder={m["dashboard.providers.table.filter_placeholder"]()}
        onChange={(event) => {
          field.handleChange(event.target.value);
          table.setGlobalFilter(event.target.value);
        }}
      />
    </Field>
  )}
</filterForm.Field>
```

9. Render pagination only with `{table.getPageCount() > 1 ? <DataTablePagination table={table} /> : null}`.
10. Focus `provider-link-${focusProviderId}` when present, otherwise focus the row, after the existing scroll behavior.

Remove the now-unused `provider-actions-menu.tsx` file.

- [ ] **Step 6: Remove the inline Reauthorize action from status cells**

In `provider-state-cell.tsx`, keep `dashboardProviderNeedsReauthorization()` only to suppress unsafe suggested commands, but remove the Router `Link`, `buttonVariants`, and Reauthorize JSX. The diagnostic details remain visible; the row edit link is now the path to reauthorization.

- [ ] **Step 7: Compile translations and run the focused tests**

Run:

```bash
rtk bun run i18n:compile
rtk bun run --filter @aio-proxy/dashboard test:unit -- providers-page.test.tsx provider-state-cell.test.tsx
```

Expected: translation compilation succeeds and both test files pass.

---

### Task 2: API and AI SDK edit-page hierarchy

**Files:**
- Modify: `packages/dashboard/src/modules/providers/components/provider-form-fields-api.test.tsx`
- Create: `packages/dashboard/src/modules/providers/components/delete-provider-dialog.test.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/provider-common-fields.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/provider-form-fields-api.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/provider-form-fields-ai-sdk.tsx`
- Modify: `packages/dashboard/src/modules/providers/templates/provider-form-page.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/delete-provider-dialog.tsx`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-CN.json`

**Interfaces:**
- Consumes: `useProviderForm`, `DeleteProviderDialogRef.open({ id })`, existing API/AI SDK field values and mutation bodies.
- Produces: unchanged provider form submissions plus `DeleteProviderDialogProps { onDeleted?: () => void }`.

- [ ] **Step 1: Write failing edit-hierarchy and post-delete tests**

Append to `provider-form-fields-api.test.tsx`:

```tsx
test("groups edit fields and presents immutable identity outside the form", () => {
  const { result } = renderHook(() =>
    useProviderForm({
      mode: ProviderFormMode.Edit,
      kind: ProviderKind.Api,
      initial: { kind: ProviderKind.Api, id: "openrouter", enabled: true },
    }),
  );

  render(
    <ProviderFormFieldsApi
      form={result.current}
      mode={ProviderFormMode.Edit}
      providerId="openrouter"
      aliasOpen={false}
      onAliasOpenChange={rs.fn()}
    />,
  );

  expect(screen.getByRole("region", { name: /Basic information|基本信息/u })).toBeTruthy();
  expect(screen.getByRole("region", { name: /Connection|连接/u })).toBeTruthy();
  expect(screen.getByRole("region", { name: /Models and aliases|模型与别名/u })).toBeTruthy();
  expect(screen.queryByLabelText(/Provider ID|提供商 ID/u)).toBeNull();
});
```

Create `delete-provider-dialog.test.tsx` using `renderHook(() => useRef<DeleteProviderDialogRef>(null))`. Mock `useProviderDelete()` so `mutate(id, options)` invokes `options.onSuccess()`. Open the dialog for `{ id: "carpool" }`, click `delete-confirm`, and assert the mutation receives `carpool` and `onDeleted` runs once.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- provider-form-fields-api.test.tsx delete-provider-dialog.test.tsx
```

Expected: FAIL because sections, edit-mode ID removal, and the post-delete callback do not exist.

- [ ] **Step 3: Add shared edit-page copy**

Add matching English/Chinese form keys:

```json
{
  "section_basic": "Basic information",
  "section_connection": "Connection",
  "section_integration": "Integration",
  "section_models_aliases": "Models and aliases"
}
```

Use Chinese values `基本信息`, `连接`, `集成`, and `模型与别名`.

- [ ] **Step 4: Hide immutable ID inputs in edit mode**

In `provider-common-fields.tsx`, render the existing Provider ID field only when `mode === ProviderFormMode.Create`. Keep name, enabled, and Provider weight behavior unchanged.

- [ ] **Step 5: Group API and AI SDK fields without changing form ownership**

In both field components, keep the same `form.Field` blocks and wrap them in named sections with `aria-labelledby`:

```tsx
<section className="space-y-4" aria-labelledby="provider-basic-heading">
  <h2 id="provider-basic-heading" className="text-base font-semibold">
    {m["dashboard.providers.form.section_basic"]()}
  </h2>
  <div className="grid gap-4 md:grid-cols-2">
    <ProviderCommonFields form={form} mode={mode} />
  </div>
</section>
```

Use `provider-connection-heading` for API Base URL, API Key, and protocol; use `provider-integration-heading` for AI SDK package, options, and reasoning parsing. Use `provider-models-heading` for model tags and the existing alias editor. Keep each component's current event handlers and validation calls unchanged.

- [ ] **Step 6: Add edit-page deletion completion and the stable form action row**

Change `DeleteProviderDialog` to accept:

```tsx
interface DeleteProviderDialogProps {
  readonly onDeleted?: () => void;
}
```

After a successful delete, close the dialog and call `onDeleted?.()`.

In `provider-form-page.tsx`:

- add `useRef<DeleteProviderDialogRef>(null)`;
- use `max-w-4xl space-y-6 px-1 pb-4 sm:p-4`;
- show `{providerId} · {kind label}` as muted text in edit mode;
- open the delete dialog with `{ id: providerId }`;
- render Save then Cancel on the left and edit-only Delete on the right inside a transparent terminal action row;
- mount `<DeleteProviderDialog ref={deleteDialogRef} onDeleted={() => void navigate({ to: "/providers" })} />`.

Keep Create mode free of Delete and keep its current submit behavior.

- [ ] **Step 7: Compile translations and run the focused tests**

Run:

```bash
rtk bun run i18n:compile
rtk bun run --filter @aio-proxy/dashboard test:unit -- provider-form-fields-api.test.tsx delete-provider-dialog.test.tsx
```

Expected: translation compilation succeeds and both test files pass.

---

### Task 3: OAuth edit-page action hierarchy

**Files:**
- Modify: `packages/dashboard/src/modules/providers/templates/oauth-provider-edit-page.test.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/oauth-provider-edit-fields.tsx`
- Modify: `packages/dashboard/src/modules/providers/templates/oauth-provider-edit-page.tsx`

**Interfaces:**
- Consumes: existing `submit(reauthorize: boolean)`, OAuth account form, alias drawer, session panel, and `DeleteProviderDialog.onDeleted` from Task 2.
- Produces: `OAuthProviderEditFields` props `onReauthorize: () => void` and `isReauthorizing: boolean`; OAuth submission/session behavior remains unchanged.

- [ ] **Step 1: Rewrite the OAuth edit test around the new hierarchy**

Replace the first OAuth edit test assertions with:

```tsx
const connection = screen.getByRole("region", { name: /Connection|连接/u });
const actions = screen.getByTestId("provider-form-actions");
const actionButtons = within(actions).getAllByRole("button");

expect(screen.queryByLabelText(/Provider ID|提供商 ID/u)).toBeNull();
expect(screen.queryByLabelText(/OAuth service|OAuth 服务/u)).toBeNull();
expect(screen.queryByLabelText(/Account|账户/u)).toBeNull();
expect(screen.getByText("person@example.com")).toBeTruthy();
expect(screen.getByText("@example/oauth / default")).toBeTruthy();
expect(within(connection).getByRole("button", { name: /Reauthorize|重新授权/u })).toBeTruthy();
const save = within(actions).getByRole("button", { name: /Save|保存/u });
const cancel = within(actions).getByRole("button", { name: /Cancel|取消/u });
const deleteProvider = within(actions).getByRole("button", { name: /Delete|删除/u });
expect(actionButtons).toEqual([save, cancel, deleteProvider]);
expect(within(actions).queryByRole("button", { name: /Reauthorize|重新授权/u })).toBeNull();
expect(screen.queryByRole("region", { name: /Danger zone|危险操作/u })).toBeNull();
```

Import `within` from Testing Library.

- [ ] **Step 2: Run the OAuth edit tests and verify failure**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- oauth-provider-edit-page.test.tsx
```

Expected: FAIL because OAuth identity still uses disabled inputs and all three actions share one row.

- [ ] **Step 3: Move OAuth identity and reauthorization into the Connection section**

In `oauth-provider-edit-fields.tsx`:

- add props `onReauthorize` and `isReauthorizing`;
- group name, enabled, and Provider weight under the existing Basic information message;
- replace disabled ID/service/account inputs with a semantic `<dl>` using existing Provider ID, OAuth service, and Account labels;
- keep `OAuthAccountFields` in the Connection section;
- render the helper and an outline Reauthorize button in that section;
- keep discovered models and aliases together under Models and aliases.

The Reauthorize button calls only `onReauthorize` and uses `isReauthorizing` for its disabled state.

- [ ] **Step 4: Separate OAuth Save, Cancel, and Delete in the page template**

In `oauth-provider-edit-page.tsx`:

- change the form container to the same `max-w-4xl` layout as Task 2;
- show `provider.id · OAuth` as muted identity below the page header;
- pass `onReauthorize={() => submit(true)}` and `isReauthorizing={startMutation.isPending}` to `OAuthProviderEditFields`;
- render a transparent `data-testid="provider-form-actions"` row with primary Save then outline Cancel on the left and destructive Delete on the right;
- Cancel navigates to `/providers`;
- mount `DeleteProviderDialog` with `onDeleted={() => void navigate({ to: "/providers" })}`;
- leave the active-session `OAuthAuthorizationPanel` branch unchanged.

- [ ] **Step 5: Run all affected Provider tests**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- providers-page.test.tsx provider-state-cell.test.tsx provider-form-fields-api.test.tsx delete-provider-dialog.test.tsx oauth-provider-edit-page.test.tsx
```

Expected: all affected Provider tests pass.

---

### Task 4: Repository and browser verification

**Files:**
- Verify only; fix failures in the files owned by Tasks 1–3.

**Interfaces:**
- Consumes: completed list and edit-page behavior.
- Produces: passing repository checks and visual evidence at desktop and 390px width.

- [ ] **Step 1: Run dashboard checks**

Run:

```bash
rtk bun run check
rtk bun run --filter @aio-proxy/dashboard test:unit
```

Expected: both commands exit successfully.

- [ ] **Step 2: Run repository preflight**

Run:

```bash
rtk bun run preflight
```

Expected: oxlint, oxfmt check, and all unit tests pass.

- [ ] **Step 3: Verify the real UI**

Using the authenticated local Dashboard at `http://127.0.0.1:3000/dashboard/`, verify:

- populated, filtered, empty, loading, focused, and multi-page Provider list states;
- editable rows navigate through the identity link and invalid rows retain delete confirmation;
- no single-page pagination, column menu, or horizontal clipping at 390px;
- API and AI SDK edit sections, alias drawer, centered terminal action row, and delete confirmation;
- OAuth read-only metadata, reauthorization within Connection, active-session panel, alias drawer, centered terminal action row, and delete confirmation;
- keyboard focus order and visible focus treatment.

Expected: the desktop surface is compact and identity-first; the narrow surface remains readable without horizontal clipping; no browser console errors appear.

---

### Task 4: Promote Provider identity into the page header

**Files:**
- Modify: `packages/dashboard/src/components/page-container/page-container.test.tsx`
- Modify: `packages/dashboard/src/components/page-container/page-container.tsx`
- Modify: `packages/dashboard/src/modules/providers/templates/provider-form-page.tsx`
- Modify: `packages/dashboard/src/modules/providers/templates/oauth-provider-edit-page.tsx`

**Interface:** `PageContainer` gains `subtitle?: string`; it renders directly below the `h1` and remains absent when omitted.

- [ ] **Step 1: Add a failing PageContainer test**

Render `<PageContainer title="Edit provider" subtitle="carpool · API">` and assert that the subtitle is visible while the title remains the sole level-one heading.

- [ ] **Step 2: Verify the test fails**

Run `rtk bun run --filter @aio-proxy/dashboard test:unit -- src/components/page-container/page-container.test.tsx`.

Expected: FAIL because `subtitle` is not a valid `PageContainer` prop.

- [ ] **Step 3: Implement the minimal header API**

Add `subtitle?: string` to `PageContainerProps`, render it as muted small text directly below the title, and keep `extra` aligned with the combined title block.

- [ ] **Step 4: Move Provider identity into the header**

Pass `subtitle` from API, AI SDK, and OAuth edit pages using `Provider ID · kind`; remove the matching first content paragraph. Create pages omit the prop.

- [ ] **Step 5: Verify**

Run the focused PageContainer and OAuth edit tests, then `rtk bun run preflight`. Confirm desktop and narrow header hierarchy in the authenticated Dashboard.
