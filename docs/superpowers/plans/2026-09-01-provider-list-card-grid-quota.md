# Provider List Card Grid + OAuth Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard provider list's TanStack Table with a responsive card grid, and surface OAuth remaining quota (剩余额度) on each card as a compact ring that opens a detail modal.

**Architecture:** Bottom-up. The plugin SDK type and its core validator go first, then the `DashboardProviderSummary` shape change with every server call site, then the server-side quota cache + `QUERY` route + pipeline warming hook, then the two plugins that populate `plan`, then i18n, then the dashboard's pure view logic, services, card components, and finally the page rewrite that deletes the table.

**Tech Stack:** Bun workspaces + Turborepo, TypeScript, Zod v4, Hono (server + typed RPC client), React 19 + TanStack Query/Router, Tailwind v4 + shadcn (`@aio-proxy/ui`), Paraglide (`@aio-proxy/i18n`), rstest (dashboard tests), `bun test` (everything else), `lru-cache`, `es-toolkit`.

**Spec:** [2026-09-01-provider-list-card-grid-quota-design.md](../specs/2026-09-01-provider-list-card-grid-quota-design.md)

## Global Constraints

- Every user-visible string goes through Paraglide: `import { m } from '@aio-proxy/i18n'`, called as `m['dashboard.providers.some_key']()`. Message files are **nested JSON** at `packages/i18n/messages/<locale>.json`; a key must be added to **all five locales**: `en, ja, ko, zh-Hans, zh-Hant`. Run `bun run i18n:compile` after editing messages, before running dashboard tests.
- Non-user-facing constants, protocol values, IDs, query keys, route paths, `data-testid`s, and test fixtures stay literal.
- A dashboard module directory contains ONLY these six subdirectories: `services, hooks, components, stores, templates, lib`. `services` crosses the network boundary; `lib` never imports React and never calls the dashboard client.
- No cross-module imports: a `@/modules/<a>/...` import inside `modules/<b>/` is forbidden. Shared code goes to `src/lib/` or `src/components/`.
- Each `.tsx` file declares exactly one React component, as `export const Name: React.FC<NameProps>` (arrow function, never a function declaration). Props use `interface <ComponentName>Props`, never a generic `Props`. Filenames are kebab-case matching the component.
- Server state uses TanStack Query. Components, routes, and templates must not call `fetch`.
- Never edit `packages/dashboard/src/route-tree.gen.ts`.
- `packages/ui/src/components/` is shadcn-CLI-managed. Generate files there with the CLI rather than hand-writing them; `oxfmt` via `bun run format` and narrow, documented additions such as the `closeLabel` prop that lets a caller pass localized copy are the only permitted hand edits.
- Handwritten non-test implementation files stay under 500 lines; evaluate splitting at 400 into `foo/index.ts` (exports only) + `foo/foo.ts` + private collaborators.
- Colocate tests next to their source: `foo/index.ts`, `foo/foo.ts`, `foo/foo.test.ts`.
- Prefer `es-toolkit` (narrow imports: `es-toolkit/array`, `es-toolkit/object`, `es-toolkit/predicate`) over hand-written generic utilities. Use `isPlainObject` from `es-toolkit/predicate` for wire payloads.
- Domain language: **Provider ID**, **provider priority** (`0..10000`, default `0`, higher tried first), **provider weight** (default `1`, clamped `0..10000`).
- `bun run preflight` (= `bun run lint:types && bun run format:check && bun run test`) must pass from the worktree root. `lint:types` exists **only** at the root and requires `bun run build` to have produced `packages/*/dist` first.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- One changeset, `minor`, targeting `aio-proxy` and `@aio-proxy/plugin-sdk` alongside every internal package touched.

**Deliberate deviation from the spec, applied throughout:** the spec's quota response sketch was `{ snapshot, sampledAt, plan?, stale, error? }`. Because `plan` now lives *inside* `OAuthQuotaSnapshot` (Task 1), the route returns `{ snapshot, sampledAt, stale, error? }` and every reader takes the plan from `snapshot.plan`. Duplicating it at the top level would be two sources of truth.

## Execution status

Every task is **landed**. Their steps are kept below as the record of what was built; do not re-run them. Only PR creation remains.

| Task | Commit |
| --- | --- |
| 1 — OAuth quota `plan` | `26dcb2eb` |
| 2 — `protocols[]` + `hasQuota` | `f325bf90` |
| 3 — Quota cache | `fef15e14` |
| 4 — Quota route | `8f804b40` |
| 5 — Pipeline warming | `72fdc48d` |
| 6 — kimi-code plan | `27a6d01f` |
| 7 — xai-grok plan + per-product usage | `e3e9d4b5` |
| 8 — Dialog primitive | (folded into `f325bf90`; the primitive was already present) |
| 9 — Card and quota copy | `7754735f` |
| Review round 1 follow-ups | `77213e25` |
| 10 — Pure list and quota view helpers | `b47fd3aa` |
| 11 — Health and quota services | `b2da608c` |
| 13 — Quota ring and detail modal (built before 12, which imports it) | `9bd941dd` |
| 12 — Provider card | `85ef866c` |
| 14 — Grid, page rewrite, table removal, message pruning | `86f055d3` |
| 15 — Changeset | `b1f5bff2` |
| Review round 2 follow-ups (quota invalidation) | `0bff48df` |
| Review round 2 follow-ups (invalid-Provider diagnostics, focus) | `8bcf2631` |
| Review round 2 follow-ups (spec, plan, changeset sync) | `386fc22f` |
| Review round 3 follow-ups (retryable quota, identity tracking, i18n, doc sync) | `6a45b0ca`, `93ef7168`, `2b3dbf18` |
| Review round 4 follow-up (route gates its 404 on `permanent`) | `0cbeed08` |
| Review round 5 follow-up (identity read off the snapshot) | `3f22d428` |
| Review round 6 follow-ups (no-digest invalidation, zero-vs-unknown usage) | pending commit |

**Quota cache invalidation:** everything in the cache is keyed by Provider ID alone, so
`commitConfig` invalidates each Provider whose quota identity moved. That identity is
`Snapshot.runtimeCache[id].identity` — the digest materialization already computes, folding in the
plugin version, the plugin options digest (which includes the stored plugin secret), the account
options digest, the account's `runtimeRevision` (bumped by every credential write, so a
reauthentication moves it), the effective proxy, and the request transforms. Reading it off the
committed snapshot rather than re-deriving it from the repository keeps the single-read isolation
contract intact: a corrupt account or unreadable plugin secret is handled once, during
materialization, and marks only its own Provider unavailable
(`__tests__/plugin-snapshot/isolation-storage.test.ts` pins both). A Provider with no cache entry
produced no runtime — unavailable, or disabled — so there is no digest to compare; "no digest" is
never treated as "same as last time", because a Provider ID is reusable and the cache also latches a
"quota unsupported" mark that would otherwise survive a repoint until restart.

`77213e25` also moved the route to `packages/server/src/dashboard-routes/provider-routes/` with a colocated `provider-routes.test.ts`, dropped the `hono/etag` middleware (it cached the very body `refresh` exists to bypass), made the cache persist failures as stale entries with negative caching and in-flight dedupe, gated warming on `response.ok`, threaded `hasQuota` through the materialization failure paths, and annotated `PROTOCOL_LABELS` as `Record<ProviderProtocol, …>` (which surfaced the missing `openai-image` entry, so **Task 12 Step 3's label addition is already done** — only the `PROTOCOL_ORDER` pin remains).

**Task 7 correction:** the xAI weekly-window behaviour was already correct before the change — `weeklyItem()` returned an item whenever `currentPeriod.end` parsed. The test added in `e3e9d4b5` is a regression guard, not a fix. Neither the changeset nor the PR body may claim a unified-billing weekly-limit fix.

**Known baseline:** `bun run lint:types` reports 11 pre-existing TypeScript errors on pristine `main` (`91de6ca4`), all in `packages/dashboard` and `packages/cli`, none from this work. `bun run preflight` therefore cannot pass end-to-end; report the baseline honestly rather than papering over it.

---

## File map

### Task 1 — SDK quota plan
| File | Responsibility |
| --- | --- |
| `packages/plugin-sdk/src/oauth.ts` | Add `plan?: LocalizedText` to `OAuthQuotaSnapshot` |
| `packages/core/src/plugins/quota.ts` | Allow + validate `plan` in `validateOAuthQuotaSnapshot` |
| `packages/core/src/plugins/quota.test.ts` | Accept/reject coverage for `plan` |

### Task 2 — Summary shape
| File | Responsibility |
| --- | --- |
| `packages/types/src/dashboard/dashboard.ts` | `protocol?` → required `protocols`, add required `hasQuota` |
| `packages/types/src/dashboard/dashboard.test.ts`, `packages/types/src/plugin.test.ts`, `packages/types/__tests__/dashboard.test.ts` | Fixture updates |
| `packages/server/src/plugin-runtime/catalog.ts` | `summary()` emits `protocols: []` + `hasQuota` |
| `packages/server/src/plugin-runtime/materialize.ts` | Pass `adapter.quota !== undefined` through `persistedSummary` |
| `packages/server/src/provider-runtime/materialize.ts` | `providerDisplayFields` emits `protocols`; both summary builders emit `hasQuota: false` |
| `packages/server/src/server-state/snapshot.ts` | Invalid-provider literal gains both fields |
| `packages/server/src/model-routing/inventory.test.ts`, `packages/cli/__tests__/provider-commands.dashboard.test.ts` | Fixture updates |
| `packages/dashboard/src/modules/providers/lib/provider-fixtures.ts` | Fixture stub gains both fields |

### Task 3 — Server quota cache
| File | Responsibility |
| --- | --- |
| `packages/server/src/plugin-quota/cache/index.ts` | Export-only barrel |
| `packages/server/src/plugin-quota/cache/quota-cache.ts` | Cooldown-guarded in-memory wrapper around `createOAuthQuotaReader` |
| `packages/server/src/plugin-quota/cache/quota-cache.test.ts` | Cooldown / bypass / stale-on-failure behaviour |
| `packages/server/src/plugin-quota/index.ts` | Re-export the cache |

### Task 4 — Quota route
| File | Responsibility |
| --- | --- |
| `packages/server/src/server-state/types.ts` | `ServerState.quotaCache` |
| `packages/server/src/server-state/index.ts` | Construct + wire the cache |
| `packages/server/src/dashboard-routes/provider-routes/provider-routes.ts` | `QUERY /providers/:id/quota` |
| `packages/server/src/dashboard-routes/provider-routes/provider-routes.test.ts` | Route behaviour |

### Task 5 — Pipeline warming
| File | Responsibility |
| --- | --- |
| `packages/server/src/runtime.ts` | `ProviderRouteSource.warmProviderQuota?` |
| `packages/server/src/routes/pipeline/attempt/attempt.ts` | Fire-and-forget warm at both return sites |
| `packages/server/src/server-state/index.ts` | Supply `warmProviderQuota` |

### Task 6 / 7 — Plugins
| File | Responsibility |
| --- | --- |
| `packages/plugins/kimi-code/src/quota.ts` + `quota.test.ts` | `user.membership.level` → plan |
| `packages/plugins/xai-grok/src/quota.ts` + `quota.test.ts` | plan from `/settings`, per-product usage, weekly-window regression guard |

### Task 8 — Dialog primitive
| File | Responsibility |
| --- | --- |
| `packages/ui/src/components/dialog.tsx` | Generated by the shadcn CLI; format + commit, plus a `closeLabel` prop so the caller supplies the localized close label (`packages/ui` has no i18n dependency) |

### Task 9 — i18n
| File | Responsibility |
| --- | --- |
| `packages/i18n/messages/{en,ja,ko,zh-Hans,zh-Hant}.json` | New `dashboard.providers.card` + `dashboard.providers.quota` groups |

### Task 10 — Pure view logic
| File | Responsibility |
| --- | --- |
| `packages/dashboard/src/modules/providers/lib/provider-list-view/{index.ts,provider-list-view.ts,provider-list-view.test.ts}` | display name, edit-ability, filter, sort |
| `packages/dashboard/src/modules/providers/lib/quota-view/{index.ts,quota-view.ts,quota-view.test.ts}` | tightest item, percent rounding |

### Task 11 — Services
| File | Responsibility |
| --- | --- |
| `packages/dashboard/src/lib/query-keys.ts` | `providerHealth`, `providerQuota(id)` |
| `packages/dashboard/src/modules/providers/services/provider-health-service/{index.ts,provider-health-service.ts}` | 24h `providerHealth` map (removes the cross-module import) |
| `packages/dashboard/src/modules/providers/services/provider-quota-service/{index.ts,provider-quota-service.ts}` | `QUERY` call + query options |

### Task 12/13 — Components
| File | Responsibility |
| --- | --- |
| `.../components/provider-protocol-stack/{index.ts,provider-protocol-stack.tsx}` | Stacked protocol icons + `+N` |
| `.../components/provider-quota-ring/{index.ts,provider-quota-ring.tsx,provider-quota-dialog.tsx,provider-quota-ring.test.tsx}` | Ring button + modal |
| `.../components/provider-card/{index.ts,provider-card.tsx,provider-card-identity.tsx,provider-card-stats.tsx,provider-card-footer.tsx,provider-card.test.tsx}` | One card |
| `.../components/provider-card-grid/{index.ts,provider-card-grid.tsx,provider-filter-chips.tsx,provider-card-grid.test.tsx}` | Filters + grid + focus deep-link |
| `packages/dashboard/src/components/protocol-label/protocol-label.tsx` | Add the missing `openai-image` entry |

### Task 14 — Page rewrite + deletions
| File | Responsibility |
| --- | --- |
| `.../templates/providers-page.tsx` + `providers-page.test.tsx` | Render the grid |
| **Deleted:** `.../components/providers-table/`, `providers-table-columns.tsx`, `oauth-provider-group-row/`, `provider-table-actions.tsx`, `provider-state-cell.tsx(+test)`, `provider-models-cell.tsx` | |

### Task 15 — Changeset
| File | Responsibility |
| --- | --- |
| `.changeset/provider-card-grid-quota.md` | `minor` for every touched package |

---

### Task 1: OAuth quota `plan`

**Files:**
- Modify: `packages/plugin-sdk/src/oauth.ts:147-150`
- Modify: `packages/core/src/plugins/quota.ts:157` and the `validateOAuthQuotaSnapshot` body
- Test: `packages/core/src/plugins/quota.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `OAuthQuotaSnapshot.plan?: LocalizedText` — accepted by `validateOAuthQuotaSnapshot`, consumed by Tasks 3, 6, 7, 13.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/plugins/quota.test.ts`:

```ts
test('accepts a localized plan on the snapshot', () => {
  const snapshot = validateOAuthQuotaSnapshot({
    ...validSnapshot(),
    plan: { default: 'Allegro', 'zh-Hans': 'Allegro' },
  });
  expect(snapshot.plan).toEqual({ default: 'Allegro', 'zh-Hans': 'Allegro' });
});

test('accepts a plain string plan and omits an absent one', () => {
  expect(validateOAuthQuotaSnapshot({ ...validSnapshot(), plan: 'SuperGrok' }).plan).toBe('SuperGrok');
  expect(validateOAuthQuotaSnapshot(validSnapshot())).not.toHaveProperty('plan');
});

test('rejects a non-text plan', () => {
  expectInvalid({ ...validSnapshot(), plan: 42 }, ['plan']);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/core/src/plugins/quota.test.ts
```

Expected: FAIL — the first two tests throw `OAuthQuotaValidationError` at path `[]` because `plan` is not in `SNAPSHOT_KEYS`.

- [ ] **Step 3: Write minimal implementation**

In `packages/plugin-sdk/src/oauth.ts`, extend the snapshot type:

```ts
export type OAuthQuotaSnapshot = {
  readonly items: readonly OAuthQuotaItem[];
  readonly resetCredits?: OAuthQuotaResetCredits;
  /** Human-readable subscription tier for this account, when the upstream exposes one. */
  readonly plan?: LocalizedText;
};
```

In `packages/core/src/plugins/quota.ts`, widen the allowlist:

```ts
const SNAPSHOT_KEYS = new Set(['items', 'resetCredits', 'plan']);
```

then, inside `validateOAuthQuotaSnapshot`, destructure and validate it. Change the destructuring line to:

```ts
    const { items: snapshotItems, resetCredits: snapshotResetCredits, plan: snapshotPlan } = snapshot;
```

add, immediately before the final `return`:

```ts
    const plan = snapshotPlan === undefined ? undefined : localizedText(snapshotPlan, ['plan']);
```

and change the final `return` of the outer `withPlainRecord` callback to:

```ts
    return {
      items,
      ...(resetCredits === undefined ? {} : { resetCredits }),
      ...(plan === undefined ? {} : { plan }),
    };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/core/src/plugins/quota.test.ts packages/core/src/plugins/quota-rejections.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-sdk/src/oauth.ts packages/core/src/plugins/quota.ts packages/core/src/plugins/quota.test.ts
git commit -m "feat(plugin-sdk): allow an optional plan on OAuth quota snapshots" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `protocols[]` and `hasQuota` on the provider summary

**Files:**
- Modify: `packages/types/src/dashboard/dashboard.ts:17-37`
- Modify: `packages/types/src/dashboard/dashboard.test.ts:73-99`, `packages/types/src/plugin.test.ts:50,70`, `packages/types/__tests__/dashboard.test.ts:5-13`
- Modify: `packages/server/src/plugin-runtime/catalog.ts:21-63`
- Modify: `packages/server/src/plugin-runtime/materialize.ts:189-193`
- Modify: `packages/server/src/provider-runtime/materialize.ts:285-345`
- Modify: `packages/server/src/server-state/snapshot.ts:214-228`
- Modify: `packages/server/src/model-routing/inventory.test.ts:120-135`, `packages/cli/__tests__/provider-commands.dashboard.test.ts:45-55`
- Modify: `packages/dashboard/src/modules/providers/lib/provider-fixtures.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `DashboardProviderSummary.protocols: readonly ProviderProtocol[]` (empty for non-API providers) and `DashboardProviderSummary.hasQuota: boolean`. Tasks 11–14 read both.

- [ ] **Step 1: Write the failing test**

Replace the body of `packages/types/src/dashboard/dashboard.test.ts:73-99` (the test named `preserves configured API and AI SDK display fields in dashboard summaries`) with:

```ts
test('preserves configured API and AI SDK display fields in dashboard summaries', () => {
  const base = {
    enabled: true,
    passthrough: false,
    last_status: 'unknown',
    last_latency: null,
    clientModels: [],
    protocols: [],
    hasQuota: false,
    state: { status: 'ready' },
  } as const;
  const api = {
    ...base,
    id: 'anthropic-api',
    kind: ProviderKind.Api,
    weight: 9,
    protocols: [ProviderProtocol.Anthropic, ProviderProtocol.OpenAICompatible],
  } as const;
  const aiSdk = { ...base, id: 'anthropic-sdk', kind: ProviderKind.AiSdk, packageName: '@ai-sdk/anthropic' } as const;

  expect(DashboardProviderSummarySchema.parse(api)).toEqual(api);
  expect(DashboardProviderSummarySchema.parse(aiSdk)).toEqual(aiSdk);
  expect(DashboardProviderSummarySchema.parse(aiSdk).protocols).toEqual([]);
});

test('requires protocols and hasQuota on every summary', () => {
  const missing = {
    id: 'anthropic-api',
    kind: ProviderKind.Api,
    enabled: true,
    passthrough: false,
    last_status: 'unknown',
    last_latency: null,
    clientModels: [],
    state: { status: 'ready' },
  };
  expect(DashboardProviderSummarySchema.safeParse(missing).success).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/types/src/dashboard/dashboard.test.ts
```

Expected: FAIL — `protocols`/`hasQuota` are stripped by the schema, so `toEqual(api)` mismatches and the `safeParse` still succeeds.

- [ ] **Step 3: Write minimal implementation**

`packages/types/src/dashboard/dashboard.ts` — replace the `protocol` line and add `hasQuota`:

```ts
  // API providers can serve several protocols from one config; non-API providers get an empty list.
  protocols: z.array(ProviderProtocolSchema).readonly(),
  hasQuota: z.boolean(),
  packageName: z.string().trim().min(1).optional(),
```

(Delete the old `protocol: ProviderProtocolSchema.optional(),` line. `ProviderProtocolSchema` stays imported.)

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/types/src/dashboard/dashboard.test.ts
```

Expected: PASS for the two edited tests; other type-package tests may now fail — fix them in Step 5.

- [ ] **Step 5: Update the remaining fixtures**

`packages/types/src/plugin.test.ts` — add `protocols: [], hasQuota: false` to both provider literals (lines ~50 and ~70); for the API one use its real protocol list.

`packages/types/__tests__/dashboard.test.ts` — add `protocols: [], hasQuota: false` to `unavailableProvider`.

`packages/server/src/model-routing/inventory.test.ts` — in `summariesFrom` (~line 120) add `protocols: [], hasQuota: false` to the constructed summary.

`packages/cli/__tests__/provider-commands.dashboard.test.ts` — add `protocols: [], hasQuota: false` to the summary literal near line 49.

`packages/dashboard/src/modules/providers/lib/provider-fixtures.ts`:

```ts
export const providerStub = (overrides: Partial<DashboardProviderSummary> = {}): DashboardProviderSummary => ({
  id: 'provider-id',
  kind: ProviderKind.OAuth,
  enabled: true,
  passthrough: false,
  last_status: 'unknown',
  last_latency: null,
  clientModels: [],
  protocols: [],
  hasQuota: false,
  state: { status: 'ready' },
  ...overrides,
});
```

- [ ] **Step 6: Populate the fields on the server**

`packages/server/src/plugin-runtime/catalog.ts` — `summary()` gains a fourth parameter and two emitted fields:

```ts
export function summary(
  config: OAuthProvider,
  provider: RuntimeProviderInstance | undefined,
  persisted?: {
    readonly accountLabel?: string;
    readonly expiresAt?: number;
    readonly catalogLastSuccessAt?: string;
  },
  hasQuota = false,
): Omit<DashboardProviderSummary, 'state'> {
  return {
    id: config.id,
    kind: ProviderKind.OAuth,
    enabled: config.enabled,
    passthrough: provider?.raw !== undefined,
    last_status: 'unknown',
    last_latency: null,
    name: config.name,
    // OAuth providers speak whatever their plugin runtime speaks; there is no configured wire protocol.
    protocols: [],
    hasQuota,
    ...(config.priority === undefined ? {} : { priority: config.priority }),
    ...(config.weight === undefined ? {} : { weight: config.weight }),
    clientModels: provider === undefined ? [] : uniq(modelRoutes(provider).map((route) => route.alias)),
    plugin: config.plugin,
    capability: config.capability,
    ...(persisted?.accountLabel === undefined ? {} : { accountLabel: persisted.accountLabel }),
    ...(persisted?.expiresAt === undefined ? {} : { expiresAt: persisted.expiresAt }),
    ...(persisted?.catalogLastSuccessAt === undefined ? {} : { catalogLastSuccessAt: persisted.catalogLastSuccessAt }),
  };
}
```

`failure()` keeps calling `summary(options.config, undefined, persisted)` — quota capability is unknown on every failure path, so `hasQuota` correctly defaults to `false`.

`packages/server/src/plugin-runtime/materialize.ts` — the `persistedSummary` closure (~line 189) is declared after `const { adapter, ... } = prepared;`, so the adapter is in scope:

```ts
  const persistedSummary = (provider: Parameters<typeof summary>[1], catalog: typeof storedCatalog) =>
    summary(
      config,
      provider,
      {
        ...accountSummary,
        ...(catalog === null ? {} : { catalogLastSuccessAt: new Date(catalog.refreshedAt).toISOString() }),
      },
      adapter.quota !== undefined,
    );
```

`packages/server/src/provider-runtime/materialize.ts` — `providerDisplayFields` returns a protocol list:

```ts
function providerDisplayFields(
  provider: Provider,
): Pick<ProviderRuntimeSummary, 'priority' | 'weight' | 'protocols' | 'packageName'> {
  return {
    ...routingDefaults(provider),
    protocols:
      provider.kind === ProviderKind.Api ? uniq(apiProviderEndpoints(provider).map((endpoint) => endpoint.protocol)) : [],
    ...(provider.kind === ProviderKind.AiSdk ? { packageName: provider.packageName } : {}),
  };
}
```

(`uniq` is already imported in this file.)

In `providerSummary`, `providerDisplayFields` is only spread when `config !== undefined`, so seed both required fields before the spread:

```ts
    last_latency: null,
    protocols: [],
    // Only OAuth plugin providers can expose a quota capability.
    hasQuota: false,
    // Runtime factories don't carry `name`, so callers pass the config display name through.
    ...(name === undefined ? {} : { name }),
    ...(config === undefined ? {} : providerDisplayFields(config)),
```

In `providerConfigSummary`, add `hasQuota: false,` next to `last_latency: null,` (its `...providerDisplayFields(provider)` already supplies `protocols`).

`packages/server/src/server-state/snapshot.ts` — the invalid-provider literal:

```ts
        ({
          id: invalid.id,
          kind: invalid.kind ?? 'invalid',
          enabled: false,
          passthrough: false,
          last_status: 'unknown',
          last_latency: null,
          clientModels: [],
          protocols: [],
          hasQuota: false,
        }) satisfies Omit<DashboardProviderSummary, 'state'>,
```

- [ ] **Step 7: Run the affected suites**

```bash
bun run build && bun run lint:types
bun test packages/types/src packages/types/__tests__
cd packages/server && bun test --preload=./__tests__/setup.ts && cd ../..
cd packages/cli && bun run test:unit && cd ../..
```

Expected: PASS. The only remaining `lint:types` errors should be the two dashboard readers of `provider.protocol` in `providers-table-columns.tsx` — that file is deleted in Task 14. To keep the tree green in the meantime, change those two reads now:

- line 87: `` if (row.provider.kind === 'api') return `${PROVIDER_KIND_LABEL.api} · ${row.provider.protocols[0] ?? 'N/A'}`; ``
- line 100: `<ProtocolLabel className="truncate text-muted-foreground" protocol={provider.protocols[0] ?? 'N/A'} />`

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(types): expose provider protocols list and quota capability on dashboard summaries" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Cooldown-guarded OAuth quota cache

**Files:**
- Create: `packages/server/src/plugin-quota/cache/index.ts`
- Create: `packages/server/src/plugin-quota/cache/quota-cache.ts`
- Test: `packages/server/src/plugin-quota/cache/quota-cache.test.ts`
- Modify: `packages/server/src/plugin-quota/index.ts`

**Interfaces:**
- Consumes: `OAuthQuotaReader` from `packages/server/src/plugin-quota/read.ts`, `OAuthQuotaSnapshot` (with `plan`) from Task 1.
- Produces:
  ```ts
  export type OAuthQuotaCacheEntry = {
    readonly snapshot: OAuthQuotaSnapshot;
    readonly sampledAt: number;
    readonly stale: boolean;
    readonly error?: string;
  };
  export type OAuthQuotaCache = {
    readonly read: (providerId: string, signal: AbortSignal, refresh?: boolean) => Promise<OAuthQuotaCacheEntry>;
    readonly warm: (providerId: string) => void;
  };
  export function createOAuthQuotaCache(reader: OAuthQuotaReader): OAuthQuotaCache;
  ```
  Task 4 calls `read`, Task 5 calls `warm`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/plugin-quota/cache/quota-cache.test.ts`:

```ts
import { expect, test } from 'bun:test';

import type { OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';

import type { OAuthQuotaReader } from '../read';
import { createOAuthQuotaCache } from './quota-cache';

const snapshot = (id: string): OAuthQuotaSnapshot => ({ items: [{ id, displayName: id }] });

function countingReader(results: readonly (OAuthQuotaSnapshot | Error)[]): OAuthQuotaReader & { calls: () => number } {
  let index = 0;
  return {
    calls: () => index,
    read: async () => {
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      if (result instanceof Error) throw result;
      return result as OAuthQuotaSnapshot;
    },
  };
}

const signal = () => new AbortController().signal;

test('serves the cached snapshot while the provider is cooling down', async () => {
  const reader = countingReader([snapshot('a'), snapshot('b')]);
  const cache = createOAuthQuotaCache(reader);

  const first = await cache.read('p', signal());
  const second = await cache.read('p', signal());

  expect(reader.calls()).toBe(1);
  expect(second.snapshot).toEqual(snapshot('a'));
  expect(second.stale).toBe(false);
  expect(second.sampledAt).toBe(first.sampledAt);
});

test('an explicit refresh bypasses the cooldown', async () => {
  const reader = countingReader([snapshot('a'), snapshot('b')]);
  const cache = createOAuthQuotaCache(reader);

  await cache.read('p', signal());
  const refreshed = await cache.read('p', signal(), true);

  expect(reader.calls()).toBe(2);
  expect(refreshed.snapshot).toEqual(snapshot('b'));
});

test('a failed refresh keeps the last snapshot and reports it as stale', async () => {
  const reader = countingReader([snapshot('a'), new Error('QUOTA_READ_FAILED')]);
  const cache = createOAuthQuotaCache(reader);

  await cache.read('p', signal());
  const stale = await cache.read('p', signal(), true);

  expect(stale.snapshot).toEqual(snapshot('a'));
  expect(stale.stale).toBe(true);
  expect(stale.error).toBe('QUOTA_READ_FAILED');
});

test('a first read that fails rejects instead of inventing an empty snapshot', async () => {
  const cache = createOAuthQuotaCache(countingReader([new Error('nope')]));
  await expect(cache.read('p', signal())).rejects.toThrow('nope');
});

test('warm never rejects and respects the cooldown', async () => {
  const reader = countingReader([snapshot('a')]);
  const cache = createOAuthQuotaCache(countingReader([new Error('boom')]));
  cache.warm('p');
  await Bun.sleep(5);

  const cooled = createOAuthQuotaCache(reader);
  cooled.warm('p');
  await Bun.sleep(5);
  cooled.warm('p');
  await Bun.sleep(5);
  expect(reader.calls()).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/server && bun test src/plugin-quota/cache/quota-cache.test.ts
```

Expected: FAIL — `Cannot find module './quota-cache'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/plugin-quota/cache/quota-cache.ts`:

```ts
import type { OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';
import { LRUCache } from 'lru-cache';

import type { OAuthQuotaReader } from '../read';

const COOLDOWN_MS = 5 * 60_000;
const MAX_ENTRIES = 256;
const WARM_TIMEOUT_MS = 15_000;

export type OAuthQuotaCacheEntry = {
  readonly snapshot: OAuthQuotaSnapshot;
  readonly sampledAt: number;
  readonly stale: boolean;
  readonly error?: string;
};

export type OAuthQuotaCache = {
  readonly read: (providerId: string, signal: AbortSignal, refresh?: boolean) => Promise<OAuthQuotaCacheEntry>;
  readonly warm: (providerId: string) => void;
};

type Sample = { readonly snapshot: OAuthQuotaSnapshot; readonly sampledAt: number };

/**
 * In-memory only, lost on restart: a quota snapshot is a cheap re-read and persisting it would
 * outlive the credential it describes.
 *
 * The cooldown is set even when a read throws, so a provider whose upstream is down is retried at
 * the same 5-minute rhythm instead of on every card render. `refresh: true` (the modal's manual
 * button) is the documented escape hatch.
 */
export function createOAuthQuotaCache(reader: OAuthQuotaReader): OAuthQuotaCache {
  const samples = new LRUCache<string, Sample>({ max: MAX_ENTRIES });
  const cooldown = new LRUCache<string, true>({ max: MAX_ENTRIES, ttl: COOLDOWN_MS, ttlAutopurge: true });

  const read = async (providerId: string, signal: AbortSignal, refresh = false): Promise<OAuthQuotaCacheEntry> => {
    const cached = samples.get(providerId);
    if (!refresh && cached !== undefined && cooldown.has(providerId)) {
      return { snapshot: cached.snapshot, sampledAt: cached.sampledAt, stale: false };
    }
    cooldown.set(providerId, true);
    try {
      const snapshot = await reader.read(providerId, signal);
      const sample: Sample = { snapshot, sampledAt: Date.now() };
      samples.set(providerId, sample);
      return { snapshot: sample.snapshot, sampledAt: sample.sampledAt, stale: false };
    } catch (error) {
      if (cached === undefined) throw error;
      return {
        snapshot: cached.snapshot,
        sampledAt: cached.sampledAt,
        stale: true,
        error: error instanceof Error ? error.message : 'QUOTA_READ_FAILED',
      };
    }
  };

  return {
    read,
    // ponytail: no in-flight dedupe — the cooldown plus the dashboard's 30s staleTime already
    // collapse bursts; add one if a provider ever shows concurrent upstream reads.
    warm: (providerId) => {
      if (cooldown.has(providerId)) return;
      void read(providerId, AbortSignal.timeout(WARM_TIMEOUT_MS)).catch(() => {});
    },
  };
}
```

Create `packages/server/src/plugin-quota/cache/index.ts`:

```ts
export { createOAuthQuotaCache, type OAuthQuotaCache, type OAuthQuotaCacheEntry } from './quota-cache';
```

Append to `packages/server/src/plugin-quota/index.ts`:

```ts
export * from './cache';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/server && bun test src/plugin-quota
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/plugin-quota
git commit -m "feat(server): cache OAuth quota reads behind a per-provider cooldown" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `QUERY /dashboard/api/providers/:id/quota`

**Files:**
- Modify: `packages/server/src/server-state/types.ts:81-97`
- Modify: `packages/server/src/server-state/index.ts:182-190` and the `assembleServerState` call (~line 268)
- Modify: `packages/server/src/dashboard-routes/provider-routes.ts`
- Test: `packages/server/__tests__/dashboard-provider-quota.test.ts`

**Interfaces:**
- Consumes: `createOAuthQuotaCache` / `OAuthQuotaCache` (Task 3).
- Produces: `ServerState.quotaCache: OAuthQuotaCache`, and the route whose typed RPC handle is `client.dashboard.api.providers[':id'].quota.$query({ param: { id }, json: { refresh } })`, returning `{ snapshot, sampledAt, stale, error? }` on 200, `{ error: string }` on 404/502. Task 11 consumes the RPC type.

- [ ] **Step 1: Write the failing test**

Create `packages/server/__tests__/dashboard-provider-quota.test.ts`. Model the harness on the existing `packages/server/__tests__/dashboard-providers-mutation-basic.test.ts` for booting a server with a config; the assertions that matter are:

```ts
import { expect, test } from 'bun:test';

import { Hono } from 'hono';
import { etag } from 'hono/etag';

import { createDashboardProviderReadRoutes } from '../src/dashboard-routes/provider-routes';
import type { ServerState } from '../src/server-state';

const snapshot = { items: [{ id: 'weekly', displayName: 'Weekly', remainingRatio: 0.5 }] };

function routesWith(quotaCache: Partial<ServerState['quotaCache']>) {
  const state = {
    quotaCache: { read: async () => ({ snapshot, sampledAt: 1_700_000_000_000, stale: false }), warm: () => {}, ...quotaCache },
    providerSummaries: async () => [],
    currentConfig: () => ({ providers: [] }),
  } as unknown as ServerState;
  return new Hono().route('/', createDashboardProviderReadRoutes(state));
}

const query = (app: Hono, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/providers/kimi/quota', {
    method: 'QUERY',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('returns the cached snapshot with its sample time', async () => {
  const response = await query(routesWith({}), {});
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ snapshot, sampledAt: 1_700_000_000_000, stale: false });
});

test('forwards an explicit refresh to the cache', async () => {
  const seen: boolean[] = [];
  const app = routesWith({
    read: async (_id, _signal, refresh) => {
      seen.push(refresh === true);
      return { snapshot, sampledAt: 1, stale: false };
    },
  });
  await query(app, { refresh: true });
  await query(app, {});
  expect(seen).toEqual([true, false]);
});

test('answers a matching if-none-match with 304', async () => {
  const app = routesWith({});
  const tag = (await query(app, {})).headers.get('etag');
  expect(tag).not.toBeNull();
  const revalidated = await query(app, {}, { 'if-none-match': tag as string });
  expect(revalidated.status).toBe(304);
});

test('reports an unreadable quota as 502 rather than an empty snapshot', async () => {
  const app = routesWith({
    read: async () => {
      throw new Error('OAUTH_QUOTA_READ_FAILED');
    },
  });
  const response = await query(app, {});
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: 'OAUTH_QUOTA_READ_FAILED' });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts __tests__/dashboard-provider-quota.test.ts
```

Expected: FAIL — 404, because the route does not exist.

- [ ] **Step 3: Write minimal implementation**

`packages/server/src/server-state/types.ts` — add to `ServerState`:

```ts
  readonly quotaCache: OAuthQuotaCache;
```

with `import type { OAuthQuotaCache, OAuthQuotaOperations } from '../plugin-quota';` (extend the existing import).

`packages/server/src/server-state/index.ts` — right after the existing `const oauthQuota = createOAuthQuotaOperations({...})` block:

```ts
  const quotaCache = createOAuthQuotaCache(oauthQuota);
```

and add `quotaCache,` to the object passed to `assembleServerState(runtime, { ... })` alongside `oauthQuota`. Extend the existing `plugin-quota` import with `createOAuthQuotaCache`.

`packages/server/src/dashboard-routes/provider-routes.ts` — extend the chain. Add imports:

```ts
import { etag } from 'hono/etag';
```

and append to the returned chain, **before** the `'/providers/:id'` GET (Hono matches in registration order and `:id` would otherwise be fine, but keeping the more specific path first mirrors `package-status`):

```ts
    .use('/providers/:id/quota', etag())
    .query('/providers/:id/quota', async (context) => {
      const body: unknown = await context.req.json().catch(() => ({}));
      const refresh = isPlainObject(body) && body['refresh'] === true;
      try {
        const entry = await state.quotaCache.read(context.req.param('id'), AbortSignal.any([context.req.raw.signal]), refresh);
        return context.json({
          snapshot: entry.snapshot,
          sampledAt: entry.sampledAt,
          stale: entry.stale,
          ...(entry.error === undefined ? {} : { error: entry.error }),
        });
      } catch (error) {
        // The cache only throws when it has no snapshot at all: an unsupported provider, a missing
        // account, or a first read that failed. All are upstream problems, not client mistakes.
        return context.json({ error: error instanceof Error ? error.message : 'OAUTH_QUOTA_READ_FAILED' }, 502);
      }
    })
```

with `import { isPlainObject } from 'es-toolkit/predicate';` at the top.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts __tests__/dashboard-provider-quota.test.ts
```

Expected: PASS, including the 304.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server-state packages/server/src/dashboard-routes/provider-routes.ts packages/server/__tests__/dashboard-provider-quota.test.ts
git commit -m "feat(server): add a cached QUERY route for OAuth provider quota" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Warm the quota cache from the request pipeline

**Files:**
- Modify: `packages/server/src/runtime.ts:149-158`
- Modify: `packages/server/src/routes/pipeline/attempt/attempt.ts:1-30,210-232`
- Modify: `packages/server/src/server-state/index.ts`
- Test: `packages/server/src/routes/pipeline/attempt/attempt.quota-warm.test.ts`

**Interfaces:**
- Consumes: `OAuthQuotaCache.warm` (Task 3).
- Produces: `ProviderRouteSource.warmProviderQuota?: (providerId: string) => void`. Optional on purpose — the single `satisfies ProviderRouteSource` literal at `packages/server/__tests__/pipeline-helpers/providers.ts:162-176` then needs no edit.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/routes/pipeline/attempt/attempt.quota-warm.test.ts`. The existing harness
(`defineProviderRouteSource` in `packages/server/__tests__/pipeline-helpers/providers.ts`) returns a
`{ logs, recording, source, usage }` object, and `handleProtocolRequest` takes `source` as a plain
value — so the callback goes on by spreading the returned source. `modelProvider` builds an
`AiSdk`-kind fixture; `oauth.test.ts:114` shows the one-line override that turns a fixture into an
OAuth account, repeated here because this file must stand alone:

```ts
import { expect, test } from 'bun:test';

import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import {
  createProtocolContext,
  defineProtocolAdapter,
  defineProviderRouteSource,
  type FakeProvider,
  jsonRequest,
  modelProvider,
  REQUESTED_MODEL,
  textStream,
} from '../../../../__tests__/pipeline-helpers';
import { handleProtocolRequest } from '../index';

const asOAuth = (fixture: FakeProvider): FakeProvider => ({
  ...fixture,
  provider: { ...fixture.provider, capability: 'default', kind: ProviderKind.OAuth, plugin: '@aio-proxy/plugin-kimi-code' },
});

const runWith = async (fixture: FakeProvider, warmed: string[]) => {
  const adapter = defineProtocolAdapter(ProviderProtocol.OpenAICompatible);
  const route = defineProviderRouteSource([fixture]);
  const response = await handleProtocolRequest({
    adapter,
    context: createProtocolContext(),
    rawRequest: jsonRequest({ model: REQUESTED_MODEL }),
    source: { ...route.source, warmProviderQuota: (providerId: string) => warmed.push(providerId) },
  });
  expect(response.status).toBe(200);
};

test('a successful attempt warms that OAuth provider quota exactly once', async () => {
  const warmed: string[] = [];
  await runWith(asOAuth(modelProvider({ id: 'kimi', invoke: () => textStream('ok') })), warmed);

  expect(warmed).toEqual(['kimi']);
});

test('a non-OAuth provider is never warmed', async () => {
  const warmed: string[] = [];
  await runWith(modelProvider({ id: 'plain', invoke: () => textStream('ok') }), warmed);

  expect(warmed).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/pipeline/attempt/attempt.quota-warm.test.ts
```

Expected: FAIL — `warmed` is empty.

- [ ] **Step 3: Write minimal implementation**

`packages/server/src/runtime.ts` — add to `ProviderRouteSource`:

```ts
  readonly usageCapture: UsageCapture;
  /** Optional: fire-and-forget OAuth quota refresh after a provider answers a request. */
  readonly warmProviderQuota?: (providerId: string) => void;
```

`packages/server/src/routes/pipeline/attempt/attempt.ts` — extend the type import:

```ts
import { type Config, ProviderKind } from '@aio-proxy/types';
```

Add a local helper above the loop function:

```ts
// The response is already on its way out; a quota refresh must never delay or fail it.
function warmProviderQuota(source: ProviderRouteSource, provider: RuntimeProviderInstance): void {
  if (provider.kind !== ProviderKind.OAuth) return;
  source.warmProviderQuota?.(provider.id);
}
```

and call it at both return sites inside the candidate loop:

```ts
      if (step.kind === 'return') {
        warmProviderQuota(options.source, provider);
        return step.response;
      }
```

```ts
      const step = handleAttemptError(ctx, slot, error);
      if (step.kind === 'return') {
        warmProviderQuota(options.source, provider);
        return step.response;
      }
```

`packages/server/src/server-state/index.ts` — supply the callback wherever the `ProviderRouteSource` fields are assembled for `assembleServerState` (next to `quotaCache` from Task 4):

```ts
    warmProviderQuota: (providerId: string) => quotaCache.warm(providerId),
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/pipeline
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/runtime.ts packages/server/src/routes/pipeline packages/server/src/server-state packages/server/__tests__/pipeline-helpers
git commit -m "feat(server): warm OAuth quota after a provider answers a request" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: kimi-code reports its membership plan

**Files:**
- Modify: `packages/plugins/kimi-code/src/quota.ts`
- Test: `packages/plugins/kimi-code/src/quota.test.ts`

**Interfaces:**
- Consumes: `OAuthQuotaSnapshot.plan` (Task 1).
- Produces: no new exports; `readKimiQuota` may now return `plan`.

- [ ] **Step 1: Write the failing test**

Append to `packages/plugins/kimi-code/src/quota.test.ts` (reuse whichever fixture/fetch stub helper the file already defines for the happy path; the payload below only adds `user`):

```ts
test('maps the membership level to a plan name', async () => {
  const snapshot = await readWithPayload({
    usage: { limit: 100, remaining: 40 },
    user: { membership: { level: 'LEVEL_ADVANCED' } },
  });
  expect(snapshot.plan).toBe('Allegro');
});

test('falls back to a readable level and omits an unknown shape', async () => {
  expect((await readWithPayload({ usage: { limit: 100, remaining: 40 }, user: { membership: { level: 'LEVEL_FUTURE' } } })).plan).toBe(
    'future',
  );
  expect(await readWithPayload({ usage: { limit: 100, remaining: 40 } })).not.toHaveProperty('plan');
});
```

If the file has no `readWithPayload` helper, add one that wraps the existing stubbed-`fetch` construction already used by the first test and returns `readKimiQuota(context, { fetch })`.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/plugins/kimi-code && bun test --preload=./test/setup.ts src/quota.test.ts
```

Expected: FAIL — `snapshot.plan` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `packages/plugins/kimi-code/src/quota.ts`, add above `readKimiQuota`:

```ts
// Kimi ships tempo-marking tier names in its own UI; the API only returns the enum.
const PLAN_BY_LEVEL: Record<string, string> = {
  LEVEL_BASIC: 'Moderato',
  LEVEL_INTERMEDIATE: 'Allegretto',
  LEVEL_ADVANCED: 'Allegro',
  LEVEL_STANDARD: 'Vivace',
};

function membershipPlan(root: object): string | undefined {
  const user = Reflect.get(root, 'user');
  if (typeof user !== 'object' || user === null) return undefined;
  const membership = Reflect.get(user, 'membership');
  if (typeof membership !== 'object' || membership === null) return undefined;
  const level = Reflect.get(membership, 'level');
  if (typeof level !== 'string' || level.trim() === '') return undefined;
  return PLAN_BY_LEVEL[level] ?? level.replace('LEVEL_', '').toLowerCase();
}
```

and change the final return:

```ts
  const items = [...(weekly === undefined ? [] : [weekly]), ...windows];
  if (items.length === 0) throw new Error('Kimi quota response contains no valid windows');
  const plan = membershipPlan(root);
  return { items, ...(plan === undefined ? {} : { plan }) };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/plugins/kimi-code && bun test --preload=./test/setup.ts src/quota.test.ts
```

Expected: PASS — including the pre-existing assertions that the request URL is exactly `https://api.kimi.com/coding/v1/usages` and never contains `www.kimi.com` (no new request was added).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/kimi-code/src
git commit -m "feat(plugin-kimi-code): report the membership plan on quota snapshots" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: xai-grok plan, weekly-window fix, and per-product usage

**Files:**
- Modify: `packages/plugins/xai-grok/src/quota.ts`
- Test: `packages/plugins/xai-grok/src/quota.test.ts`

**Interfaces:**
- Consumes: `OAuthQuotaSnapshot.plan` (Task 1).
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

`packages/plugins/xai-grok/src/quota.test.ts` currently asserts the exact request list:

```ts
expect(requests.map(({ url }) => url)).toEqual([
  'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
  'https://cli-chat-proxy.grok.com/v1/billing',
]);
```

Update it to include the settings probe, which is issued alongside the two billing calls:

```ts
expect(requests.map(({ url }) => url).toSorted()).toEqual([
  'https://cli-chat-proxy.grok.com/v1/billing',
  'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
  'https://cli-chat-proxy.grok.com/v1/settings',
]);
```

The test's existing per-request loop asserting `method === 'GET'` and the seven headers stays as-is — the settings request uses the same headers, so it passes unchanged. Then append:

```ts
test('reports the subscription tier as the plan', async () => {
  const snapshot = await readWithResponses({
    settings: { subscription_tier_display: 'SuperGrok Heavy' },
  });
  expect(snapshot.plan).toBe('SuperGrok Heavy');
});

test('drops the plan when settings fail without failing the read', async () => {
  const snapshot = await readWithResponses({ settings: new Error('offline') });
  expect(snapshot).not.toHaveProperty('plan');
  expect(snapshot.items.length).toBeGreaterThan(0);
});

test('keeps the weekly window when a unified-billing account reports no usage percent', async () => {
  const snapshot = await readWithResponses({
    weekly: { config: { currentPeriod: { end: '2026-09-08T00:00:00.000Z' } } },
  });
  const weekly = snapshot.items.find((item) => item.id === 'weekly');
  expect(weekly).toBeDefined();
  expect(weekly).not.toHaveProperty('remainingRatio');
  expect(weekly?.resetsAt).toBe(Date.parse('2026-09-08T00:00:00.000Z'));
});

test('maps per-product usage into its own items with normalized ids', async () => {
  const snapshot = await readWithResponses({
    weekly: {
      config: {
        creditUsagePercent: 10,
        currentPeriod: { end: '2026-09-08T00:00:00.000Z' },
        productUsage: [
          { product: 'productgrokbuild', usagePercent: 25 },
          { product: 'Grok Code', usagePercent: 40 },
          { product: 'grokbuild', usagePercent: 60 },
        ],
      },
    },
  });
  const ids = snapshot.items.map((item) => item.id);
  expect(ids).toContain('product_grok_build');
  expect(ids).toContain('product_grok_code');
  expect(ids).toContain('product_grok_build_2');
  const build = snapshot.items.find((item) => item.id === 'product_grok_build');
  expect(build?.remainingRatio).toBeCloseTo(0.75, 5);
  expect(build?.displayName).toBe('Grok Build');
});
```

Add this `readWithResponses` helper next to the file's existing `context()` / `port()` helpers. Each
leg defaults to a valid payload; passing an `Error` makes that leg reject:

```ts
type Leg = Record<string, unknown> | Error;

const DEFAULT_WEEKLY = { config: { currentPeriod: { type: 'weekly', end: '2027-01-15T00:00:00Z' }, creditUsagePercent: '25' } };
const DEFAULT_MONTHLY = { config: { monthlyLimit: { val: '10000' }, used: { val: 2500 }, billingPeriodEnd: '2027-02-01T00:00:00Z' } };
const DEFAULT_SETTINGS = { subscription_tier_display: 'SuperGrok' };

async function readWithResponses(overrides: { weekly?: Leg; monthly?: Leg; settings?: Leg } = {}) {
  const leg = (value: Leg | undefined, fallback: Record<string, unknown>) => {
    if (value instanceof Error) throw value;
    return Response.json(value ?? fallback);
  };
  return readXAIGrokQuota(context(), {
    fetch: async (input) => {
      const url = input.toString();
      if (url.endsWith('/settings')) return leg(overrides.settings, DEFAULT_SETTINGS);
      if (url.endsWith('?format=credits')) return leg(overrides.weekly, DEFAULT_WEEKLY);
      return leg(overrides.monthly, DEFAULT_MONTHLY);
    },
  });
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/plugins/xai-grok && bun test src/quota.test.ts
```

Expected: FAIL — no settings request, no plan, weekly window dropped, no product items.

- [ ] **Step 3: Write minimal implementation**

`packages/plugins/xai-grok/src/quota.ts`:

```ts
const WEEKLY_BILLING_URL = `${XAI_GROK_CLI_BASE_URL}/billing?format=credits`;
const MONTHLY_BILLING_URL = `${XAI_GROK_CLI_BASE_URL}/billing`;
const SETTINGS_URL = `${XAI_GROK_CLI_BASE_URL}/settings`;
const SETTINGS_TIMEOUT_MS = 2_000;
```

Widen `BillingObject` with `readonly productUsage?: unknown;` and `readonly product_usage?: unknown;`.

Rewrite the body of `readXAIGrokQuota`:

```ts
  const results = await Promise.allSettled([
    requestBilling(fetcher, WEEKLY_BILLING_URL, headers, context.signal, weeklyItems),
    requestBilling(fetcher, MONTHLY_BILLING_URL, headers, context.signal, monthlyItems),
    readPlan(fetcher, headers, context.signal),
  ]);
  context.signal.throwIfAborted();
  const [weekly, monthly, planResult] = results;
  const items = dedupeItemIds([
    ...(weekly.status === 'fulfilled' ? (weekly.value as OAuthQuotaItem[]) : []),
    ...(monthly.status === 'fulfilled' ? (monthly.value as OAuthQuotaItem[]) : []),
  ]);
  if (items.length === 0) throw new Error('xAI Grok billing request failed');
  const plan = planResult.status === 'fulfilled' ? (planResult.value as string | undefined) : undefined;
  return { items, ...(plan === undefined ? {} : { plan }) };
```

Change `requestBilling`'s `toItem` parameter to `toItems: (config: BillingObject) => readonly OAuthQuotaItem[]` and its return to `Promise<readonly OAuthQuotaItem[]>`, with `return payload === undefined ? [] : toItems(record(payload.config) ?? {});`.

Replace `weeklyItem` / `monthlyItem` with list-returning versions. The weekly one loses the "no ratio and no reset → drop" rule (that is the unified-billing bug) and emits the per-product items:

```ts
function weeklyItems(config: BillingObject): readonly OAuthQuotaItem[] {
  const period = record(config.currentPeriod ?? config.current_period);
  const remainingRatio = remainingFromPercent(config.creditUsagePercent ?? config.credit_usage_percent);
  const resetsAt = timestamp(period?.end);
  // A unified-billing account reports a period but no credit percentage. Emitting the window with no
  // ratio is what makes the dashboard show 暂不适用 instead of hiding the weekly limit entirely.
  const weekly: readonly OAuthQuotaItem[] =
    remainingRatio === undefined && resetsAt === undefined
      ? []
      : [
          {
            id: 'weekly',
            displayName: { default: 'Weekly limit', 'zh-Hans': '周额度' },
            ...(remainingRatio === undefined ? {} : { remainingRatio }),
            ...(resetsAt === undefined ? {} : { resetsAt }),
          },
        ];
  return [...weekly, ...productItems(config)];
}

function monthlyItems(config: BillingObject): readonly OAuthQuotaItem[] {
  const limit = cents(config.monthlyLimit ?? config.monthly_limit);
  const used = cents(config.used);
  const remainingRatio =
    limit === undefined || limit <= 0 || used === undefined ? undefined : 1 - Math.min(Math.max(used, 0), limit) / limit;
  const resetsAt = timestamp(config.billingPeriodEnd ?? config.billing_period_end);
  if (remainingRatio === undefined && resetsAt === undefined) return [];
  return [
    {
      id: 'monthly-credits',
      displayName: { default: 'Monthly credits', 'zh-Hans': '月度额度' },
      ...(remainingRatio === undefined ? {} : { remainingRatio }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    },
  ];
}
```

Add the product mapping and the id de-duplication:

```ts
// xAI spells the same product three ways across payloads; collapse them so the dashboard shows one row.
const PRODUCT_ALIASES: Record<string, string> = { grokbuild: 'grok_build', productgrokbuild: 'grok_build' };

function productSlug(product: string): string {
  const normalized = product.trim().toLowerCase().replaceAll(/[^a-z0-9]+/gu, '_').replaceAll(/^_+|_+$/gu, '');
  return PRODUCT_ALIASES[normalized] ?? normalized;
}

function productTitle(slug: string): string {
  return slug
    .split('_')
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function productItems(config: BillingObject): readonly OAuthQuotaItem[] {
  const raw = config.productUsage ?? config.product_usage;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): OAuthQuotaItem[] => {
    const usage = record(entry);
    const product = usage === undefined ? undefined : Reflect.get(usage, 'product');
    if (typeof product !== 'string') return [];
    const slug = productSlug(product);
    if (slug === '') return [];
    const percent = number(Reflect.get(usage as object, 'usagePercent') ?? Reflect.get(usage as object, 'usage_percent'));
    return [
      {
        id: `product_${slug}`,
        displayName: productTitle(slug),
        ...(percent === undefined ? {} : { remainingRatio: 1 - Math.min(Math.max(percent, 0), 100) / 100 }),
      },
    ];
  });
}

// The core validator rejects duplicate item ids outright, so two spellings of one product must not
// both survive as `product_grok_build`.
function dedupeItemIds(items: readonly OAuthQuotaItem[]): readonly OAuthQuotaItem[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const count = (seen.get(item.id) ?? 0) + 1;
    seen.set(item.id, count);
    return count === 1 ? item : { ...item, id: `${item.id}_${count}` };
  });
}
```

Add the plan probe:

```ts
async function readPlan(
  fetcher: NonNullable<XAIGrokOAuthOptions['fetch']>,
  headers: Headers,
  signal: AbortSignal,
): Promise<string | undefined> {
  // Optional enrichment: a slow or missing /settings must never fail the quota read.
  const response = await fetcher(SETTINGS_URL, {
    method: 'GET',
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(SETTINGS_TIMEOUT_MS)]),
  });
  if (!response.ok) return undefined;
  const payload = record(await response.json());
  const tier = payload === undefined ? undefined : Reflect.get(payload, 'subscription_tier_display');
  return typeof tier === 'string' && tier.trim() !== '' ? tier : undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/plugins/xai-grok && bun test
```

Expected: PASS, including the pre-existing `keeps valid monthly quota when weekly billing fails` and the `'xAI Grok billing request failed'` throw.

- [ ] **Step 5: Check the file length**

`packages/plugins/xai-grok/src/quota.ts` must stay under 400 lines. If it crosses, split into `quota/index.ts` (exports only), `quota/quota.ts` (`readXAIGrokQuota`, `requestBilling`, `readPlan`), and `quota/billing-items.ts` (`weeklyItems`, `monthlyItems`, `productItems`, `dedupeItemIds`, the parsing helpers), moving `quota.test.ts` alongside.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/xai-grok/src
git commit -m "feat(plugin-xai-grok): report the plan, per-product usage, and unified-billing weekly limits" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Land the shadcn `dialog` primitive

**Files:**
- Modify: `packages/ui/src/components/dialog.tsx` (already generated on disk, untracked)

**Interfaces:**
- Consumes: nothing.
- Produces: `Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle, DialogTrigger` from `@aio-proxy/ui/components/dialog`. Task 13 imports them.

- [ ] **Step 1: Confirm the file is CLI-generated, not hand-written**

```bash
git status --short packages/ui/src/components/dialog.tsx
```

Expected: `?? packages/ui/src/components/dialog.tsx`. If it is missing, regenerate it — never hand-write it:

```bash
cd packages/ui && bun x --bun --no-install shadcn add dialog --overwrite
```

- [ ] **Step 2: Verify it fails the format check**

```bash
bun run format:check
```

Expected: FAIL naming `packages/ui/src/components/dialog.tsx` (the generator emits double quotes and no semicolons).

- [ ] **Step 3: Format it**

```bash
bun run format
```

`oxfmt` is the only bulk touch for this directory. Do not add `'use client'`, do not rename exports, do not restyle.

- [ ] **Step 4: Let the caller supply the close label**

The generated close button hardcodes `<span className="sr-only">Close</span>`, and `packages/ui` has no `@aio-proxy/i18n` dependency by design. Add one prop so the localized copy comes from the caller (Task 13 passes `m['common.close']()`):

```tsx
function DialogContent({
  className,
  children,
  showCloseButton = true,
  closeLabel = "Close",
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
  // The close button's only accessible name. Localized copy lives outside this
  // package, so the caller supplies it; the default keeps the primitive usable.
  closeLabel?: React.ReactNode
}) {
```

and replace the hardcoded label with `<span className="sr-only">{closeLabel}</span>`.

- [ ] **Step 5: Verify**

```bash
bun run format:check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/dialog.tsx
git commit -m "chore(ui): add the shadcn dialog primitive" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Card and quota copy

**Files:**
- Modify: `packages/i18n/messages/en.json`, `ja.json`, `ko.json`, `zh-Hans.json`, `zh-Hant.json`

**Interfaces:**
- Consumes: nothing.
- Produces: the message keys below, called as `m['dashboard.providers.card.<key>']()` / `m['dashboard.providers.quota.<key>']()`. Tasks 12–14 use them.

- [ ] **Step 1: Add the `card` and `quota` groups to `en.json`**

Under `dashboard.providers`, add two sibling objects (keep the existing keys untouched):

```json
    "card": {
      "search_placeholder": "Search by name or Provider ID",
      "filter_availability": "Availability",
      "filter_availability_all": "All",
      "filter_availability_available": "Available",
      "filter_availability_unavailable": "Unavailable",
      "filter_enablement": "State",
      "filter_enablement_all": "All",
      "filter_enablement_enabled": "Enabled",
      "filter_enablement_disabled": "Disabled",
      "filter_kind": "Kind",
      "filter_kind_all": "All",
      "no_matches": "No Providers match these filters",
      "stat_priority": "Priority",
      "stat_weight": "Weight",
      "stat_success_rate": "Success rate",
      "stat_p95": "P95",
      "models_count": "{count} models",
      "requests_24h": "{count} / 24h",
      "invalid_hint": "Invalid Provider configuration.",
      "open_provider": "Open Provider {id}"
    },
    "quota": {
      "ring_label": "Remaining quota for Provider {id}",
      "title": "Remaining quota",
      "refresh": "Refresh quota",
      "sampled_at": "Sampled {value}",
      "remaining": "{percent}% remaining",
      "less_than_one_percent": "Less than 1% remaining",
      "not_applicable": "Not applicable",
      "not_applicable_hint": "This upstream reports no remaining amount for this window",
      "resets_at": "Resets {value}",
      "reset_credits": "{count} reset credits available",
      "stale_notice": "Showing the last successful reading; the latest refresh failed",
      "load_failed": "Quota is unavailable for this Provider",
      "loading": "Loading quota"
    },
```

- [ ] **Step 2: Mirror the keys into the other four locales**

`zh-Hans.json`:

```json
    "card": {
      "search_placeholder": "按名称或提供商 ID 搜索",
      "filter_availability": "可用性",
      "filter_availability_all": "全部",
      "filter_availability_available": "可用",
      "filter_availability_unavailable": "异常",
      "filter_enablement": "状态",
      "filter_enablement_all": "全部",
      "filter_enablement_enabled": "已启用",
      "filter_enablement_disabled": "已禁用",
      "filter_kind": "类型",
      "filter_kind_all": "全部",
      "no_matches": "没有符合筛选条件的提供商",
      "stat_priority": "优先级",
      "stat_weight": "权重",
      "stat_success_rate": "成功率",
      "stat_p95": "P95",
      "models_count": "{count} 模型",
      "requests_24h": "{count} 次 / 24h",
      "invalid_hint": "提供商配置无效。",
      "open_provider": "打开提供商 {id}"
    },
    "quota": {
      "ring_label": "提供商 {id} 的剩余额度",
      "title": "剩余额度",
      "refresh": "刷新额度",
      "sampled_at": "采样于 {value}",
      "remaining": "剩余 {percent}%",
      "less_than_one_percent": "剩余 <1%",
      "not_applicable": "暂不适用",
      "not_applicable_hint": "该上游未提供此窗口的剩余额度",
      "resets_at": "{value} 重置",
      "reset_credits": "可用重置次数 {count}",
      "stale_notice": "显示上一次成功获取的数据，最近一次刷新失败",
      "load_failed": "无法获取该提供商的额度",
      "loading": "正在加载额度"
    },
```

Translate the same key set into `zh-Hant.json`, `ja.json`, and `ko.json` following the tone of the surrounding entries in each file. Every locale must contain exactly the same key set — a missing key is a Paraglide compile error.

- [ ] **Step 3: Compile and verify**

```bash
bun run i18n:compile
bun -e "const l=['en','ja','ko','zh-Hans','zh-Hant'].map((n)=>[n,require('./packages/i18n/messages/'+n+'.json').dashboard.providers]); const ref=Object.keys(l[0][1].card).concat(Object.keys(l[0][1].quota)).sort(); for (const [n,p] of l) { const got=Object.keys(p.card??{}).concat(Object.keys(p.quota??{})).sort(); if (JSON.stringify(got)!==JSON.stringify(ref)) throw new Error(n+' key mismatch'); } console.log('locales aligned');"
```

Expected: `locales aligned`.

- [ ] **Step 4: Commit**

```bash
git add packages/i18n/messages
git commit -m "feat(i18n): add Provider card and quota copy" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Pure list and quota view logic

**Files:**
- Create: `packages/dashboard/src/modules/providers/lib/provider-list-view/{index.ts,provider-list-view.ts,provider-list-view.test.ts}`
- Create: `packages/dashboard/src/modules/providers/lib/quota-view/{index.ts,quota-view.ts,quota-view.test.ts}`

**Interfaces:**
- Consumes: `DashboardProviderSummary` with `protocols`/`hasQuota` (Task 2), `OAuthQuotaSnapshot` (Task 1).
- Produces:
  ```ts
  // provider-list-view
  export type ProviderAvailabilityFilter = 'all' | 'available' | 'unavailable';
  export type ProviderEnablementFilter = 'all' | 'enabled' | 'disabled';
  export type ProviderKindFilter = 'all' | 'oauth' | 'api' | 'ai-sdk';
  export interface ProviderListFilters {
    readonly search: string;
    readonly availability: ProviderAvailabilityFilter;
    readonly enablement: ProviderEnablementFilter;
    readonly kind: ProviderKindFilter;
  }
  export const emptyProviderListFilters: ProviderListFilters;
  export const providerDisplayName: (provider: DashboardProviderSummary) => string;
  export const canEditProvider: (provider: DashboardProviderSummary) => boolean;
  export const visibleProviders: (
    providers: readonly DashboardProviderSummary[],
    filters: ProviderListFilters,
  ) => readonly DashboardProviderSummary[];

  // quota-view
  export const tightestQuotaItem: (snapshot: OAuthQuotaSnapshot | undefined) => OAuthQuotaItem | undefined;
  export const remainingPercent: (ratio: number) => number;
  ```
  Tasks 12–14 consume all of them.

- [ ] **Step 1: Write the failing tests**

Create `packages/dashboard/src/modules/providers/lib/provider-list-view/provider-list-view.test.ts`:

```ts
import { ProviderKind } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';

import { providerStub } from '../provider-fixtures';
import {
  canEditProvider,
  emptyProviderListFilters,
  providerDisplayName,
  visibleProviders,
} from './provider-list-view';

test('prefers the configured name, then the account label, then the Provider ID', () => {
  expect(providerDisplayName(providerStub({ id: 'kimi', name: 'Kimi', accountLabel: 'a@b.com' }))).toBe('Kimi');
  expect(providerDisplayName(providerStub({ id: 'kimi', accountLabel: 'a@b.com' }))).toBe('a@b.com');
  expect(providerDisplayName(providerStub({ id: 'kimi' }))).toBe('kimi');
});

test('a configuration-invalid Provider is not editable', () => {
  expect(canEditProvider(providerStub({ kind: 'invalid' }))).toBe(false);
  expect(
    canEditProvider(
      providerStub({
        state: { status: 'unavailable', diagnostic: { code: 'PROVIDER_CONFIG_INVALID', summary: 'bad', retryable: false, occurredAt: '2026-09-01T00:00:00.000Z' } },
      }),
    ),
  ).toBe(false);
  expect(
    canEditProvider(
      providerStub({
        state: { status: 'unavailable', diagnostic: { code: 'CREDENTIALS_MISSING_OR_INVALID', summary: 'x', retryable: false, occurredAt: '2026-09-01T00:00:00.000Z' } },
      }),
    ),
  ).toBe(true);
});

test('search matches the display name and the Provider ID, case-insensitively', () => {
  const providers = [providerStub({ id: 'alpha-one', name: 'Carpool' }), providerStub({ id: 'beta', name: 'Zebra' })];
  expect(visibleProviders(providers, { ...emptyProviderListFilters, search: 'CARPO' }).map((p) => p.id)).toEqual([
    'alpha-one',
  ]);
  expect(visibleProviders(providers, { ...emptyProviderListFilters, search: 'BETA' }).map((p) => p.id)).toEqual(['beta']);
});

test('chips narrow by availability, enablement, and kind', () => {
  const providers = [
    providerStub({ id: 'ok', kind: ProviderKind.OAuth, enabled: true }),
    providerStub({ id: 'off', kind: ProviderKind.Api, enabled: false }),
    providerStub({
      id: 'broken',
      kind: ProviderKind.Api,
      state: { status: 'unavailable', diagnostic: { code: 'CATALOG_UNAVAILABLE', summary: 'x', retryable: true, occurredAt: '2026-09-01T00:00:00.000Z' } },
    }),
  ];
  const ids = (filters: Partial<typeof emptyProviderListFilters>) =>
    visibleProviders(providers, { ...emptyProviderListFilters, ...filters }).map((p) => p.id);

  expect(ids({ availability: 'unavailable' })).toEqual(['broken']);
  expect(ids({ enablement: 'disabled' })).toEqual(['off']);
  expect(ids({ kind: 'oauth' })).toEqual(['ok']);
});

test('sorts by priority descending, then weight descending, then Provider ID', () => {
  const providers = [
    providerStub({ id: 'c', priority: 1, weight: 5 }),
    providerStub({ id: 'a', priority: 10, weight: 1 }),
    providerStub({ id: 'b', priority: 10, weight: 9 }),
    providerStub({ id: 'd' }),
  ];
  expect(visibleProviders(providers, emptyProviderListFilters).map((p) => p.id)).toEqual(['b', 'a', 'c', 'd']);
});
```

Create `packages/dashboard/src/modules/providers/lib/quota-view/quota-view.test.ts`:

```ts
import { expect, test } from '@rstest/core';

import { remainingPercent, tightestQuotaItem } from './quota-view';

test('picks the item with the lowest remaining ratio', () => {
  const snapshot = {
    items: [
      { id: 'weekly', displayName: 'Weekly', remainingRatio: 0.8 },
      { id: 'five-hour', displayName: 'Five hour', remainingRatio: 0.1 },
    ],
  };
  expect(tightestQuotaItem(snapshot)?.id).toBe('five-hour');
});

test('an item without a ratio never wins and an all-unrated snapshot has no tightest item', () => {
  expect(
    tightestQuotaItem({
      items: [
        { id: 'unrated', displayName: 'Unrated' },
        { id: 'weekly', displayName: 'Weekly', remainingRatio: 0.9 },
      ],
    })?.id,
  ).toBe('weekly');
  expect(tightestQuotaItem({ items: [{ id: 'unrated', displayName: 'Unrated' }] })).toBeUndefined();
  expect(tightestQuotaItem(undefined)).toBeUndefined();
});

test('rounds toward the nearest percent but never rounds a non-empty quota to zero', () => {
  expect(remainingPercent(0.5)).toBe(50);
  expect(remainingPercent(0.004)).toBe(1);
  expect(remainingPercent(0)).toBe(0);
  expect(remainingPercent(1)).toBe(100);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/dashboard && bun run test:unit -- provider-list-view quota-view
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/dashboard/src/modules/providers/lib/provider-list-view/provider-list-view.ts`:

```ts
import type { DashboardProviderSummary } from '@aio-proxy/types';

export type ProviderAvailabilityFilter = 'all' | 'available' | 'unavailable';
export type ProviderEnablementFilter = 'all' | 'enabled' | 'disabled';
export type ProviderKindFilter = 'all' | 'oauth' | 'api' | 'ai-sdk';

export interface ProviderListFilters {
  readonly search: string;
  readonly availability: ProviderAvailabilityFilter;
  readonly enablement: ProviderEnablementFilter;
  readonly kind: ProviderKindFilter;
}

export const emptyProviderListFilters: ProviderListFilters = {
  search: '',
  availability: 'all',
  enablement: 'all',
  kind: 'all',
};

// A Provider the editor cannot represent must not offer an edit affordance at all.
const uneditableDiagnosticCodes = new Set(['PROVIDER_CONFIG_INVALID', 'LEGACY_OAUTH_CONFIG_UNSUPPORTED']);

export const canEditProvider = (provider: DashboardProviderSummary): boolean =>
  provider.kind !== 'invalid' &&
  (provider.state.diagnostic === undefined || !uneditableDiagnosticCodes.has(provider.state.diagnostic.code));

/**
 * The configured name wins; an OAuth account that was never named falls back to its account label
 * (an email in practice). The Provider ID is the last resort and is otherwise only a hover title.
 */
export const providerDisplayName = (provider: DashboardProviderSummary): string =>
  provider.name ?? provider.accountLabel ?? provider.id;

// Absent values coalesce to the schema defaults so a card without explicit routing sorts predictably.
const effectivePriority = (provider: DashboardProviderSummary): number => provider.priority ?? 0;
const effectiveWeight = (provider: DashboardProviderSummary): number => provider.weight ?? 1;

const matchesSearch = (provider: DashboardProviderSummary, search: string): boolean => {
  const needle = search.trim().toLowerCase();
  if (needle === '') return true;
  return (
    providerDisplayName(provider).toLowerCase().includes(needle) || provider.id.toLowerCase().includes(needle)
  );
};

const matchesAvailability = (provider: DashboardProviderSummary, filter: ProviderAvailabilityFilter): boolean =>
  filter === 'all' || (filter === 'unavailable') === (provider.state.status === 'unavailable');

const matchesEnablement = (provider: DashboardProviderSummary, filter: ProviderEnablementFilter): boolean =>
  filter === 'all' || (filter === 'enabled') === provider.enabled;

const matchesKind = (provider: DashboardProviderSummary, filter: ProviderKindFilter): boolean =>
  filter === 'all' || provider.kind === filter;

export const visibleProviders = (
  providers: readonly DashboardProviderSummary[],
  filters: ProviderListFilters,
): readonly DashboardProviderSummary[] =>
  providers
    .filter(
      (provider) =>
        matchesSearch(provider, filters.search) &&
        matchesAvailability(provider, filters.availability) &&
        matchesEnablement(provider, filters.enablement) &&
        matchesKind(provider, filters.kind),
    )
    // `filter` already produced a fresh array, so sorting in place mutates nothing the caller owns.
    // `toSorted` is not in this package's TypeScript lib target.
    .sort(
      (left, right) =>
        effectivePriority(right) - effectivePriority(left) ||
        effectiveWeight(right) - effectiveWeight(left) ||
        left.id.localeCompare(right.id),
    );
```

Create `packages/dashboard/src/modules/providers/lib/provider-list-view/index.ts`:

```ts
export * from './provider-list-view';
```

Create `packages/dashboard/src/modules/providers/lib/quota-view/quota-view.ts`:

```ts
import type { OAuthQuotaItem, OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';

/** The ring shows the window closest to running out. An item with no ratio can never be "tightest". */
export const tightestQuotaItem = (snapshot: OAuthQuotaSnapshot | undefined): OAuthQuotaItem | undefined =>
  snapshot?.items.reduce<OAuthQuotaItem | undefined>((tightest, item) => {
    if (item.remainingRatio === undefined) return tightest;
    if (tightest?.remainingRatio === undefined) return item;
    return item.remainingRatio < tightest.remainingRatio ? item : tightest;
  }, undefined);

/**
 * Rounds for display. A quota with anything left never reads as 0%: seeing "0%" next to a working
 * Provider is the one number a user would act on incorrectly.
 */
export const remainingPercent = (ratio: number): number => {
  const clamped = Math.min(Math.max(ratio, 0), 1);
  if (clamped === 0) return 0;
  return Math.max(1, Math.round(clamped * 100));
};
```

Create `packages/dashboard/src/modules/providers/lib/quota-view/index.ts`:

```ts
export * from './quota-view';
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/dashboard && bun run test:unit -- provider-list-view quota-view
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/modules/providers/lib
git commit -m "feat(dashboard): add pure Provider list and quota view helpers" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Provider health and quota services

**Files:**
- Modify: `packages/dashboard/src/lib/query-keys.ts`
- Create: `packages/dashboard/src/modules/providers/services/provider-health-service/{index.ts,provider-health-service.ts}`
- Create: `packages/dashboard/src/modules/providers/services/provider-quota-service/{index.ts,provider-quota-service.ts}`
- Create: `packages/dashboard/src/modules/providers/hooks/use-provider-quota-refresh.ts`

**Interfaces:**
- Consumes: the `QUERY` route from Task 4, `dashboardClient` from `@/lib/dashboard-client`.
- Produces:
  ```ts
  export type ProviderHealth = { readonly successRate: number; readonly p95LatencyMs: number };
  export const providerHealthQueryOptions: () => /* TanStack queryOptions yielding ReadonlyMap<string, ProviderHealth> */;

  // Derived from the route, never redeclared — `packages/dashboard/CLAUDE.md`: "Dashboard API route
  // and client types must come from the typed Hono client exported by `@aio-proxy/server`."
  export type ProviderQuotaResult = InferResponseType<
    (typeof dashboardClient.dashboard.api.providers)[':id']['quota']['$query'],
    200
  >;
  export const getProviderQuota: (id: string, refresh: boolean) => Promise<ProviderQuotaResult>;
  export const providerQuotaQueryOptions: (id: string) => /* queryOptions yielding ProviderQuotaResult */;
  export const useProviderQuotaRefresh: (id: string) => UseMutationResult<ProviderQuotaResult, Error, void>;
  ```
  Tasks 12–14 consume all of them.

**Why a providers-owned health service:** `overviewDiagnosticsQueryOptions` lives in `modules/overview/services/`, and `packages/dashboard/AGENTS.md` forbids a `@/modules/overview/...` import from inside `modules/providers/`. This service calls the same endpoint with a distinct query key and a provider-shaped result.

- [ ] **Step 1: Register the query keys**

`packages/dashboard/src/lib/query-keys.ts` — insert alphabetically:

```ts
  providerEditView: (id: string) => ['providers', id, 'edit-view'],
  // Distinct from `overviewDiagnostics`: same endpoint, different decoded shape, so it must not
  // share a cache entry with the overview module's query.
  providerHealth: ['dashboard', 'providers', 'health'],
  providerPackageStatus: (packageName: string) => ['providers', 'package-status', packageName],
  providerProbe: (id: string) => ['providers', id, 'probe'],
  providerQuota: (id: string) => ['providers', id, 'quota'],
  providerUsage: ['dashboard', 'providers', 'usage'],
```

- [ ] **Step 2: Write the health service**

Create `packages/dashboard/src/modules/providers/services/provider-health-service/provider-health-service.ts`:

```ts
import { queryOptions } from '@tanstack/react-query';

import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

export type ProviderHealth = {
  readonly successRate: number;
  readonly p95LatencyMs: number;
};

class DashboardProviderHealthRequestError extends Error {
  constructor(readonly status: number) {
    super(`Dashboard provider health request failed with status ${status}`);
    this.name = 'DashboardProviderHealthRequestError';
  }
}

export const getProviderHealth = async (): Promise<ReadonlyMap<string, ProviderHealth>> => {
  const response = await dashboardClient.dashboard.api.overview.diagnostics.$get({ query: { range: '24h' } });
  if (!response.ok) throw new DashboardProviderHealthRequestError(response.status);
  const { providerHealth } = await response.json();
  return new Map(
    (providerHealth ?? []).map((entry) => [
      entry.providerId,
      { successRate: entry.successRate, p95LatencyMs: entry.p95LatencyMs },
    ]),
  );
};

export const providerHealthQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.providerHealth,
    queryFn: getProviderHealth,
    staleTime: 60_000,
  });
```

Create `index.ts`:

```ts
export { getProviderHealth, type ProviderHealth, providerHealthQueryOptions } from './provider-health-service';
```

- [ ] **Step 3: Write the quota service**

Create `packages/dashboard/src/modules/providers/services/provider-quota-service/provider-quota-service.ts`:

```ts
import { queryOptions } from '@tanstack/react-query';
import type { InferResponseType } from 'hono/client';

import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

const quotaEndpoint = dashboardClient.dashboard.api.providers[':id'].quota.$query;

export type ProviderQuotaResult = InferResponseType<typeof quotaEndpoint, 200>;

class DashboardProviderQuotaRequestError extends Error {
  constructor(readonly status: number) {
    super(`Dashboard provider quota request failed with status ${status}`);
    this.name = 'DashboardProviderQuotaRequestError';
  }
}

export const getProviderQuota = async (id: string, refresh: boolean): Promise<ProviderQuotaResult> => {
  const response = await quotaEndpoint({ param: { id }, json: { refresh } });
  if (!response.ok) throw new DashboardProviderQuotaRequestError(response.status);
  return await response.json();
};

/**
 * The passive read. `refresh` is deliberately absent from both the key and the function: the card and
 * the modal share one cache entry, and a passive render must never bypass the server's cooldown.
 * Explicit refreshes go through `useProviderQuotaRefresh`.
 */
export const providerQuotaQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.providerQuota(id),
    queryFn: () => getProviderQuota(id, false),
    staleTime: 30_000,
    retry: false,
  });
```

Create `provider-quota-service/index.ts`:

```ts
export { getProviderQuota, type ProviderQuotaResult, providerQuotaQueryOptions } from './provider-quota-service';
```

- [ ] **Step 4: Write the refresh hook**

`query.refetch()` cannot express a refresh: it re-runs the captured `queryFn`, which is pinned to
`refresh: false`. Opening the modal must bypass the server's five-minute cooldown, so the refresh is a
mutation that writes its result into the same cache entry the ring reads.

Create `packages/dashboard/src/modules/providers/hooks/use-provider-quota-refresh.ts`:

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import { getProviderQuota, type ProviderQuotaResult } from '../services/provider-quota-service';

/**
 * Bypasses the server's per-provider cooldown and seeds the shared cache entry, so the ring and any
 * open dialog both re-render from one reading.
 */
export const useProviderQuotaRefresh = (id: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => getProviderQuota(id, true),
    onSuccess: (result: ProviderQuotaResult) => {
      client.setQueryData(queryKeys.providerQuota(id), result);
    },
  });
};
```

- [ ] **Step 5: Verify the RPC types line up**

```bash
bun run build && bun run lint:types
```

Expected: PASS against the existing 11-error baseline — no *new* errors. If `$query` is not present on the RPC handle, the route in Task 4 was registered with `.on('QUERY', ...)` instead of `.query(...)` — fix Task 4, not this service.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/lib/query-keys.ts packages/dashboard/src/modules/providers/services packages/dashboard/src/modules/providers/hooks
git commit -m "feat(dashboard): add Provider health and quota services" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Provider card

**Files:**
- Modify: `packages/dashboard/src/components/protocol-label/protocol-label.tsx`
- Create: `.../modules/providers/components/provider-protocol-labels/{index.ts,provider-protocol-labels.tsx}`
- Create: `.../modules/providers/components/provider-card/{index.ts,provider-card.tsx,provider-card-identity.tsx,provider-card-stat.tsx,provider-card-stats.tsx,provider-card-footer.tsx,provider-card.test.tsx}`

**Interfaces:**
- Consumes: `providerDisplayName`, `canEditProvider` (Task 10); `ProviderHealth` (Task 11); `ProviderUsage` from `../../services/provider-usage-service`; the surviving `ProviderEnabledSwitch`, `ProviderMoreMenu`, `DiagnosticDetails`; the ring from Task 13.
- Produces:
  ```ts
  interface ProviderCardProps {
    readonly provider: DashboardProviderSummary;
    readonly health: ProviderHealth | undefined;
    readonly usage: ProviderUsage | undefined;
    readonly usagePending: boolean;
    readonly pluginLabel: string | undefined;
    readonly pluginIcon: string | undefined;
    readonly focused: boolean;
    readonly onDelete: (provider: DashboardProviderSummary) => void;
  }
  export const ProviderCard: React.FC<ProviderCardProps>;
  ```
  Task 14 renders it.

**Design corrections applied here (review round 1):**
- The card is **not** a `role="button"`. A card that is itself a button and also contains a switch, a
  menu button, and the quota button is invalid nested-interactive content, and its `Enter`/`Space`
  handler fires for every keystroke that bubbles up from those controls. Instead the display name is
  a real `<Link>` with a `::after` overlay covering the card, and the controls sit in a
  `relative z-10` row above it. Screen readers get one link, the mouse gets the whole card, and no
  handler has to guess whether an event "belongs" to the card.
- API protocol icons belong on **line 1**, next to the name (spec: "Line 1: 24px provider icon ·
  display name · quota ring", and "API providers with several protocols render a stacked avatar
  group"). Line 2 carries the protocol **label list** as an API provider's `detail` text.
- `grayscale` applies to the icon and the ring only, not the whole card — a disabled card's text must
  stay legible.
- A `state.diagnostic` on an otherwise-`ready` provider appends an amber suffix to line 2; only an
  `unavailable` state gets the red diagnostic box.
- The card test renders inside a `QueryClientProvider`; `ProviderCard` calls `useQuery`
  unconditionally and would otherwise throw "No QueryClient set".

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/src/modules/providers/components/provider-card/provider-card.test.tsx`:

```tsx
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, rs, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';
import type React from 'react';

import { providerStub } from '../../lib/provider-fixtures';
import { ProviderCard } from './provider-card';

rs.mock('@tanstack/react-router', () => ({ Link: 'a' }));
rs.mock('../../hooks/use-provider-enabled-mutation', () => ({
  useProviderEnabledMutation: () => ({ mutate: rs.fn(), isPending: false }),
}));
rs.mock('../../hooks/use-provider-mutations', () => ({
  useProviderDelete: () => ({ mutate: rs.fn(), isPending: false }),
}));
rs.mock('../provider-quota-ring', () => ({ ProviderQuotaRing: () => <span data-testid="quota-ring" /> }));

const baseProps = {
  health: undefined,
  usage: undefined,
  usagePending: false,
  pluginLabel: undefined,
  pluginIcon: undefined,
  focused: false,
  onDelete: () => {},
};

// The card calls `useQuery` unconditionally, so every render needs a client in scope.
const renderCard = (element: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
};

test('shows the display name and keeps the Provider ID to the hover title', () => {
  renderCard(<ProviderCard {...baseProps} provider={providerStub({ id: 'carpool', name: 'Carpool' })} />);

  expect(screen.getByText('Carpool')).toBeInTheDocument();
  expect(screen.getByTitle('carpool')).toBeInTheDocument();
  expect(screen.queryByText('carpool')).not.toBeInTheDocument();
});

test('the card body is one link and never a nested-interactive button', () => {
  renderCard(<ProviderCard {...baseProps} provider={providerStub({ id: 'p', name: 'P' })} />);

  const card = screen.getByTestId('provider-row-p');
  expect(card).not.toHaveAttribute('role', 'button');
  expect(card.querySelectorAll('a')).toHaveLength(1);
  expect(screen.getByTestId('provider-link-p')).toBeInTheDocument();
});

test('an API Provider lists its protocols on line 2 and stacks their icons on line 1', () => {
  renderCard(
    <ProviderCard
      {...baseProps}
      provider={providerStub({
        id: 'gateway',
        kind: ProviderKind.Api,
        protocols: [ProviderProtocol.OpenAICompatible, ProviderProtocol.Anthropic],
      })}
    />,
  );

  expect(screen.getByTestId('provider-protocol-stack')).toBeInTheDocument();
  expect(screen.getByTestId('provider-card-detail')).toHaveTextContent('OpenAI Compatible');
  expect(screen.getByTestId('provider-card-detail')).toHaveTextContent('Anthropic');
});

test('renders the routing and health stats with dashes when unavailable', () => {
  renderCard(<ProviderCard {...baseProps} provider={providerStub({ id: 'p', priority: 5, weight: 3 })} />);

  expect(screen.getByTestId('provider-stat-priority')).toHaveTextContent('5');
  expect(screen.getByTestId('provider-stat-weight')).toHaveTextContent('3');
  expect(screen.getByTestId('provider-stat-success-rate')).toHaveTextContent('—');
  expect(screen.getByTestId('provider-stat-p95')).toHaveTextContent('—');
});

test('defaults priority to 0 and weight to 1 and formats health', () => {
  renderCard(
    <ProviderCard
      {...baseProps}
      provider={providerStub({ id: 'p' })}
      health={{ successRate: 0.985, p95LatencyMs: 1234 }}
    />,
  );

  expect(screen.getByTestId('provider-stat-priority')).toHaveTextContent('0');
  expect(screen.getByTestId('provider-stat-weight')).toHaveTextContent('1');
  expect(screen.getByTestId('provider-stat-success-rate')).toHaveTextContent('98.5%');
  expect(screen.getByTestId('provider-stat-p95')).toHaveTextContent('1234');
});

test('an unavailable Provider shows its diagnostic prominently', () => {
  renderCard(
    <ProviderCard
      {...baseProps}
      provider={providerStub({
        id: 'p',
        state: {
          status: 'unavailable',
          diagnostic: {
            code: 'CATALOG_UNAVAILABLE',
            summary: 'Catalog down',
            retryable: true,
            occurredAt: '2026-09-01T00:00:00.000Z',
          },
        },
      })}
    />,
  );

  const diagnostic = screen.getByTestId('provider-card-diagnostic');
  expect(diagnostic).toHaveTextContent('Catalog down');
  expect(diagnostic).toHaveTextContent('CATALOG_UNAVAILABLE');
  expect(screen.queryByTestId('provider-card-diagnostic-hint')).not.toBeInTheDocument();
});

test('a ready Provider carrying a diagnostic gets the amber line-2 suffix, not the red box', () => {
  renderCard(
    <ProviderCard
      {...baseProps}
      provider={providerStub({
        id: 'p',
        state: {
          status: 'ready',
          diagnostic: {
            code: 'CATALOG_UNAVAILABLE',
            summary: 'Model list may be out of date',
            retryable: true,
            occurredAt: '2026-09-01T00:00:00.000Z',
          },
        },
      })}
    />,
  );

  expect(screen.getByTestId('provider-card-diagnostic-hint')).toHaveTextContent('Model list may be out of date');
  expect(screen.queryByTestId('provider-card-diagnostic')).not.toBeInTheDocument();
});

test('an invalid Provider offers deletion and nothing else', () => {
  renderCard(<ProviderCard {...baseProps} provider={providerStub({ id: 'oops', kind: 'invalid', enabled: false })} />);

  expect(screen.getByTestId('provider-card-invalid')).toBeInTheDocument();
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  expect(screen.queryByTestId('provider-link-oops')).not.toBeInTheDocument();
  expect(screen.getByTestId('provider-card-delete')).toBeInTheDocument();
});

test('a disabled Provider is dimmed but still interactive', () => {
  renderCard(<ProviderCard {...baseProps} provider={providerStub({ id: 'p', kind: ProviderKind.Api, enabled: false })} />);

  expect(screen.getByTestId('provider-row-p').className).toContain('bg-muted/40');
  expect(screen.getByRole('switch')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/dashboard && bun run test:unit -- provider-card
```

Expected: FAIL — module not found.

- [ ] **Step 3: Pin the protocol picker order**

`PROTOCOL_LABELS` already carries the `openai-image` entry (added in `77213e25` when the map was
annotated `Record<ProviderProtocol, …>`). What is still outstanding is that `PROTOCOL_ORDER` derives
from `Object.keys(PROTOCOL_LABELS)`, so that entry also leaked an `OpenAI Image` option into two
**pickers** — `modules/traces/components/traces-filters/traces-filters.tsx:146` and
`modules/providers/components/provider-form-fields-api.tsx:111,171` — a product change this release
did not ask for.

Replace line 48 of `packages/dashboard/src/components/protocol-label/protocol-label.tsx`:

```ts
export const PROTOCOL_ORDER = Object.keys(PROTOCOL_LABELS) as readonly ProviderProtocol[];
```

with the explicit list, and rewrite the doc comment above it:

```ts
/**
 * Protocol order for pickers. Rendering coverage and picker coverage are different questions:
 * `PROTOCOL_LABELS` must be exhaustive so a card never renders a blank icon, while the pickers offer
 * only the protocols a user may configure or filter by. `openai-image` renders but is not offered.
 * OpenAI Compatible leads because it is what most third-party gateways speak.
 */
export const PROTOCOL_ORDER: readonly ProviderProtocol[] = [
  ProviderProtocol.OpenAICompatible,
  ProviderProtocol.OpenAIResponse,
  ProviderProtocol.Anthropic,
  ProviderProtocol.Gemini,
  ProviderProtocol.GeminiInteractions,
];
```

- [ ] **Step 4: Write the protocol stack and the protocol label list**

Create `packages/dashboard/src/modules/providers/components/provider-protocol-stack/provider-protocol-stack.tsx`
— the line-1 icon group:

```tsx
import type { ProviderProtocol } from '@aio-proxy/types';
import { cn } from '@aio-proxy/ui/lib/utils';
import type React from 'react';

import { ProtocolLabel } from '@/components/protocol-label';

const MAX_VISIBLE = 3;

interface ProviderProtocolStackProps {
  readonly protocols: readonly ProviderProtocol[];
  readonly className?: string;
}

export const ProviderProtocolStack: React.FC<ProviderProtocolStackProps> = ({ protocols, className }) => {
  if (protocols.length === 0) return null;
  const visible = protocols.slice(0, MAX_VISIBLE);
  const overflow = protocols.length - visible.length;
  return (
    <span className={cn('inline-flex -space-x-1.5', className)} data-testid="provider-protocol-stack">
      {visible.map((protocol) => (
        <span
          key={protocol}
          className="inline-flex size-6 items-center justify-center rounded-full bg-card ring-2 ring-card"
        >
          {/* The label is the accessible name; only the icon is drawn. */}
          <ProtocolLabel protocol={protocol} showIcon className="[&>span:last-child]:sr-only" />
        </span>
      ))}
      {overflow > 0 ? (
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium ring-2 ring-card">
          {`+${overflow}`}
        </span>
      ) : null}
    </span>
  );
};
```

Create `provider-protocol-stack/index.ts`: `export { ProviderProtocolStack } from './provider-protocol-stack';`

Create `packages/dashboard/src/modules/providers/components/provider-protocol-labels/provider-protocol-labels.tsx`
— the line-2 text list. Protocol names are deliberately untranslated product terms, so the separator
is the only thing this component adds:

```tsx
import type { ProviderProtocol } from '@aio-proxy/types';
import type React from 'react';

import { ProtocolLabel } from '@/components/protocol-label';

interface ProviderProtocolLabelsProps {
  readonly protocols: readonly ProviderProtocol[];
}

export const ProviderProtocolLabels: React.FC<ProviderProtocolLabelsProps> = ({ protocols }) => (
  <>
    {protocols.map((protocol, index) => (
      <span key={protocol}>
        {index === 0 ? null : <span aria-hidden="true">{', '}</span>}
        <ProtocolLabel protocol={protocol} />
      </span>
    ))}
  </>
);
```

Create `provider-protocol-labels/index.ts`: `export { ProviderProtocolLabels } from './provider-protocol-labels';`

- [ ] **Step 5: Write the identity block**

Create `provider-card/provider-card-identity.tsx` — line 1 (icon + protocol stack + name link) and
line 2 (`kind · detail · plan` plus the amber diagnostic suffix):

```tsx
import { m } from '@aio-proxy/i18n';
import { type DashboardProviderSummary, ProviderKind } from '@aio-proxy/types';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { cn } from '@aio-proxy/ui/lib/utils';
import { Link } from '@tanstack/react-router';
import { AlertTriangleIcon } from 'lucide-react';
import type React from 'react';

import { PluginIcon } from '@/components/plugin-icon';

import { PROVIDER_KIND_LABEL } from '../../lib/constants';
import { providerDisplayName } from '../../lib/provider-list-view';
import { ProviderProtocolLabels } from '../provider-protocol-labels';
import { ProviderProtocolStack } from '../provider-protocol-stack';

interface ProviderCardIdentityProps {
  readonly provider: DashboardProviderSummary;
  readonly pluginLabel: string | undefined;
  readonly pluginIcon: string | undefined;
  readonly plan: string | undefined;
  readonly planPending: boolean;
  readonly editable: boolean;
}

export const ProviderCardIdentity: React.FC<ProviderCardIdentityProps> = ({
  provider,
  pluginLabel,
  pluginIcon,
  plan,
  planPending,
  editable,
}) => {
  const name = providerDisplayName(provider);
  const kindLabel =
    provider.kind === 'invalid' ? m['dashboard.providers.kind_label.invalid']() : PROVIDER_KIND_LABEL[provider.kind];
  // A `ready` provider can still carry a diagnostic (e.g. a stale catalog). That is a hint, not a
  // failure: the red box below is reserved for `unavailable`.
  const hint = provider.state.status === 'ready' ? provider.state.diagnostic : undefined;

  return (
    <div className="flex min-w-0 items-start gap-2">
      {provider.kind === 'invalid' ? (
        <AlertTriangleIcon className="size-6 shrink-0 text-destructive" aria-hidden="true" />
      ) : provider.kind === ProviderKind.Api && provider.protocols.length > 0 ? (
        <ProviderProtocolStack
          protocols={provider.protocols}
          className={cn('shrink-0', provider.enabled === false && 'grayscale')}
        />
      ) : pluginIcon === undefined ? (
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
          {name.charAt(0).toUpperCase()}
        </span>
      ) : (
        <PluginIcon
          icon={pluginIcon}
          size={24}
          className={cn('size-6 shrink-0 rounded-full', provider.enabled === false && 'grayscale')}
        />
      )}

      <div className="min-w-0 flex-1">
        {/* `::after` stretches this link over the whole card, so the card is clickable without being
            a nested-interactive button. The controls sit at `z-10` and stay above it. */}
        {editable ? (
          <Link
            id={`provider-link-${provider.id}`}
            data-testid={`provider-link-${provider.id}`}
            to="/providers/$id/edit"
            params={{ id: provider.id }}
            title={provider.id}
            className="block truncate font-medium after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:underline"
          >
            {name}
          </Link>
        ) : (
          <div className="truncate font-medium" title={provider.id}>
            {name}
          </div>
        )}

        <div
          className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground"
          data-testid="provider-card-detail"
        >
          <span>{kindLabel}</span>
          {provider.kind === ProviderKind.Api && provider.protocols.length > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <ProviderProtocolLabels protocols={provider.protocols} />
            </>
          ) : null}
          {provider.kind === ProviderKind.OAuth && (pluginLabel ?? provider.plugin) !== undefined ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{pluginLabel ?? provider.plugin}</span>
            </>
          ) : null}
          {provider.kind === ProviderKind.AiSdk && provider.packageName !== undefined ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{provider.packageName}</span>
            </>
          ) : null}
          {planPending ? (
            <Skeleton className="h-3 w-12" data-testid="provider-plan-loading" />
          ) : plan === undefined ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{plan}</span>
            </>
          )}
        </div>

        {hint === undefined ? null : (
          <p className="truncate text-xs text-amber-600 dark:text-amber-500" data-testid="provider-card-diagnostic-hint">
            {hint.summary}
          </p>
        )}
      </div>
    </div>
  );
};
```

- [ ] **Step 6: Write the stats row**

Create `provider-card/provider-card-stat.tsx` — one cell. Its own file, because a `.tsx` declares
exactly one component:

```tsx
import type React from 'react';

interface ProviderCardStatProps {
  readonly testId: string;
  readonly label: string;
  readonly value: string;
}

export const ProviderCardStat: React.FC<ProviderCardStatProps> = ({ testId, label, value }) => (
  <div className="min-w-0" data-testid={testId}>
    <div className="truncate text-xs text-muted-foreground">{label}</div>
    <div className="truncate text-sm font-medium tabular-nums">{value}</div>
  </div>
);
```

Create `provider-card/provider-card-stats.tsx`:

```tsx
import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import type React from 'react';

import type { ProviderHealth } from '../../services/provider-health-service';
import { ProviderCardStat } from './provider-card-stat';

interface ProviderCardStatsProps {
  readonly provider: DashboardProviderSummary;
  readonly health: ProviderHealth | undefined;
}

export const ProviderCardStats: React.FC<ProviderCardStatsProps> = ({ provider, health }) => (
  <div className="grid grid-cols-4 gap-2">
    <ProviderCardStat
      testId="provider-stat-priority"
      label={m['dashboard.providers.card.stat_priority']()}
      value={String(provider.priority ?? 0)}
    />
    <ProviderCardStat
      testId="provider-stat-weight"
      label={m['dashboard.providers.card.stat_weight']()}
      value={String(provider.weight ?? 1)}
    />
    <ProviderCardStat
      testId="provider-stat-success-rate"
      label={m['dashboard.providers.card.stat_success_rate']()}
      value={health === undefined ? '—' : `${(health.successRate * 100).toFixed(1)}%`}
    />
    <ProviderCardStat
      testId="provider-stat-p95"
      label={m['dashboard.providers.card.stat_p95']()}
      value={health === undefined ? '—' : `${Math.round(health.p95LatencyMs)} ms`}
    />
  </div>
);
```

- [ ] **Step 7: Write the footer**

Create `provider-card/provider-card-footer.tsx` — models count, 24h requests, the enable switch, and
the `⋯` menu. The controls sit above the card's overlay link rather than fighting it with
`stopPropagation`:

```tsx
import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import type React from 'react';

import { formatCompactTokenCount } from '@/components/token-count';

import type { ProviderUsage } from '../../services/provider-usage-service';
import { ProviderEnabledSwitch } from '../provider-enabled-switch';
import { ProviderMoreMenu } from '../provider-more-menu';

interface ProviderCardFooterProps {
  readonly provider: DashboardProviderSummary;
  readonly usage: ProviderUsage | undefined;
  readonly usagePending: boolean;
  readonly onDelete: (provider: DashboardProviderSummary) => void;
}

export const ProviderCardFooter: React.FC<ProviderCardFooterProps> = ({ provider, usage, usagePending, onDelete }) => (
  <div className="flex items-center justify-between gap-2">
    <div className="truncate text-xs text-muted-foreground">
      {`${m['dashboard.providers.card.models_count']({ count: provider.clientModels.length })} · ${m['dashboard.providers.card.requests_24h']({ count: usagePending ? '…' : usage === undefined ? 'N/A' : formatCompactTokenCount(usage.requestCount) })}`}
    </div>
    {/* Above the identity link's full-card `::after` overlay, so these stay clickable. */}
    <div className="relative z-10 flex shrink-0 items-center gap-1">
      <ProviderEnabledSwitch provider={provider} />
      <ProviderMoreMenu provider={provider} onDelete={onDelete} />
    </div>
  </div>
);
```

- [ ] **Step 8: Write the card**

Create `provider-card/provider-card.tsx` — composes the pieces, owns the card container, the state
styling, the focus attributes, and the quota query for OAuth providers with `hasQuota`:

```tsx
import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent } from '@aio-proxy/ui/components/card';
import { cn } from '@aio-proxy/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import type React from 'react';

import { resolveDashboardText } from '@/lib/localized-text';

import { canEditProvider } from '../../lib/provider-list-view';
import type { ProviderHealth } from '../../services/provider-health-service';
import { providerQuotaQueryOptions } from '../../services/provider-quota-service';
import type { ProviderUsage } from '../../services/provider-usage-service';
import { DiagnosticDetails } from '../diagnostic-details';
import { ProviderQuotaRing } from '../provider-quota-ring';
import { ProviderCardFooter } from './provider-card-footer';
import { ProviderCardIdentity } from './provider-card-identity';
import { ProviderCardStats } from './provider-card-stats';

interface ProviderCardProps {
  readonly provider: DashboardProviderSummary;
  readonly health: ProviderHealth | undefined;
  readonly usage: ProviderUsage | undefined;
  readonly usagePending: boolean;
  readonly pluginLabel: string | undefined;
  readonly pluginIcon: string | undefined;
  readonly focused: boolean;
  readonly onDelete: (provider: DashboardProviderSummary) => void;
}

export const ProviderCard: React.FC<ProviderCardProps> = ({
  provider,
  health,
  usage,
  usagePending,
  pluginLabel,
  pluginIcon,
  focused,
  onDelete,
}) => {
  const editable = canEditProvider(provider);
  const quotaQuery = useQuery({ ...providerQuotaQueryOptions(provider.id), enabled: provider.hasQuota });
  const plan = quotaQuery.data?.snapshot.plan;

  return (
    <Card
      size="sm"
      id={`provider-row-${provider.id}`}
      data-testid={`provider-row-${provider.id}`}
      data-focused={focused ? 'true' : undefined}
      className={cn(
        // `relative` anchors the identity link's full-card overlay; `overflow-visible` keeps the
        // focus ring from being clipped by the Card's own `overflow-hidden`.
        'relative gap-3 overflow-visible transition-shadow',
        editable && 'hover:shadow-md focus-within:ring-2 focus-within:ring-ring/40',
        provider.state.status === 'unavailable' && 'border border-destructive/60',
        // A blanket `opacity` would drop the muted body text under the contrast floor.
        provider.enabled === false && 'bg-muted/40',
        provider.kind === 'invalid' && 'border border-dashed border-destructive',
        focused && 'bg-accent ring-2 ring-ring/40',
      )}
    >
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <ProviderCardIdentity
            provider={provider}
            pluginLabel={pluginLabel}
            pluginIcon={pluginIcon}
            plan={plan === undefined ? undefined : resolveDashboardText(plan)}
            planPending={provider.hasQuota && quotaQuery.isPending}
            editable={editable}
          />
          {provider.hasQuota ? (
            <div className={cn('relative z-10 shrink-0', provider.enabled === false && 'grayscale')}>
              <ProviderQuotaRing provider={provider} pluginLabel={pluginLabel} pluginIcon={pluginIcon} />
            </div>
          ) : null}
        </div>

        {provider.kind === 'invalid' ? (
          <div className="space-y-2" data-testid="provider-card-invalid">
            <p className="text-sm text-destructive">{m['dashboard.providers.card.invalid_hint']()}</p>
            <code className="block rounded-md bg-destructive/10 p-2 text-xs whitespace-normal">{provider.id}</code>
            <div className="relative z-10 flex justify-end">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                data-testid="provider-card-delete"
                onClick={() => onDelete(provider)}
              >
                {m['dashboard.providers.actions.delete']()}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {provider.state.status === 'unavailable' ? (
              <div
                className="relative z-10 rounded-md border border-destructive/40 bg-destructive/10 p-2"
                data-testid="provider-card-diagnostic"
              >
                <DiagnosticDetails diagnostic={provider.state.diagnostic} />
              </div>
            ) : null}
            <ProviderCardStats provider={provider} health={health} />
            <ProviderCardFooter
              provider={provider}
              usage={usage}
              usagePending={usagePending}
              onDelete={onDelete}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
};
```

Create `provider-card/index.ts`: `export { ProviderCard } from './provider-card';`

- [ ] **Step 9: Run tests to verify they pass**

```bash
cd packages/dashboard && bun run test:unit -- provider-card protocol-label traces-filters provider-form-fields
```

Expected: PASS. The extra filters catch the `PROTOCOL_ORDER` pin regressing either picker.

- [ ] **Step 10: Commit**

```bash
git add packages/dashboard/src/components/protocol-label packages/dashboard/src/modules/providers/components/provider-protocol-stack packages/dashboard/src/modules/providers/components/provider-protocol-labels packages/dashboard/src/modules/providers/components/provider-card
git commit -m "feat(dashboard): add the Provider card" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: Quota ring and modal

**Files:**
- Create: `.../modules/providers/components/provider-quota-ring/{index.ts,provider-quota-ring.tsx,provider-quota-dialog.tsx,provider-quota-item.tsx,provider-quota-ring.test.tsx}`

**Interfaces:**
- Consumes: `providerQuotaQueryOptions` and `useProviderQuotaRefresh` (Task 11), `tightestQuotaItem` / `remainingPercent` (Task 10), the shadcn `Dialog` (Task 8), the `quota` message group (Task 9).
- Produces:
  ```ts
  interface ProviderQuotaRingProps {
    readonly provider: DashboardProviderSummary;
    readonly pluginLabel?: string;
    readonly pluginIcon?: string;
  }
  export const ProviderQuotaRing: React.FC<ProviderQuotaRingProps>;
  ```
  Task 12's card renders it.

**Design corrections applied here (review round 1):**
- A failed first read must stay recoverable. `providerQuotaQueryOptions` sets `retry: false`, so an
  error state that renders an inert `<span>` strands the card forever — the only refresh button lives
  in a dialog that can no longer be opened. The error state is therefore the same **button**, drawn
  differently, and it opens the same dialog.
- `strokeDashoffset` is computed from the clamped **raw ratio**, not the rounded display percent.
  `remainingPercent` floors a non-zero remainder at 1% so users never read "0%" beside a working
  provider; feeding that into the geometry would draw a visible arc for a ratio of `0.0001`.
- Refreshing goes through `useProviderQuotaRefresh` (a mutation that sends `refresh: true` and seeds
  the shared cache entry), not `query.refetch()` — a refetch re-runs the captured `refresh: false`
  query function and is silently swallowed by the server's five-minute cooldown.
- The dialog header carries the provider icon, the name, `plugin · plan`, and the refresh button, per
  the spec. The Provider ID is not surfaced there — the card never shows it, and the dialog is
  further from the list, not closer.

- [ ] **Step 1: Write the failing test**

Create `provider-quota-ring/provider-quota-ring.test.tsx`:

```tsx
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { providerStub } from '../../lib/provider-fixtures';
import { ProviderQuotaRing } from './provider-quota-ring';

const queryMocks = { data: undefined as unknown, isPending: false, isError: false };
const refreshMock = { calls: 0 };

rs.mock('@tanstack/react-query', () => ({
  queryOptions: <T,>(options: T) => options,
  useQuery: () => ({ data: queryMocks.data, isPending: queryMocks.isPending, isError: queryMocks.isError }),
}));
rs.mock('../../hooks/use-provider-quota-refresh', () => ({
  useProviderQuotaRefresh: () => ({
    mutate: () => {
      refreshMock.calls += 1;
    },
    isPending: false,
  }),
}));

const provider = providerStub({ id: 'kimi', name: 'Kimi', hasQuota: true });

test('renders the tightest remaining percentage on the ring', () => {
  queryMocks.data = {
    sampledAt: 1_700_000_000_000,
    stale: false,
    snapshot: {
      items: [
        { id: 'weekly', displayName: 'Weekly', remainingRatio: 0.8 },
        { id: 'five-hour', displayName: 'Five hour', remainingRatio: 0.12 },
      ],
    },
  };

  render(<ProviderQuotaRing provider={provider} />);

  expect(screen.getByTestId('provider-quota-ring')).toHaveTextContent('12');
});

test('opening the ring lists every quota item and requests a fresh reading', () => {
  queryMocks.data = {
    sampledAt: 1_700_000_000_000,
    stale: false,
    snapshot: {
      items: [
        { id: 'weekly', displayName: 'Weekly', remainingRatio: 0.8 },
        { id: 'unrated', displayName: 'Unrated' },
      ],
    },
  };
  const before = refreshMock.calls;

  render(<ProviderQuotaRing provider={provider} />);
  fireEvent.click(screen.getByTestId('provider-quota-ring'));

  expect(screen.getByText('Weekly')).toBeInTheDocument();
  expect(screen.getByText('Unrated')).toBeInTheDocument();
  expect(screen.getByTestId('provider-quota-item-unrated')).toHaveTextContent(/Not applicable|暂不适用/u);
  expect(screen.queryByTestId('provider-quota-bar-unrated')).not.toBeInTheDocument();
  expect(refreshMock.calls).toBe(before + 1);
});

test('the header refresh button asks for another reading', () => {
  queryMocks.data = {
    sampledAt: 1,
    stale: false,
    snapshot: { items: [{ id: 'weekly', displayName: 'Weekly', remainingRatio: 0.5 }] },
  };

  render(<ProviderQuotaRing provider={provider} />);
  fireEvent.click(screen.getByTestId('provider-quota-ring'));
  const before = refreshMock.calls;
  fireEvent.click(screen.getByTestId('provider-quota-refresh'));

  expect(refreshMock.calls).toBe(before + 1);
});

test('the arc is drawn from the raw ratio, not the floored display percent', () => {
  queryMocks.data = {
    sampledAt: 1,
    stale: false,
    snapshot: { items: [{ id: 'weekly', displayName: 'Weekly', remainingRatio: 0.004 }] },
  };

  render(<ProviderQuotaRing provider={provider} />);

  // The label floors to 1% so it never reads "0%", but the arc must stay ~invisible.
  expect(screen.getByTestId('provider-quota-ring')).toHaveTextContent('1');
  const arc = screen.getByTestId('provider-quota-arc');
  const circumference = Number(arc.getAttribute('stroke-dasharray'));
  expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference * 0.996, 5);
});

test('a tiny non-zero remainder never reads as zero in the dialog', () => {
  queryMocks.data = {
    sampledAt: 1,
    stale: false,
    snapshot: { items: [{ id: 'weekly', displayName: 'Weekly', remainingRatio: 0.004 }] },
  };

  render(<ProviderQuotaRing provider={provider} />);
  fireEvent.click(screen.getByTestId('provider-quota-ring'));

  expect(screen.getByTestId('provider-quota-item-weekly')).toHaveTextContent(/<1%|Less than 1%/u);
});

test('a stale reading is called out in the dialog', () => {
  queryMocks.data = {
    sampledAt: 1,
    stale: true,
    error: 'OAUTH_QUOTA_READ_FAILED',
    snapshot: { items: [{ id: 'weekly', displayName: 'Weekly', remainingRatio: 0.5 }] },
  };

  render(<ProviderQuotaRing provider={provider} />);
  fireEvent.click(screen.getByTestId('provider-quota-ring'));

  expect(screen.getByTestId('provider-quota-stale')).toBeInTheDocument();
});

test('a failed first read stays recoverable: the indicator is a button that retries', () => {
  queryMocks.data = undefined;
  queryMocks.isError = true;
  try {
    render(<ProviderQuotaRing provider={provider} />);

    const unavailable = screen.getByTestId('provider-quota-unavailable');
    expect(unavailable.tagName).toBe('BUTTON');

    const before = refreshMock.calls;
    fireEvent.click(unavailable);
    expect(refreshMock.calls).toBe(before + 1);
    expect(screen.getByTestId('provider-quota-dialog')).toBeInTheDocument();
  } finally {
    queryMocks.isError = false;
  }
});

test('clicking the ring does not bubble to the card', () => {
  queryMocks.data = {
    sampledAt: 1,
    stale: false,
    snapshot: { items: [{ id: 'w', displayName: 'W', remainingRatio: 0.5 }] },
  };
  const onCardClick = rs.fn();

  render(
    <div onClick={onCardClick} role="presentation">
      <ProviderQuotaRing provider={provider} />
    </div>,
  );
  fireEvent.click(screen.getByTestId('provider-quota-ring'));

  expect(onCardClick).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/dashboard && bun run test:unit -- provider-quota-ring
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the ring**

Create `provider-quota-ring/provider-quota-ring.tsx`:

```tsx
import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { cn } from '@aio-proxy/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import type React from 'react';
import { useState } from 'react';

import { useProviderQuotaRefresh } from '../../hooks/use-provider-quota-refresh';
import { remainingPercent, tightestQuotaItem } from '../../lib/quota-view';
import { providerQuotaQueryOptions } from '../../services/provider-quota-service';
import { ProviderQuotaDialog } from './provider-quota-dialog';

const SIZE = 28;
const STROKE = 3;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface ProviderQuotaRingProps {
  readonly provider: DashboardProviderSummary;
  readonly pluginLabel?: string;
  readonly pluginIcon?: string;
}

export const ProviderQuotaRing: React.FC<ProviderQuotaRingProps> = ({ provider, pluginLabel, pluginIcon }) => {
  const [open, setOpen] = useState(false);
  const query = useQuery(providerQuotaQueryOptions(provider.id));
  const refresh = useProviderQuotaRefresh(provider.id);
  const tightest = tightestQuotaItem(query.data?.snapshot);

  // Opening always asks upstream for a fresh reading; the ring itself is happy with the cached one.
  const openDialog = () => {
    setOpen(true);
    refresh.mutate();
  };

  if (query.isPending) {
    return (
      <span
        className="size-7 shrink-0 animate-pulse rounded-full border-2 border-muted"
        aria-label={m['dashboard.providers.quota.loading']()}
        data-testid="provider-quota-loading"
      />
    );
  }

  // `retry: false` means one failure is final for this query. An inert indicator would strand the
  // card, so the failure state is the same button: it opens the dialog and fires a refresh.
  if (query.isError || query.data === undefined) {
    return (
      <>
        <button
          type="button"
          data-testid="provider-quota-unavailable"
          aria-label={m['dashboard.providers.quota.load_failed']()}
          title={m['dashboard.providers.quota.load_failed']()}
          className="size-7 shrink-0 rounded-full border-2 border-dashed border-muted-foreground/40 focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={(event) => {
            event.stopPropagation();
            openDialog();
          }}
        />
        <ProviderQuotaDialog
          provider={provider}
          pluginLabel={pluginLabel}
          pluginIcon={pluginIcon}
          open={open}
          onOpenChange={setOpen}
          result={undefined}
          onRefresh={() => refresh.mutate()}
          refreshing={refresh.isPending}
        />
      </>
    );
  }

  const ratio = tightest?.remainingRatio;
  const percent = ratio === undefined ? undefined : remainingPercent(ratio);
  // Geometry uses the clamped raw ratio. `remainingPercent` floors a non-zero remainder at 1% for
  // the label; drawing that would show a visible arc for a nearly-exhausted quota.
  const clamped = ratio === undefined ? 0 : Math.min(Math.max(ratio, 0), 1);
  const offset = CIRCUMFERENCE * (1 - clamped);

  return (
    <>
      <button
        type="button"
        data-testid="provider-quota-ring"
        aria-label={m['dashboard.providers.quota.ring_label']({ id: provider.id })}
        className={cn('relative shrink-0 rounded-full focus-visible:ring-2 focus-visible:ring-ring/40')}
        onClick={(event) => {
          // The card body is one big link; the ring opens a modal instead of navigating.
          event.stopPropagation();
          event.preventDefault();
          openDialog();
        }}
      >
        <svg width={SIZE} height={SIZE} className="-rotate-90" aria-hidden="true">
          <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} className="stroke-muted" />
          <circle
            data-testid="provider-quota-arc"
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
            className="stroke-primary"
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[9px] font-medium tabular-nums">
          {percent === undefined ? '—' : percent}
        </span>
      </button>
      <ProviderQuotaDialog
        provider={provider}
        pluginLabel={pluginLabel}
        pluginIcon={pluginIcon}
        open={open}
        onOpenChange={setOpen}
        result={query.data}
        onRefresh={() => refresh.mutate()}
        refreshing={refresh.isPending}
      />
    </>
  );
};
```

- [ ] **Step 4: Write one quota bar**

Create `provider-quota-ring/provider-quota-item.tsx`:

```tsx
import { getLocale, m } from '@aio-proxy/i18n';
import type { OAuthQuotaItem } from '@aio-proxy/plugin-sdk';
import type React from 'react';

import { resolveDashboardText } from '@/lib/localized-text';

import { remainingPercent } from '../../lib/quota-view';

interface ProviderQuotaItemProps {
  readonly item: OAuthQuotaItem;
}

export const ProviderQuotaItem: React.FC<ProviderQuotaItemProps> = ({ item }) => {
  const percent = item.remainingRatio === undefined ? undefined : remainingPercent(item.remainingRatio);
  const tiny = item.remainingRatio !== undefined && item.remainingRatio > 0 && item.remainingRatio < 0.01;
  return (
    <li className="space-y-1" data-testid={`provider-quota-item-${item.id}`}>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="truncate">{resolveDashboardText(item.displayName)}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {percent === undefined
            ? m['dashboard.providers.quota.not_applicable']()
            : tiny
              ? m['dashboard.providers.quota.less_than_one_percent']()
              : m['dashboard.providers.quota.remaining']({ percent })}
        </span>
      </div>
      {percent === undefined ? (
        <p className="text-xs text-muted-foreground">{m['dashboard.providers.quota.not_applicable_hint']()}</p>
      ) : (
        // Bars never recolor by tightness: the ring already carries that signal.
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          data-testid={`provider-quota-bar-${item.id}`}
        >
          <div className="h-full rounded-full bg-primary" style={{ width: tiny ? '0%' : `${percent}%` }} />
        </div>
      )}
      {item.resetsAt === undefined ? null : (
        <p className="text-xs text-muted-foreground">
          {m['dashboard.providers.quota.resets_at']({ value: new Date(item.resetsAt).toLocaleString(getLocale()) })}
        </p>
      )}
    </li>
  );
};
```

- [ ] **Step 5: Write the dialog**

Create `provider-quota-ring/provider-quota-dialog.tsx`. `result` is optional so the failure state can
open the same dialog and offer a retry:

```tsx
import { getLocale, m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@aio-proxy/ui/components/dialog';
import { RotateCwIcon } from 'lucide-react';
import type React from 'react';

import { PluginIcon } from '@/components/plugin-icon';
import { resolveDashboardText } from '@/lib/localized-text';

import { providerDisplayName } from '../../lib/provider-list-view';
import type { ProviderQuotaResult } from '../../services/provider-quota-service';
import { ProviderQuotaItem } from './provider-quota-item';

interface ProviderQuotaDialogProps {
  readonly provider: DashboardProviderSummary;
  readonly pluginLabel: string | undefined;
  readonly pluginIcon: string | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly result: ProviderQuotaResult | undefined;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
}

export const ProviderQuotaDialog: React.FC<ProviderQuotaDialogProps> = ({
  provider,
  pluginLabel,
  pluginIcon,
  open,
  onOpenChange,
  result,
  onRefresh,
  refreshing,
}) => {
  const plan = result?.snapshot.plan;
  const source = pluginLabel ?? provider.plugin;
  const resolvedPlan = plan === undefined ? undefined : resolveDashboardText(plan);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={m['common.close']()} data-testid="provider-quota-dialog">
        <DialogHeader>
          <div className="flex items-start gap-3">
            {pluginIcon === undefined ? null : (
              <PluginIcon icon={pluginIcon} size={32} className="mt-0.5 size-8 shrink-0 rounded-full" />
            )}
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate">{providerDisplayName(provider)}</DialogTitle>
              <DialogDescription className="truncate">
                {[source, resolvedPlan].filter((part) => part !== undefined).join(' · ')}
              </DialogDescription>
            </div>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-testid="provider-quota-refresh"
              disabled={refreshing}
              onClick={onRefresh}
            >
              <RotateCwIcon data-icon="inline-start" aria-hidden="true" />
              {m['dashboard.providers.quota.refresh']()}
            </Button>
          </div>
        </DialogHeader>

        {result === undefined ? (
          <p role="status" data-testid="provider-quota-dialog-unavailable" className="text-sm text-muted-foreground">
            {m['dashboard.providers.quota.load_failed']()}
          </p>
        ) : (
          <>
            {result.stale ? (
              <p
                role="status"
                data-testid="provider-quota-stale"
                className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs"
              >
                {m['dashboard.providers.quota.stale_notice']()}
              </p>
            ) : null}
            <ul className="space-y-3">
              {result.snapshot.items.map((item) => (
                <ProviderQuotaItem key={item.id} item={item} />
              ))}
            </ul>
            {result.snapshot.resetCredits === undefined ? null : (
              <p className="text-xs text-muted-foreground">
                {m['dashboard.providers.quota.reset_credits']({ count: result.snapshot.resetCredits.availableCount })}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {m['dashboard.providers.quota.sampled_at']({ value: new Date(result.sampledAt).toLocaleString(getLocale()) })}
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
```

Create `provider-quota-ring/index.ts`: `export { ProviderQuotaRing } from './provider-quota-ring';`

- [ ] **Step 6: Confirm the card forwards the plugin presentation**

Task 12's `provider-card.tsx` already renders the ring with both props — verify the line reads:

```tsx
            <ProviderQuotaRing provider={provider} pluginLabel={pluginLabel} pluginIcon={pluginIcon} />
```

- [ ] **Step 7: Run tests to verify they pass**

```bash
cd packages/dashboard && bun run test:unit -- provider-quota-ring provider-card
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/dashboard/src/modules/providers/components/provider-quota-ring packages/dashboard/src/modules/providers/components/provider-card
git commit -m "feat(dashboard): add the Provider quota ring and detail modal" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: Card grid page, deletions, and the page test

**Files:**
- Create: `.../components/provider-card-grid/{index.ts,provider-card-grid.tsx,provider-filter-chips.tsx,provider-search-field.tsx,provider-card-grid.test.tsx}`
- Modify: `.../templates/providers-page.tsx`, `.../templates/providers-page.test.tsx`
- Delete: `.../components/providers-table/` (whole directory), `.../components/providers-table-columns.tsx`, `.../components/oauth-provider-group-row/`, `.../components/provider-table-actions.tsx`, `.../components/provider-state-cell.tsx`, `.../components/provider-state-cell.test.tsx`, `.../components/provider-models-cell.tsx`

**Interfaces:**
- Consumes: `ProviderCard` (Task 12), `visibleProviders` / `emptyProviderListFilters` / `ProviderListFilters` (Task 10), `providerHealthQueryOptions` (Task 11), `providerUsageQueryOptions`, `providerPluginPresentationsQueryOptions`, `DeleteProviderDialog`.
- Produces:
  ```ts
  interface ProviderCardGridProps {
    readonly providers: readonly DashboardProviderSummary[];
    readonly focusProviderId?: string;
  }
  export const ProviderCardGrid: React.FC<ProviderCardGridProps>;
  ```

**Design corrections applied here (review round 1):**
- The chip group's option `value` cannot be typed `string`: `onChange({ ...filters, [group.key]: option.value })`
  would try to assign `string` into `ProviderAvailabilityFilter | ProviderEnablementFilter | ProviderKindFilter`
  and fail the dashboard build. Each option instead carries its own `select` closure written with the
  literal inline, so every value type-checks at its declaration site with no cast and no generic
  computed-key gymnastics. `value` survives only as the `data-testid` suffix and React key.
- The search box is a TanStack Form field, not `useState` — `packages/dashboard/CLAUDE.md`: "Every
  input, select, checkbox, textarea, and editable field must use TanStack Form." It follows the
  existing `traces-request-filters` shape: the form owns the draft, each keystroke pushes the value
  up. It also gets a real `<FieldLabel>` (visually `sr-only`, reusing the placeholder copy) so the
  input is not a nameless textbox.
- The chips are toggle buttons in a labelled group: `role="group"` + `aria-label` on the group,
  `aria-pressed` on each chip. Without it a screen reader hears three unrelated runs of
  "All / Available / Unavailable" with no indication of which is active.
- The grid test's router mock keeps `Link` (`ProviderMoreMenu` still renders one) but drops
  `useNavigate` — the card no longer navigates programmatically.

- [ ] **Step 1: Write the failing grid test**

Create `provider-card-grid/provider-card-grid.test.tsx`:

```tsx
import { ProviderKind } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { providerStub } from '../../lib/provider-fixtures';
import { ProviderCardGrid } from './provider-card-grid';

// `Link` survives because ProviderMoreMenu and the card identity both render one; `useNavigate` does
// not, because no component in the grid navigates programmatically any more.
rs.mock('@tanstack/react-router', () => ({ Link: 'a' }));
rs.mock('../../hooks/use-provider-enabled-mutation', () => ({
  useProviderEnabledMutation: () => ({ mutate: rs.fn(), isPending: false }),
}));
rs.mock('../../hooks/use-provider-mutations', () => ({
  useProviderDelete: () => ({ mutate: rs.fn(), isPending: false }),
}));
rs.mock('../provider-quota-ring', () => ({ ProviderQuotaRing: () => null }));
// The grid's own three queries all hand back lookup maps; the card's per-Provider quota query is a
// different shape, so the mock has to tell them apart rather than return one value for everything.
// Handing a `Map` to the card would make `quotaQuery.data.snapshot` undefined and throw on `.plan`.
rs.mock('@tanstack/react-query', () => ({
  queryOptions: <T,>(options: T) => options,
  useQuery: (options: { queryKey: readonly unknown[] }) =>
    options.queryKey[2] === 'quota'
      ? { data: undefined, isPending: false, isError: true }
      : { data: new Map(), isPending: false, isError: false },
}));

const providers = [
  providerStub({ id: 'alpha', name: 'Alpha', kind: ProviderKind.Api, priority: 1 }),
  providerStub({ id: 'beta', name: 'Beta', kind: ProviderKind.OAuth, priority: 9, enabled: false }),
];

test('renders one card per Provider, sorted by priority', () => {
  render(<ProviderCardGrid providers={providers} />);

  const cards = screen.getAllByTestId(/^provider-row-/u);
  expect(cards.map((card) => card.getAttribute('data-testid'))).toEqual(['provider-row-beta', 'provider-row-alpha']);
});

test('the search box is a labelled field that narrows the grid and reports an empty result', () => {
  render(<ProviderCardGrid providers={providers} />);

  // A nameless textbox is unusable with a screen reader, so the accessible name is part of the contract.
  const search = screen.getByTestId('provider-search');
  expect(search).toHaveAccessibleName();

  fireEvent.change(search, { target: { value: 'alpha' } });
  expect(screen.queryByTestId('provider-row-beta')).not.toBeInTheDocument();

  fireEvent.change(search, { target: { value: 'nothing' } });
  expect(screen.getByTestId('providers-no-matches')).toBeInTheDocument();
});

test('a chip filters by enablement and reports its pressed state', () => {
  render(<ProviderCardGrid providers={providers} />);

  const disabled = screen.getByTestId('provider-filter-enablement-disabled');
  expect(disabled).toHaveAttribute('aria-pressed', 'false');

  fireEvent.click(disabled);

  expect(disabled).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByTestId('provider-filter-enablement-all')).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByTestId('provider-row-beta')).toBeInTheDocument();
  expect(screen.queryByTestId('provider-row-alpha')).not.toBeInTheDocument();
});

test('each chip group is named for assistive technology', () => {
  const { container } = render(<ProviderCardGrid providers={providers} />);

  // The shadcn `Field` wrapper around the search box is also a `group`, so scope this to the chips.
  const groups = [...container.querySelectorAll('[role="group"]')].filter((group) =>
    group.querySelector('[data-testid^="provider-filter-"]'),
  );
  expect(groups.length).toBe(3);
  for (const group of groups) expect(group).toHaveAccessibleName();
});

test('marks the focused Provider', () => {
  render(<ProviderCardGrid providers={providers} focusProviderId="alpha" />);

  expect(screen.getByTestId('provider-row-alpha')).toHaveAttribute('data-focused', 'true');
});

test('deep-link focus does not fire again when the user filters', async () => {
  render(<ProviderCardGrid providers={providers} focusProviderId="alpha" />);
  await nextFrames();

  const search = screen.getByTestId('provider-search');
  search.focus();
  fireEvent.change(search, { target: { value: 'alpha' } });
  await nextFrames();

  // Re-focusing the card here would rip the cursor out of the box mid-word.
  expect(document.activeElement).toBe(search);
});

const nextFrames = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

test('renders the empty state when there are no Providers at all', () => {
  render(<ProviderCardGrid providers={[]} />);

  expect(screen.getByText(/No providers configured|未配置提供商/u)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/dashboard && bun run test:unit -- provider-card-grid
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the search field**

Create `provider-card-grid/provider-search-field.tsx`. One input, one component file, TanStack Form
owning the draft exactly as `traces-request-filters` does:

```tsx
import { m } from '@aio-proxy/i18n';
import { Field, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { useForm } from '@tanstack/react-form';
import type React from 'react';

interface ProviderSearchFieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
}

export const ProviderSearchField: React.FC<ProviderSearchFieldProps> = ({ value, onChange }) => {
  const form = useForm({ defaultValues: { search: value } });

  return (
    <form.Field name="search">
      {(field) => (
        <Field>
          {/* The placeholder alone would leave the input nameless once text is typed into it. */}
          <FieldLabel htmlFor="provider-search" className="sr-only">
            {m['dashboard.providers.card.search_placeholder']()}
          </FieldLabel>
          <Input
            id="provider-search"
            data-testid="provider-search"
            value={field.state.value}
            placeholder={m['dashboard.providers.card.search_placeholder']()}
            onChange={(event) => {
              field.handleChange(event.target.value);
              onChange(event.target.value);
            }}
          />
        </Field>
      )}
    </form.Field>
  );
};
```

- [ ] **Step 4: Write the filter chips**

Create `provider-card-grid/provider-filter-chips.tsx`:

```tsx
import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import type React from 'react';

import type { ProviderListFilters } from '../../lib/provider-list-view';

interface ProviderFilterChipsProps {
  readonly filters: ProviderListFilters;
  readonly onChange: (filters: ProviderListFilters) => void;
}

/**
 * `value` is only the test id and React key. The literal that actually reaches `ProviderListFilters`
 * lives inside `select`, written at its declaration site, so each of the three filters keeps its own
 * union without a cast — a shared `value: string` would not be assignable to any of them.
 */
interface FilterOption {
  readonly value: string;
  readonly label: string;
  readonly select: () => void;
}

interface FilterGroup {
  readonly key: string;
  readonly label: string;
  readonly selected: string;
  readonly options: readonly FilterOption[];
}

export const ProviderFilterChips: React.FC<ProviderFilterChipsProps> = ({ filters, onChange }) => {
  const groups: readonly FilterGroup[] = [
    {
      key: 'availability',
      label: m['dashboard.providers.card.filter_availability'](),
      selected: filters.availability,
      options: [
        {
          value: 'all',
          label: m['dashboard.providers.card.filter_availability_all'](),
          select: () => onChange({ ...filters, availability: 'all' }),
        },
        {
          value: 'available',
          label: m['dashboard.providers.card.filter_availability_available'](),
          select: () => onChange({ ...filters, availability: 'available' }),
        },
        {
          value: 'unavailable',
          label: m['dashboard.providers.card.filter_availability_unavailable'](),
          select: () => onChange({ ...filters, availability: 'unavailable' }),
        },
      ],
    },
    {
      key: 'enablement',
      label: m['dashboard.providers.card.filter_enablement'](),
      selected: filters.enablement,
      options: [
        {
          value: 'all',
          label: m['dashboard.providers.card.filter_enablement_all'](),
          select: () => onChange({ ...filters, enablement: 'all' }),
        },
        {
          value: 'enabled',
          label: m['dashboard.providers.card.filter_enablement_enabled'](),
          select: () => onChange({ ...filters, enablement: 'enabled' }),
        },
        {
          value: 'disabled',
          label: m['dashboard.providers.card.filter_enablement_disabled'](),
          select: () => onChange({ ...filters, enablement: 'disabled' }),
        },
      ],
    },
    {
      key: 'kind',
      label: m['dashboard.providers.card.filter_kind'](),
      selected: filters.kind,
      // Kind values are protocol-level identifiers, not copy.
      options: [
        {
          value: 'all',
          label: m['dashboard.providers.card.filter_kind_all'](),
          select: () => onChange({ ...filters, kind: 'all' }),
        },
        { value: 'oauth', label: 'OAuth', select: () => onChange({ ...filters, kind: 'oauth' }) },
        { value: 'api', label: 'API', select: () => onChange({ ...filters, kind: 'api' }) },
        { value: 'ai-sdk', label: 'AI SDK', select: () => onChange({ ...filters, kind: 'ai-sdk' }) },
      ],
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {groups.map((group) => (
        // Toggle buttons, not radios: no arrow-key roving is implemented, so `aria-pressed` describes
        // what the control actually is. The group name is what makes three runs of "All" tellable apart.
        <div key={group.key} role="group" aria-label={group.label} className="flex flex-wrap items-center gap-1">
          <span aria-hidden="true" className="text-xs text-muted-foreground">
            {group.label}
          </span>
          {group.options.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="xs"
              variant={group.selected === option.value ? 'secondary' : 'ghost'}
              aria-pressed={group.selected === option.value}
              data-testid={`provider-filter-${group.key}-${option.value}`}
              onClick={option.select}
            >
              {option.label}
            </Button>
          ))}
        </div>
      ))}
    </div>
  );
};
```

- [ ] **Step 5: Write the grid**

Create `provider-card-grid/provider-card-grid.tsx`:

```tsx
import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Empty } from '@aio-proxy/ui/components/empty';
import { useQuery } from '@tanstack/react-query';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { resolveDashboardText } from '@/lib/localized-text';

import { emptyProviderListFilters, visibleProviders } from '../../lib/provider-list-view';
import { providerHealthQueryOptions } from '../../services/provider-health-service';
import { providerPluginPresentationsQueryOptions } from '../../services/provider-plugin-labels';
import { providerUsageQueryOptions, zeroProviderUsage } from '../../services/provider-usage-service';
import { DeleteProviderDialog, type DeleteProviderDialogRef } from '../delete-provider-dialog';
import { ProviderCard } from '../provider-card';
import { ProviderFilterChips } from './provider-filter-chips';
import { ProviderSearchField } from './provider-search-field';

interface ProviderCardGridProps {
  readonly providers: readonly DashboardProviderSummary[];
  readonly focusProviderId?: string;
}

export const ProviderCardGrid: React.FC<ProviderCardGridProps> = ({ providers, focusProviderId }) => {
  const [filters, setFilters] = useState(emptyProviderListFilters);
  const deleteDialogRef = useRef<DeleteProviderDialogRef>(null);
  const usageQuery = useQuery(providerUsageQueryOptions());
  const healthQuery = useQuery(providerHealthQueryOptions());
  const pluginsQuery = useQuery(providerPluginPresentationsQueryOptions());

  const pluginPresentations = useMemo(
    () => new Map((pluginsQuery.data?.plugins ?? []).map((plugin) => [plugin.packageName, plugin])),
    [pluginsQuery.data],
  );
  const visible = useMemo(() => visibleProviders(providers, filters), [providers, filters]);

  useEffect(() => {
    if (focusProviderId === undefined) return;
    // Two frames: the first lets React commit the grid, the second lets layout settle before scrolling.
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const card = document.getElementById(`provider-row-${focusProviderId}`);
        card?.scrollIntoView?.({ block: 'center' });
        // The identity link is the card's only focusable anchor; the container itself is not tabbable.
        (document.getElementById(`provider-link-${focusProviderId}`) ?? card)?.focus();
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusProviderId, visible]);

  if (providers.length === 0) return <Empty>{m['dashboard.providers.empty_state']()}</Empty>;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3">
        <ProviderSearchField value={filters.search} onChange={(search) => setFilters({ ...filters, search })} />
        <ProviderFilterChips filters={filters} onChange={setFilters} />
      </div>

      {visible.length === 0 ? (
        <p role="status" data-testid="providers-no-matches" className="p-6 text-center text-sm text-muted-foreground">
          {m['dashboard.providers.card.no_matches']()}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {visible.map((provider) => {
            const presentation = provider.plugin === undefined ? undefined : pluginPresentations.get(provider.plugin);
            return (
              <ProviderCard
                key={provider.id}
                provider={provider}
                health={healthQuery.data?.get(provider.id)}
                // A successful response omits Providers with no traffic, so a missing entry means
                // zero requests. Only an unresolved query leaves the count unknown.
                usage={usageQuery.data === undefined ? undefined : (usageQuery.data.get(provider.id) ?? zeroProviderUsage)}
                usagePending={usageQuery.isPending}
                pluginLabel={
                  presentation?.displayName === undefined ? undefined : resolveDashboardText(presentation.displayName)
                }
                pluginIcon={presentation?.icon}
                focused={provider.id === focusProviderId}
                onDelete={(target) => deleteDialogRef.current?.open(target)}
              />
            );
          })}
        </div>
      )}

      <DeleteProviderDialog ref={deleteDialogRef} />
    </div>
  );
};
```

Create `index.ts`: `export { ProviderCardGrid } from './provider-card-grid';`

- [ ] **Step 6: Rewrite the page**

`packages/dashboard/src/modules/providers/templates/providers-page.tsx` — replace only the import and the final render branch:

```tsx
import { ProviderCardGrid } from '../components/provider-card-grid';
```

```tsx
            <ProviderCardGrid providers={providers} focusProviderId={focusProviderId} />
```

Also drop the wrapping `Card`/`CardContent` (a grid of cards inside a card reads as a nesting mistake): keep the catalog warning, the loading skeletons, and the error branch as direct children of `PageContainer`, and remove the now-unused `Card` / `CardContent` imports.

- [ ] **Step 7: Delete the table**

```bash
git rm -r packages/dashboard/src/modules/providers/components/providers-table \
         packages/dashboard/src/modules/providers/components/oauth-provider-group-row
git rm packages/dashboard/src/modules/providers/components/providers-table-columns.tsx \
       packages/dashboard/src/modules/providers/components/provider-table-actions.tsx \
       packages/dashboard/src/modules/providers/components/provider-state-cell.tsx \
       packages/dashboard/src/modules/providers/components/provider-state-cell.test.tsx \
       packages/dashboard/src/modules/providers/components/provider-models-cell.tsx
```

`DiagnosticDetails`, `ProviderMoreMenu`, `ProviderEnabledSwitch`, and `DeleteProviderDialog` stay — the card uses all four. `use-data-table` stays — four other tables use it.

- [ ] **Step 8: Rewrite the page test**

`packages/dashboard/src/modules/providers/templates/providers-page.test.tsx`:

- The existing react-query mock branches on `options.queryKey[0] === 'providers'`, which now also matches the per-card quota key `['providers', id, 'quota']`. Replace it with an exact-key mock:

```ts
rs.mock('@tanstack/react-query', () => ({
  queryOptions: <T,>(options: T) => options,
  useQuery: (options: { queryKey: readonly unknown[] }) => {
    const key = JSON.stringify(options.queryKey);
    if (key === JSON.stringify(['providers'])) {
      return {
        data: queryMocks.providers,
        isLoading: false,
        isPending: false,
        isError: queryMocks.failed,
        refetch: () => {
          queryMocks.refetches += 1;
        },
      };
    }
    // The card's quota query returns a snapshot, not a lookup map; hand it nothing rather than a Map.
    if (options.queryKey[2] === 'quota') {
      return { data: undefined, isLoading: false, isPending: false, isError: true, refetch: () => {} };
    }
    return { data: new Map(), isLoading: false, isPending: false, isError: false, refetch: () => {} };
  },
}));
```

- Keep and adapt: `offers a new-provider action linking to /providers/new` (drop the `plugins-table` assertion), `locates and highlights a focused provider on another page` → rename to `highlights a focused provider` and keep the `data-focused="true"` assertion, `a failed providers query explains itself and offers a retry`, `shows a catalog warning returned by OAuth login`.
- Rewrite `renders one Provider identity column with a direct edit link` into a card assertion: the display name is present, the raw ID is not rendered as text, and there is no `columnheader` role anywhere.
- Delete outright: `renders OAuth accounts under their plugin capability group` (no grouping) and `pages forward and backward through more than one page of providers` (no pagination).
- Mock `../components/provider-quota-ring` to render null, as in the grid test. The router mock keeps `Link: 'a'` and needs no `useNavigate`.

- [ ] **Step 9: Prune orphaned message keys**

```bash
cd /Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/silly-shirley-289c12
for key in table.col_provider table.col_details table.col_type table.col_protocol table.col_name table.col_enabled table.col_status table.col_state table.col_capability table.col_account table.col_catalog table.col_models table.col_priority table.col_weight table.col_usage_24h table.col_actions table.expand_group table.collapse_group table.filter table.filter_placeholder table.columns table.label state.details state.ready state.failed state.catalog_fresh state.catalog_stale account.expires_at catalog.last_success_at; do
  count=$(grep -rc "dashboard.providers.$key" packages/dashboard/src 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')
  echo "$key $count"
done
```

Delete every key reporting `0` from all five locale files, then re-run `bun run i18n:compile`. Keep `state.unavailable` if the card still uses it; keep every key still reporting a non-zero count.

- [ ] **Step 10: Run the dashboard suite**

```bash
bun run i18n:compile
cd packages/dashboard && bun run test:unit
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(dashboard): replace the Provider table with a card grid" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 15: Changeset and preflight

**Files:**
- Create: `.changeset/provider-card-grid-quota.md`

**Interfaces:**
- Consumes: every package touched by Tasks 1–14.
- Produces: the release note.

- [ ] **Step 1: Write the changeset**

Create `.changeset/provider-card-grid-quota.md`:

```markdown
---
'@aio-proxy/plugin-kimi-code': minor
'@aio-proxy/plugin-xai-grok': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'@aio-proxy/core': minor
'@aio-proxy/i18n': minor
'@aio-proxy/ui': minor
'aio-proxy': minor
---

Redesign the dashboard Provider list as a card grid and surface OAuth remaining quota.

Each Provider — including each OAuth account — is now one card showing its name, kind, protocols,
plan, routing priority and weight, 24-hour success rate and p95 latency, model count, and request
count, with search and availability/enablement/kind filters replacing the old table's pagination and
grouping. OAuth Providers whose plugin exposes a quota capability show a remaining-quota ring that
opens a detail dialog with one bar per quota window.

The quota read is cached in memory behind a per-provider five-minute cooldown, refreshed
asynchronously after a Provider answers a model request, and exposed at
`QUERY /dashboard/api/providers/:id/quota`; the dialog's refresh button bypasses the cooldown.
`OAuthQuotaSnapshot` gains an optional `plan`, which `kimi-code` and `xai-grok` now populate, and
`xai-grok` also reports per-product usage. Dashboard Provider summaries gain `protocols` and
`hasQuota` in place of the single `protocol` field.
```

`aio-proxy` and `@aio-proxy/plugin-sdk` are both present, so both published Releases carry the note.

Two claims must **not** appear in this note. There is no ETag/conditional revalidation — commit
`77213e25` removed the `hono/etag` middleware, because it cached the very body `refresh` exists to
bypass. And there is no unified-billing weekly-limit fix: the pre-change `weeklyItem()` already
returned an item whenever `currentPeriod.end` parsed, so `e3e9d4b5` added a regression guard, not a
fix.

- [ ] **Step 2: Run the full preflight**

```bash
bun run build
bun run preflight
```

Expected: `lint:types` reports the **same 11 pre-existing TypeScript errors as pristine `main`
(`91de6ca4`)** and no new ones; `format:check` and `test` PASS. `lint:types` requires the fresh
`dist` output, hence the explicit `build` first. Confirm the delta by diffing the reported error list
against the recorded baseline in **Execution status**. A twelfth error, or an error in a file this
work touched, is a regression to fix before opening the PR. Do not "fix" the eleven: they are out of
scope and would bloat the diff.

- [ ] **Step 3: Commit**

```bash
git add .changeset
git commit -m "chore: add a changeset for the Provider card grid and quota" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Open the pull request**

```bash
git push -u origin claude/silly-shirley-289c12
```

```bash
gh pr create --base main --title "feat(dashboard): Provider card grid with OAuth quota" --body "$(cat <<'EOF'
## Summary

Replaces the dashboard Provider list's TanStack Table with a responsive card grid and surfaces OAuth remaining quota (剩余额度) on each card.

- One card per Provider, including one per OAuth account. No pagination, no grouping; sorted by provider priority then provider weight then Provider ID.
- Search matches display name and Provider ID; availability / state / kind chips narrow the grid.
- OAuth Providers whose plugin exposes a quota capability show a 28px ring for the tightest window, opening a dialog with one bar per window, the plan, the sample time, and a manual refresh that bypasses the cooldown.
- New `QUERY /dashboard/api/providers/:id/quota`, backed by an in-memory per-provider 5-minute cooldown cache with negative caching and in-flight dedupe; the request pipeline warms it asynchronously after a Provider answers successfully.
- `OAuthQuotaSnapshot` gains an optional `plan`; `kimi-code` maps its membership level and `xai-grok` reads its subscription tier and now also reports per-product usage.
- `DashboardProviderSummary` replaces `protocol?` with `protocols[]` and adds `hasQuota`.

## Test plan

- `bun run build && bun run preflight` — `format:check` and `test` pass. `lint:types` reports the same 11 pre-existing errors as `main` (`91de6ca4`) in `packages/dashboard` and `packages/cli`, none introduced here.
EOF
)"
```

---

## Self-review

**1. Spec coverage**

| Spec requirement | Task |
| --- | --- |
| Card grid `grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4`, gap 4, no pagination | 14 |
| One card per OAuth account, no grouping | 14 (grouping code deleted) |
| Sort priority desc → weight desc → id | 10 |
| Pure filter function + assert-based check, not TanStack Table | 10 |
| Search matches display name and Provider ID; the input is a TanStack Form field with an `sr-only` label | 10, 14 |
| Availability / enablement / kind chips, single-select with "all", `aria-pressed` in a named group | 14 |
| Line 1: 24px icon, display name, quota ring | 12 |
| Display name `name ?? accountLabel ?? id`, ID only in `title` | 10, 12 |
| Stacked protocol icons capped at 3 + `+N` | 12 |
| AI SDK letter placeholder | 12 |
| Line 2 `kind · detail · plan`, plan skeleton while loading | 12 |
| Stats row 优先级/权重/成功率/p95 with `—` and 0/1 fallbacks | 12 |
| Footer `N 模型 · N 次 / 24h` + switch + `⋯` | 12 |
| Card body navigates; controls stay above it | 12 (overlay `<Link>` + `relative z-10` control row, not `role="button"` + `stopPropagation`), 13 |
| `unavailable` destructive border + red diagnostic box | 12 |
| `enabled === false` → `bg-muted/40` on the card; `grayscale` on the icon and ring only | 12 |
| `kind === 'invalid'` → dashed card, alert triangle, red code box, single delete | 12 |
| Catalog fresh/stale line and `expiresAt` dropped; no status dot | 14 (cell deleted, keys pruned) |
| `?focus` preserved: id, testid, `data-focused`, double-rAF, `scrollIntoView`, focus link | 14 |
| Ring: hand-written 28px SVG, two circles, `-rotate-90`, dasharray/dashoffset, tightest item | 13, 10 |
| Loading ring = pulsing bordered circle | 13 |
| Ring is a button, opens a modal; a failed read stays a button so it can retry | 13 |
| Modal: header, per-item bars, reset credits, sample time, stale amber box, refresh | 13 |
| `remainingRatio === undefined` → 暂不适用, no bar | 13 |
| `>0 && <0.01` → 剩余 <1%, zero-width bar | 13, 10 |
| Bars don't recolor by tightness | 13 |
| Dialog primitive from the shadcn CLI, not hand-written | 8 |
| Reset quota out of scope | — (no reset UI in any task) |
| `QUERY /providers/:id/quota`, `{refresh?}` body | 4 (the ETag middleware was removed in `77213e25`: it cached the very body `refresh` exists to bypass) |
| Response returns the last good snapshot even on failure | 3, 4 |
| `plugin-quota/cache/` wrapping the reader, in-memory, 5-min cooldown, refresh bypass | 3 |
| Frontend `staleTime` 30s; modal always refreshes | 11, 13 |
| Async warming at both `step.kind === 'return'` sites, gated on `response.ok`, via `warmProviderQuota` on `ProviderRouteSource` | 5 |
| `protocol?` → `protocols[]`, add `hasQuota` | 2 |
| `plan?: LocalizedText` + `SNAPSHOT_KEYS` gains `'plan'` | 1 |
| OAuth complete route must NOT be deleted | — (absent from every deletion list) |
| kimi plan map + fallback, `www.kimi.com` assertion kept | 6 |
| grok plan via `/settings`, weekly-window regression guard, per-product usage | 7 (the weekly window was never actually dropped — see **Execution status**) |
| Paraglide across five locales + `i18n:compile` | 9 |
| 500-line limit / split at 400 | Global Constraints, Task 7 Step 5 |
| One `minor` changeset targeting `aio-proxy` + `@aio-proxy/plugin-sdk` | 15 |
| `bun run preflight` | 15 (against the recorded 11-error `lint:types` baseline) |
| `canEditProvider` + `displayName` relocated, `formatProviderUsage`/`ProviderUsageStatus` retired | 10 (relocation), 12 (footer derives the three states from the query) |
| `PROTOCOL_ORDER` pickers unchanged by the new `openai-image` label | 12 Step 3 |

No gaps.

**2. Placeholder scan**

No "TBD", no "add appropriate error handling", no "similar to Task N". One step intentionally describes judgement rather than exact code, with a concrete decision rule: Task 9 Step 2 (translating the en/zh-Hans copy into `ja`/`ko`/`zh-Hant`). Task 14 Step 7 enumerates every test to keep, rewrite, and delete by name.

**3. Type consistency**

- `OAuthQuotaSnapshot.plan` (Task 1) is read as `snapshot.plan` in Tasks 12 and 13 and written in Tasks 6 and 7. ✓
- `protocols` / `hasQuota` (Task 2) are read in Tasks 10, 12, and 14, written in every server summary builder. ✓
- `OAuthQuotaCacheEntry` (Task 3) → route response (Task 4) → `ProviderQuotaResult` (Task 11) → `ProviderQuotaDialogProps.result` (Task 13): identical `{ snapshot, sampledAt, stale, error? }`. ✓
- `warmProviderQuota` is spelled the same in `ProviderRouteSource`, the attempt helper, and `server-state/index.ts`. ✓
- `providerDisplayName` / `canEditProvider` / `visibleProviders` / `emptyProviderListFilters` (Task 10) are imported under those exact names in Tasks 12, 13, and 14. ✓
- `tightestQuotaItem` / `remainingPercent` (Task 10) are used under those names in Task 13. ✓
- `ProviderHealth` (Task 11) matches `ProviderCardProps.health` and `ProviderCardStatsProps.health`. ✓
- Task 12's `provider-card-stats.tsx` declares an inline `Stat` component, which violates one-component-per-file; the same step names the fix (extract `ProviderCardStat` into its own file). ✓
