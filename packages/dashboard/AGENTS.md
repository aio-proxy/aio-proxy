# Dashboard Frontend Rules

This file is the frontend authority for `packages/dashboard`.

## Package Shape

- The dashboard is a React/Rsbuild package served under `/dashboard/`.
- Use Bun workspace commands from the repo root, for example `bun run --filter @aio-proxy/dashboard build`.
- Do not edit `src/route-tree.gen.ts`; TanStack Router generates it.
- Keep browser-only code in this package.
- Dashboard API route and client types must come from the typed Hono client exported by `@aio-proxy/server`.
- Shared domain models and DTOs may be imported from `@aio-proxy/types`; do not redeclare them in the dashboard.

## UI Components

- Use the shadcn components in `src/components/ui` when an equivalent exists.
- Add missing shadcn components through the shadcn CLI so `components.json` stays the source of truth.
- The configured primitives are Base UI and lucide icons; follow that pattern for new UI controls.
- Direct Tailwind is fine for layout, spacing, responsive behavior, and page composition.
- Control styling belongs in the shared UI components, not one-off lookalikes.

## State Ownership

- Keep state in the closest component that owns its lifecycle and behavior. Transient UI state such as dialog visibility, drafts, expansion, focus, and local selection should not be lifted merely so a parent can trigger it.
- Lift state only when multiple components must coordinate around it, when it affects rendering outside the owning component, or when the route/URL is the actual source of truth.
- A component that owns an interaction should close the loop itself: opening, cancellation, successful completion, cleanup, and pending state belong together whenever they do not affect siblings.
- Prefer declarative props when the parent genuinely owns the state. For isolated commands such as `open(target)`, `reset()`, or `focus()`, a narrow imperative ref or callback API is acceptable and may keep implementation state private.
- `forwardRef` is a mechanism, not a requirement. Choose props, callbacks, refs, context, or a store according to state ownership; do not introduce any of them solely to move local state upward.

## Data And Requests

- Mount `QueryClientProvider` globally in `routes/__root.tsx` once the dashboard has server state.
- Server state must use TanStack Query.
- Components, routes, and templates must not call `fetch` directly.
- Dashboard API calls should live in `src/modules/<domain>/services/` and use the typed Hono client from `createDashboardClient`.
- Do not add preview fallback or mock service responses. Dev and QA should exercise the real dashboard routes in `@aio-proxy/server`.

## Forms

- Every input, select, checkbox, textarea, and editable field must use TanStack Form.
- Zod is the validation and schema source.
- Use shadcn `Field`, `Label`, `Input`, `Select`, `Checkbox`, and `Textarea` components for form UI.

## Tables

- Every data table must use TanStack Table plus shadcn `Table`.
- Default capabilities are sorting, filtering, pagination, and column visibility.
- Table state stays local to the component or module unless explicitly requested.

## Copy And i18n

- All user-facing copy must come from i18n messages.
- Do not hardcode labels, placeholders, helper text, empty states, error messages, success messages, button text, table headers, badges, ARIA labels, page titles, or page descriptions in components, templates, routes, or hooks.
- Add or update keys in `packages/i18n/messages/*.json` before using them.
- Import messages as `import { m } from "@aio-proxy/i18n"` and call keys with `m.some_key()`.
- Run `bun run i18n:compile` after changing message files.
- Non-user-facing constants, protocol values, IDs, query keys, route paths, and test fixtures may stay literal.

## Module Structure

- Use `src/modules/<domain>/` for non-trivial dashboard features.
- Each module may contain `services/`, `hooks/`, `components/`, `stores/`, and `templates/`.
- `services`: non-React domain adapters, types, query options, and mutation functions. Services may call the typed Hono dashboard client.
- `hooks`: React Query, TanStack Form, and TanStack Table hooks only.
- `components`: reusable domain UI pieces.
- `stores`: client-only UI state such as collapsed panels, local table state, and selected rows. Stores must not mirror API response data.
- `templates`: page-level assembly such as `ProvidersPage`.
- `routes/*.tsx` should declare TanStack Router routes and render module templates for non-trivial pages.
- Each `.tsx` file may declare exactly one React component. Split helper components into their own files instead of colocating multiple components in one file.
- Declare React components with arrow functions typed as `React.FC<ComponentNameProps>`; do not use function declarations for components.
- Component props must use an `interface` named `<ComponentName>Props`, for example `Foo` uses `interface FooProps`. Do not use a generic `type Props` or `interface Props`.
- Component filenames should match their single exported component in kebab-case, for example `PageContainer` lives in `page-container.tsx`.

## Few-Shots

### shadcn

Bad:

```tsx
<span className="rounded-md border px-2 py-1 text-xs">Stored</span>
```

Good:

```tsx
<Badge variant="outline">{m.provider_stored_redacted()}</Badge>
```

### Query

Bad:

```tsx
useEffect(() => {
  void createDashboardClient("").dashboard.api.providers.$get().then(setProviders);
}, []);
```

Good:

```tsx
const providers = useQuery(providersQueryOptions());
```

### Form

Bad:

```tsx
<Input value={name} onChange={(event) => setName(event.target.value)} />
```

Good:

```tsx
<form.Field name="name">
  {(field) => <Input value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} />}
</form.Field>
```

### Table

Bad:

```tsx
<table>
  {rows.map((row) => (
    <tr key={row.id}>{row.name}</tr>
  ))}
</table>
```

Good:

```tsx
const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() });
return (
  <Table>
    {table.getRowModel().rows.map((row) => (
      <TableRow key={row.id} />
    ))}
  </Table>
);
```

### Services

Bad:

```tsx
const response = await fetch("/dashboard/api/providers");
```

Good:

```ts
export const providersQueryOptions = () =>
  queryOptions({
    queryKey: ["providers"],
    queryFn: async () => {
      const response = await dashboardClient.dashboard.api.providers.$get();
      return response.json();
    },
  });
```

### es-toolkit

Bad:

```ts
const byProvider = items.reduce<Record<string, Model[]>>((acc, item) => {
  acc[item.providerId] = [...(acc[item.providerId] ?? []), item];
  return acc;
}, {});
```

Good:

```ts
import { groupBy } from "es-toolkit/array";

const byProvider = groupBy(items, (item) => item.providerId);
```

### i18n

Bad:

```tsx
<Button>Save provider</Button>
```

Good:

```tsx
import { m } from "@aio-proxy/i18n";

<Button>{m.dashboard_providers_save()}</Button>;
```
