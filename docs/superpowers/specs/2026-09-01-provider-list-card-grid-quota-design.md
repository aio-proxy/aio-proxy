# Provider List Card Grid + OAuth Quota Design

**Status:** Approved for implementation planning

## Goal

Replace the dashboard provider list's TanStack Table with a responsive card grid, and surface OAuth
remaining-quota (剩余额度) on each card as a compact ring that opens a detail modal.

Today the provider list is a paginated, grouped data table. It scans poorly at the 5–20 provider
scale the product actually targets, it hides OAuth account cards behind expandable group rows, and
it has nowhere to put quota. The card grid makes each provider a single scannable unit and gives
quota a natural home.

Secondary outcomes, all required by the primary one:

- `DashboardProviderSummary` gains `protocols[]` (API providers can expose several) and `hasQuota`.
- The server gains a cached, cooldown-guarded OAuth quota read route.
- A model request through a provider asynchronously warms that provider's quota cache, so the list
  is reasonably fresh without polling.
- `OAuthQuotaSnapshot` gains an optional `plan`, and `kimi-code` / `xai-grok` populate it.

## Current Behavior

### Provider list page

| Concern | Today |
| --- | --- |
| Layout | TanStack Table, paginated, column controls |
| OAuth accounts | Collapsed under a `${plugin}/${capability}` group row |
| Protocol | Single `summary.protocol`, rendered via a `PROTOCOL_LABELS` map that is missing `openai-image` |
| Availability | `provider-state-cell.tsx`: availability label + catalog `fresh`/`stale` line + diagnostic |
| Quota | Not shown anywhere |
| Focus deep-link | `?focus=<id>` finds the row, expands its group, pages to it, double-rAF, `scrollIntoView`, focuses `#provider-link-<id>` |

### Quota plumbing

| Layer | Today |
| --- | --- |
| `@aio-proxy/plugin-sdk` | `OAuthQuotaSnapshot = { items, resetCredits? }` |
| `@aio-proxy/core` | `validateOAuthQuotaSnapshot` with a closed `SNAPSHOT_KEYS = new Set(['items','resetCredits'])` allowlist |
| `@aio-proxy/server` | `createOAuthQuotaOperations` → `read` / `reset`; **no caching**, every call hits upstream |
| Dashboard | No quota route, no quota UI |
| `kimi-code` | Reads `/coding/v1/usages`, builds `weekly` + per-window items; discards `user.membership.level` |
| `xai-grok` | Reads `/billing?format=credits` + `/billing`, builds `weekly` + `monthly-credits` |

### Health data

`GET /dashboard/api/overview/diagnostics?range=24h` already returns
`providerHealth: { providerId, successRate, p95LatencyMs }[] | null`. No new health route is needed.

## Decision

### Card grid replaces the table

- Grid: `grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4`, gap 4. No pagination — render
  every provider.
- One card per provider, including one card per OAuth account. **No grouping.**
- Sort: provider priority descending, then provider weight descending. Ties fall back to id.
- Filtering is a pure function in `modules/providers/lib/provider-list-view/` consumed via `useMemo`
  — **not** TanStack Table. It is covered by `provider-list-view.test.ts`.
  - Search matches display name **and** Provider ID (case-insensitive substring).
  - Chips, flat and clickable: availability (全部 / 可用 / 异常), enablement (已启用 / 已禁用), kind
    (OAuth / API / AI SDK). Each group is single-select with an implicit "all" default.

### Card anatomy

Line 1: 24px provider icon · display name (truncate) · quota ring (OAuth with `hasQuota` only).

- Display name = `name ?? accountLabel ?? id`. The Provider ID appears only in the `title` hover
  attribute. Search may match the ID, but the ID is never surfaced on the card.
- API providers with several protocols render a stacked avatar group (`-space-x-1.5`,
  `ring-2 ring-card`) capped at 3 icons plus a `+N` bubble.
- AI SDK providers with no icon render a letter placeholder.

Line 2 (`text-xs text-muted-foreground`, truncate): `kind · detail · plan`.

- `kind` is `OAuth` / `API` / `AI SDK` from the existing `PROVIDER_KIND_LABEL` literals.
- `detail` is the plugin display name (OAuth), the protocol label list (API), or the package name
  (AI SDK).
- `plan` is the OAuth quota plan when known; a pulsing skeleton bar while the quota query loads;
  omitted entirely when the provider has no plan.
- A `state.diagnostic` appends an amber suffix with the diagnostic message.

Stats row: 4-column grid of 优先级 / 权重 / 成功率 / p95, `—` when unavailable. Priority and weight
fall back to `0` and `1`, matching today's column fallbacks.

Footer: `N 模型 · N 次 / 24h` on the left; enable switch and `⋯` menu on the right.

Card states:

- Clicking the card body navigates to the provider edit page. The switch, the ring, and the `⋯`
  menu each `stopPropagation`.
- `state.status === 'unavailable'`: destructive border plus a red diagnostic box containing the
  diagnostic code and message.
- `enabled === false`: `bg-muted/40` on the card, icon and ring `grayscale`. A blanket `opacity`
  would drop the muted body text under the contrast floor, and the greyed icons plus the off switch
  already read as disabled.
- `kind === 'invalid'`: dashed destructive card, alert-triangle placeholder icon, red code box,
  footer with a single 删除 action.

**Dropped from the current cell:** the catalog `fresh`/`stale` line and `expiresAt`. Catalog
staleness self-heals on a 5-minute retry and is not user-actionable; token expiry is refreshed
automatically. Auth expiry already surfaces as the `CREDENTIAL_REFRESH_FAILED` diagnostic with an
`unavailable` state, which the card renders prominently. There is no status dot.

The `?focus=<id>` behavior is preserved: `provider-row-<id>` id, `data-testid`, `data-focused`,
double-rAF `scrollIntoView({ block: 'center' })`, focus `#provider-link-<id>` with the card as
fallback. Pagination and group expansion drop out of that sequence because neither exists.

### Quota ring and modal

- The ring is a hand-written 28px SVG (two `<circle>` elements, `-rotate-90`, `stroke-dasharray` /
  `stroke-dashoffset`) with the remaining percentage centered. It renders the **tightest** item —
  the one with the lowest `remainingRatio`. Items without a ratio never win.
- While loading, the ring is replaced by a pulsing bordered circle of the same size.
- The ring is a button. It opens a modal; it does not navigate.
- The modal shows: header (icon, name, `plugin · plan`), one bar per quota item, reset-credit
  availability when present, and a stale-snapshot amber error box when the last refresh failed; the
  footer carries the sample time and the refresh button.
  - An item with `remainingRatio === undefined` is not rendered at all. A snapshot in which no window
    reports a remaining amount shows one empty-state line instead of an empty list.
  - `remainingRatio > 0 && < 0.01` renders 剩余 <1% with a zero-width bar. The bar's
    `aria-valuetext` carries that same string, because the underlying value is the raw ratio and
    would otherwise be announced as 0%.
  - Bars do not change color by tightness.
- Bar primitive: the shared `progress.tsx`, same as the overview's top-model-costs rows. The call
  site supplies only a `ProgressLabel` and a `ProgressValue`; `Progress` renders the track itself.
- Modal primitive: `packages/ui` has no `dialog.tsx`. It is generated with the vendored shadcn CLI —
  `bun x --bun --no-install shadcn add dialog --overwrite` run from `packages/ui` — not hand-written,
  because that directory is CLI-managed. The one hand edit on top of the generated file is a
  `closeLabel` prop: the close button's screen-reader label must be localized, and `packages/ui`
  intentionally has no `@aio-proxy/i18n` dependency, so the label comes from the caller.

### Reset quota is out of scope

`OAuthQuotaCapability.reset` exists and the server already exposes it, but no UI ships this release.

### Backend quota route

`QUERY /dashboard/api/providers/:id/quota`, body `{ refresh?: boolean }`. QUERY is chosen over POST
because the operation is a read; Hono's `METHODS` includes `query` so `app.query(...)` and the typed
RPC `$query` both work with no shim. Browsers issue it fine via `fetch`; being non-CORS-safelisted
only means a preflight, and the dashboard is same-origin. No `hono/etag`: the response is already
served from a cooldown-guarded in-memory cache, so conditional revalidation would add a second
caching layer with its own invalidation problem and save nothing measurable on a payload this small.

Response: `{ snapshot, sampledAt, stale: boolean, error?: string }` — the last successful snapshot is
always returned when one exists, even when the current refresh failed. The plan is not a top-level
field; it rides on `snapshot.plan`, because it is what the plugin sampled, not what the route knows.

Caching:

- New `packages/server/src/plugin-quota/cache/` wraps `createOAuthQuotaReader`. In-memory only; lost
  on restart.
- Per-provider 5-minute cooldown, modeled on `routes/pipeline/provider-cooldown/provider-cooldown.ts`
  (`lru-cache`, already in the root catalog).
- `refresh: true` from the modal's manual refresh button **bypasses** the cooldown.
- Frontend `staleTime` is 30s. Opening the modal always requests a refresh.

### Async cache warming

After a candidate attempt returns a response, the pipeline fires one non-blocking quota refresh for
that provider (`void ….catch(() => {})`) in `routes/pipeline/attempt/attempt.ts` at both
`if (step.kind === 'return')` sites, gated on `response.ok` so a failed attempt does not spend a
cooldown slot. `waitUntil` is unusable here — `c.executionCtx` throws under
`Bun.serve({ fetch: app.fetch })` — which is why the hook lives in the pipeline rather than in a Hono
handler. `ProviderRouteSource` gains one optional `warmProviderQuota(providerId)` callback rather than
the whole `oauthQuota` capability, so the pipeline depends on the single operation it performs instead
of on the reader; `ServerState` already *is* the source, so no new plumbing is needed.

### Type changes

`DashboardProviderSummarySchema`:

- `protocol?: ProviderProtocol` → `protocols: ProviderProtocol[]` (readonly array; empty for non-API
  providers). Populated from `apiProviderEndpoints(provider)`. Only two readers of `protocol` exist
  today and both live in files being deleted.
- Add `hasQuota: boolean` — `adapter.quota !== undefined`. An OAuth account that fails preparation
  still reports the flag its adapter advertises, so the ring survives a reauthentication prompt;
  only invalid providers, whose plugin never loaded, report `false`.

### SDK and validator

Add `plan?: LocalizedText` to `OAuthQuotaSnapshot`.

**Blocker, must ship in the same change:** `packages/core/src/plugins/quota.ts` validates snapshots
against a closed allowlist, `SNAPSHOT_KEYS = new Set(['items', 'resetCredits'])`. Without adding
`'plan'` there — plus a `localizedText` validation branch — every kimi/grok quota read would throw
`OAuthQuotaValidationError`.

### Retained: the OAuth complete route

`packages/dashboard/src/routes/oauth/complete.tsx` and `modules/oauth-complete/` are load-bearing and
**must not be deleted**. They are referenced by `server/src/oauth-login-session/authorization.ts`
(`dashboardOAuthCompleteUrl`), `server-state/lifecycle.ts`, `types/src/dashboard-oauth.ts` pathname
validation, and `use-oauth-editor-session.ts` (`OAUTH_COMPLETE_MESSAGE`).

## Data Flow

Card list render:

1. `providersQueryOptions()` → `GET /providers` → summaries with `protocols[]` and `hasQuota`.
2. `overviewDiagnosticsQueryOptions('24h')` → `providerHealth[]`, joined by `providerId` for
   成功率 / p95.
3. `providerUsageQueryOptions()` → 24h request counts per provider, joined by id. The response omits
   Providers with no traffic in the window, so a resolved query with no entry for a Provider means
   `0`, not unknown; only an unresolved query renders `N/A`.
4. Filter + sort pure function → grid.

Quota ring, per card with `hasQuota`:

1. `providerQuotaQueryOptions(id)` (key registered centrally in `lib/query-keys.ts`) →
   `QUERY /providers/:id/quota` with `{}`.
2. Server: cache hit within 5 minutes → cached snapshot; otherwise read upstream, cache, return.
3. Ring renders the tightest `remainingRatio`.

Modal open: same query with `{ refresh: true }`, bypassing the cooldown. Failure returns the previous
snapshot with `stale: true` and the amber error box.

Pipeline warming: attempt returns `response.ok` → `source.warmProviderQuota?.(provider.id)` →
cooldown-guarded refresh. The pipeline sees one optional callback, not the quota capability.

## Plugin Behavior

### kimi-code

Reads `user.membership.level` from the **existing** `/coding/v1/usages` response (currently
discarded — no extra request, no browser cookie). Maps in-plugin:

| Level | Plan |
| --- | --- |
| `LEVEL_BASIC` | Moderato |
| `LEVEL_INTERMEDIATE` | Allegretto |
| `LEVEL_ADVANCED` | Allegro |
| `LEVEL_STANDARD` | Vivace |

Fallback: `level.replace('LEVEL_', '').toLowerCase()`. Unknown or missing level → no `plan`.

The existing `quota.test.ts` assertion that the request URL never contains `www.kimi.com` stays.

### xai-grok

1. **Plan:** `GET ${XAI_GROK_CLI_BASE_URL}/settings` with the same bearer headers, reading
   `subscription_tier_display` (e.g. `SuperGrok Heavy`, `SuperGrok`). Optional enrichment with a
   2-second timeout; any failure or missing field simply drops the plan.
2. **Unified-billing weekly-limit regression guard:** a credits payload with a parseable period but
   no `creditUsagePercent` already emits the rate window with `remainingRatio` omitted, and that
   window can be the only item the account produces, so dropping it in the reader would trip the
   no-items throw and fail an otherwise successful read. This is existing correct behavior; the
   release only adds the test that pins it, because the per-product work below touches the same
   builder. The modal separately does not render a window with no remaining amount.
3. **Per-product usage:** map `config.productUsage[]` (`{ product, usagePercent }`) into items keyed
   `product_<slug>`, with `grokbuild` / `productgrokbuild` normalized to `grok_build` / "Grok Build",
   `remainingRatio = (100 - usagePercent) / 100`, and `_2` / `_3` suffixes for duplicate slugs. The
   suffix pass reserves every id it hands out, so a product that spells a suffix out (`grok build 2`)
   cannot collide with a generated one — a duplicate id would make the core validator reject the whole
   snapshot.

## Deletions

- `modules/providers/components/providers-table/` (whole directory)
- `modules/providers/components/providers-table-columns.tsx`
- `modules/providers/components/oauth-provider-group-row/`
- `modules/providers/components/provider-table-actions.tsx`

Relocated, not deleted: `canEditProvider` and the `displayName` helper (as `providerDisplayName`),
both moving into `modules/providers/lib/provider-list-view/`. `formatProviderUsage` and
`ProviderUsageStatus` go away with the table — the card footer needs the same three states
(loading / ready / unavailable) but derives them from the query's own `isPending` and `undefined`
result rather than from a separately-threaded status union.

## Constraints

- All copy goes through Paraglide across all five locales (`en, ja, ko, zh-Hans, zh-Hant`); run
  `bun run i18n:compile` after editing messages.
- Handwritten non-test implementation files stay under 500 lines; split at 400 into
  `foo/index.ts` (exports only) + `foo/foo.ts` + private collaborators.
- One changeset, `minor`, targeting `aio-proxy` and `@aio-proxy/plugin-sdk` alongside every internal
  package touched.
- `bun run preflight` must pass.
