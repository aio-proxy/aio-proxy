# API Provider model sync design

Issue: aio-proxy/aio-proxy#474 — keep `api` / `ai-sdk` Provider model lists in sync with the upstream catalog.

## Goal

An opt-in mode where an `api` Provider, or an `ai-sdk` Provider whose upstream catalog is discoverable, tracks its
upstream `/models` list on a schedule. A newly released upstream model becomes routable after the next refresh with
no config edit or restart. A hand-written `models` array keeps exactly today's behavior.

Hard constraints:

- A hand-written `models` array behaves exactly as before.
- The config file is never rewritten on a timer.
- A failed or empty discovery keeps the last good catalog and never drops routes.
- `GET /v1/models` stays deterministic.

## Config contract

New fields on `api` and `ai-sdk` Providers (authoring, runtime, and mutation schemas):

```yaml
providers:
  relay:
    kind: api
    baseURL: https://relay.example.com
    apiKey: ...
    syncModels: true
    excludedModels:
      - gpt-3.5-turbo
```

- `syncModels: boolean` (optional, default off). When `true`, the Provider's direct model routes come from the
  discovered catalog instead of `models`.
- `excludedModels: string[]` (optional). Exact model IDs hidden from the discovered catalog. Same name and exact-match
  semantics as the OAuth field. No glob, no allowlist: a user who wants an allowlist writes a static `models` array.
- Validation: `syncModels: true` together with a non-empty `models` is a schema error ("models and syncModels are
  mutually exclusive"). `excludedModels` without `syncModels: true` is a schema error, so a stray denylist never
  silently does nothing.
- `alias` keeps working in both modes. With no `models`, alias-target validation already accepts any target.

Trade-off: a separate boolean instead of a `models: "auto"` sentinel keeps `models` a plain array, so every existing
reader of `provider.models` (router, alias validation, exposure preview, Dashboard) is untouched.

## Discovery

- `api`: page through the **primary endpoint's** `/models` with the existing per-protocol logic (OpenAI `data[].id`,
  Anthropic `has_more`/`after_id`, Gemini `models[].name` + `nextPageToken`). Secondary endpoints are not queried:
  endpoints of one Provider serve one model set by definition, and asking each protocol multiplies requests and
  naming differences.
- `ai-sdk`: same rule as the Dashboard's **Load models** today — the package instance's `listModels(signal)` when it
  exists, otherwise `options.baseURL` + `/models` (OpenAI-compatible shape). When neither is available the Provider
  state is `unavailable` with a `CATALOG_UNSUPPORTED` diagnostic (new `DiagnosticCode`), and the Dashboard refuses to
  switch it to sync. Switching back to manual in the Dashboard drops `excludedModels` with the switch.
- The discovery code moves out of `dashboard-routes/provider-draft/provider-draft-operations.ts` into a shared
  server module used by both the draft **Load models** probe and the scheduled job, so the two can never disagree.
- Result is de-duplicated and sorted before it is stored, so upstream ordering changes never reorder `/v1/models`.
- An empty result counts as a failure.

## Storage

New SQLite table (drizzle migration), owned by a small `ProviderModelCatalogRepository` in `@aio-proxy/core`:

```
provider_model_catalog(
  provider_id   text primary key,
  source_digest text not null,
  models_json   text,            -- sorted string[]; null until the first success
  refreshed_at  integer,         -- last success
  failed_at     integer          -- last failure since the last success, else null
)
```

- Not `oauth_catalog`: that table and its diagnostics have a foreign key to `oauth_account`, and its CAS is fenced by
  the OAuth account runtime revision.
- `source_digest` hashes the discovery source (`api`: primary protocol + base URL; `ai-sdk`: package name +
  `options.baseURL`). A row whose digest no longer matches the config is treated as absent, so pointing a Provider at a
  different upstream never routes the old upstream's model list.
- Rows of deleted Providers are left in place (a few KB); a re-added Provider ID with a different source is already
  covered by the digest.

## Routing and `/v1/models`

- `buildSnapshot` reads the stored list for each synced Provider, subtracts `excludedModels`, and passes the Provider
  to `materializeProviders` / `resolveCatalogModalities` with `models` set to that list. The authored config held in
  the snapshot (`currentConfig()`, the Dashboard edit view, config writes) is never given the discovered models.
- The routing-policy inventory (`model-routing/inventory.ts`) uses the same helper for synced Providers.
- The router itself is unchanged.

## Failure and first discovery

- Failure (network error, non-2xx, malformed page, timeout, empty list): nothing is committed, `failed_at` is set, the
  last good list keeps routing, and the job retries after `CATALOG_RETRY_MS` (5 min). The Provider state is
  `ready` with `catalog: 'stale'` and a `CATALOG_UNAVAILABLE` diagnostic.
- First discovery (no stored list for the current source digest): the Provider exposes only its aliases, its state is
  `unavailable` with `CATALOG_UNAVAILABLE`, and the job is due immediately on startup and after every config change.
  Config loading is never blocked on the network.
- Success: `models_json`/`refreshed_at` replaced, `failed_at` cleared, snapshot rebuilt.
- TTL: fixed 1 hour, not configurable. The Dashboard has a manual refresh.

## Scheduling

`CatalogScheduler` is reused. Its descriptor becomes storage-agnostic:

```ts
type CatalogJobDescriptor = {
  readonly providerId: string;
  readonly enabled: boolean;
  readonly policy: { kind: 'static' } | { kind: 'ttl'; ttlMs: number };
  readonly stored: { readonly refreshedAt: number; readonly revision: number } | null;
  readonly unavailableOccurredAt?: number;
  /** Discover and commit; resolves false when the commit was fenced off. Throws on discovery failure. */
  readonly refresh: (signal: AbortSignal, startedAt: number) => Promise<boolean>;
  /** Record the failure; resolves true when stored state changed and the snapshot must rebuild. */
  readonly markUnavailable: () => boolean;
};
```

The OAuth job moves `validateModelCatalog`, `compareAndSwapCatalog`, and `writeCatalogUnavailableIfCurrent` into its
own closures in `plugin-runtime/materialize.ts`; the synced-Provider job supplies closures over the new repository.
Timers, retry, single flight, timeout, and `refreshNow` keep their current semantics for both.

## Dashboard

- The models section of the `api` / `ai-sdk` Provider editor gets a **Manual / Sync with upstream** switch.
  Switching to sync runs the existing draft catalog probe first; `catalog_unsupported` or `catalog_unavailable` keeps
  the switch off with an error, so a Provider is never saved into a mode that cannot work.
- In sync mode the model list is the discovered catalog, read-only, with a per-row hide toggle that edits
  `excludedModels` (same interaction as OAuth). It shows when the catalog was last refreshed and a refresh button.
- The refresh button uses the existing `POST /providers/:id/edit-view` with `refreshCatalog`, now also for synced
  `api` / `ai-sdk` Providers. The edit view gains the discovered list and `catalogLastSuccessAt` for them.
- Provider summaries expose `catalogLastSuccessAt` for synced Providers (the field already exists for OAuth).

## Testing

Colocated tests protecting behavior:

- A newly discovered model becomes routable (router + `/v1/models`) after a refresh, with no config edit.
- An upstream `/models` outage (and an empty response) removes no route and keeps the last good list.
- A Provider with a static `models` array is unaffected (no job, no table read, same routes).
- Source digest change invalidates the stored list.
- Schema: `syncModels` + `models` and `excludedModels` without `syncModels` are rejected.
- Existing `CatalogScheduler` tests keep passing after the descriptor change.
- Dashboard: switching mode and hiding a discovered model produce the expected mutation body.

## Docs and release

- Config JSON schema output regenerated; README, `README.zh-Hans.md`, website `api` and `ai-sdk-providers` pages
  (en + zh) document `syncModels` / `excludedModels`.
- One changeset, `minor`, targeting `aio-proxy` plus the internal packages touched.

## Out of scope

Vendor presets, OAuth discovery changes, model metadata/pricing, aliases, glob filters, allowlists, configurable TTL,
pruning rows of deleted Providers.
