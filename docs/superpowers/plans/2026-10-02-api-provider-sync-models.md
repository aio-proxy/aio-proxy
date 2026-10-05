# API Provider Model Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `api` / `ai-sdk` Providers with `syncModels: true` track the upstream `/models` catalog on a schedule, keeping the last good list through outages, while a hand-written `models` array behaves exactly as before.

**Architecture:** A new SQLite table stores each synced Provider's last good model list keyed by Provider ID and a source digest. `buildSnapshot` injects that list as `models` into the copies of synced Providers it materializes (never into the authored config), and emits one catalog job per synced Provider into the existing `CatalogScheduler`, whose job descriptor becomes storage-agnostic. Discovery reuses the Dashboard **Load models** probe code, moved into a shared module.

**Tech Stack:** Bun, TypeScript, Zod 4, bun:sqlite + drizzle-kit migrations, Hono, React + TanStack Form, Paraglide i18n (`@aio-proxy/i18n`).

**Spec:** `docs/superpowers/specs/2026-10-02-api-provider-sync-models-design.md`

## Global Constraints

- A hand-written `models` array behaves exactly as before: no job, no table read, identical routes.
- The config file is never rewritten on a timer; discovered models never enter `currentConfig()` or a config write.
- A failed or empty discovery keeps the last good catalog and never drops routes.
- `GET /v1/models` stays deterministic: stored lists are de-duplicated and sorted (`toSorted()` default string order).
- Fixed TTL `SYNCED_MODELS_TTL_MS = 60 * 60_000`; retry on failure uses the existing `CATALOG_RETRY_MS` (5 min).
- Only the primary endpoint of an `api` Provider is queried.
- Domain terms: Provider ID, Provider priority, Provider weight (repo `CLAUDE.md`).
- Tests colocated as `foo/index.ts`, `foo/foo.ts`, `foo/foo.test.ts`; non-test files < 500 lines, evaluate a split at 400; files already over 500 must not grow.
- Use `es-toolkit` (`uniq`, `isPlainObject`) over hand-written helpers; Bun APIs (`Bun.CryptoHasher`) over Node equivalents.
- Run `bun run preflight` before calling the work done.

## Review Focus

1. **Upstream switched under a stored list** — the user changes `baseURL` (or ai-sdk `packageName` / `options.baseURL`) on a synced Provider: the old upstream's models must stop routing immediately, not after the next refresh. Test in Task 5 (`source digest change hides the stored list`).
2. **Refresh in flight while the config changes** — a discovery started before a save must not commit after `replaceJobs` aborted it. Test in Task 4 (`an aborted synced refresh commits nothing`).
3. **Upstream returns 200 with `data: []`** — treated as failure, last good list kept. Test in Task 5 (`empty discovery keeps the last good list`).
4. **`excludedModels` lists an ID that also appears in `alias`** — the alias still routes; only the direct route disappears. Test in Task 5 (`excluded model stays reachable through an alias`).
5. **Toggling sync off in the Dashboard** — the saved body must carry no `syncModels`, no `excludedModels`, and `models` = exposed models plus discovered alias targets, so the Provider keeps routing what it routed a second ago and the server's alias-target check accepts it. Test in Task 7 (`switching to manual seeds models from exposed models and alias targets`).

---

### Task 1: Config contract

**Files:**
- Create: `packages/types/src/provider-sync-models/index.ts`, `packages/types/src/provider-sync-models/provider-sync-models.ts`, `packages/types/src/provider-sync-models/provider-sync-models.test.ts`
- Modify: `packages/types/src/provider.ts` (spread fields into `ApiProviderSharedFields`, `AiSdkProviderSharedFields`, `ApiProviderMutationSharedFields`, `AiSdkProviderMutationSharedFields`; add `.superRefine(validateSyncModels)` to `ProviderSchema`, `ProviderMutationBodySchema`, `ProviderMutationAuthoringBodySchema`)
- Modify: `packages/types/src/config/config.ts:101,111` (add `.superRefine(validateSyncModels)` to both provider unions)
- Modify: `packages/types/src/index.ts` (export)
- Modify: `packages/types/src/plugin.ts:15-30` (add `'CATALOG_UNSUPPORTED'` to `DiagnosticCodeSchema`)
- Modify: `packages/core/src/plugins/diagnostic/diagnostic.ts` (summary case `CATALOG_UNSUPPORTED` → `m['cli.plugin.diagnostic_catalog_unsupported']({ provider })`)
- Modify: `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json` (`cli.plugin.diagnostic_catalog_unsupported`, en: `"Provider {provider} cannot list its upstream models, so syncModels cannot be used"`)

**Interfaces:**
- Produces:
  - `syncModelsFields` — `{ syncModels: z.boolean().optional(), excludedModels: z.array(ModelIdSchema).optional() }` with `.describe()` text `'Track the upstream model catalog instead of a static models list.'` / `'Discovered model ids hidden from this provider.'`
  - `syncModelsMutationFields` — same keys, `excludedModels: z.array(z.string()).optional()`
  - `validateSyncModels(value: { kind: string; syncModels?: boolean; models?: readonly string[]; excludedModels?: readonly string[] }, ctx: z.RefinementCtx): void` — no-op for `kind === 'oauth'`
  - `ApiProvider`, `AiSdkProvider` and mutation bodies gain `syncModels?: boolean`, `excludedModels?: string[]`

- [ ] **Step 1: Write failing tests** in `provider-sync-models.test.ts` using `ConfigSchema` / `ProviderMutationBodySchema`:
  - `syncModels with excludedModels parses for api and ai-sdk` → success, output keeps both fields.
  - `syncModels with non-empty models is rejected` → issue path `['models']`, message `'models and syncModels are mutually exclusive'`.
  - `syncModels with models: [] parses` (Dashboard sends an empty array).
  - `excludedModels without syncModels is rejected on api` → path `['excludedModels']`, message `'excludedModels requires syncModels'`.
  - `oauth excludedModels still parses without syncModels`.
  - `config JSON schema documents syncModels` → `JSON.stringify(buildConfigJsonSchema())` contains `"syncModels"`.
- [ ] **Step 2:** `bun test packages/types/src/provider-sync-models` → FAIL (module missing).
- [ ] **Step 3: Implement** the module and wire it into the files above. `provider.ts` must stay under 400 lines; keep the new logic in the new module.
- [ ] **Step 4:** `bun test packages/types` → PASS; `bun run --filter @aio-proxy/core test -- diagnostic` → PASS.
- [ ] **Step 5: Commit** `feat(types): add syncModels config contract`.

---

### Task 2: Stored model catalog repository

**Files:**
- Create: `packages/core/src/db/schema/provider-model-catalog.ts`; export from `packages/core/src/db/schema/index.ts`
- Create: migration via `bun x drizzle-kit generate` (run in `packages/core`), then `bun run build:migrations` to regenerate `migrations.manifest.ts`
- Create: `packages/core/src/provider-model-catalog/{index.ts, provider-model-catalog.ts, provider-model-catalog.test.ts}`; export from `packages/core/src/index.ts`

**Interfaces:**
- Table `provider_model_catalog`: `provider_id text PK`, `source_digest text not null`, `models_json text` (nullable), `refreshed_at integer` (nullable), `failure_code text` (nullable), `failed_at integer` (nullable). No foreign keys.
- Produces:
  ```ts
  export type ProviderModelCatalogFailureCode = 'CATALOG_UNAVAILABLE' | 'CATALOG_UNSUPPORTED';
  export type StoredProviderModels = {
    readonly sourceDigest: string;
    readonly models: readonly string[] | null;
    readonly refreshedAt: number | null;
    readonly failure: { readonly code: ProviderModelCatalogFailureCode; readonly at: number } | null;
  };
  export type ProviderModelCatalogRepository = {
    readonly read: (providerId: string) => StoredProviderModels | null;
    /** Replaces models, sets refreshedAt, clears failure. */
    readonly writeSuccess: (providerId: string, sourceDigest: string, models: readonly string[], refreshedAt: number) => void;
    /** Records the failure. When sourceDigest differs from the stored row, models/refreshedAt are reset to null. */
    readonly writeFailure: (providerId: string, sourceDigest: string, code: ProviderModelCatalogFailureCode, at: number) => void;
  };
  export function createProviderModelCatalogRepository(sqlite: Database): ProviderModelCatalogRepository;
  ```

- [ ] **Step 1: Write failing tests** against `openDb({ home: mkdtempSync(...) }).sqlite`:
  - `read returns null for an unknown Provider ID`.
  - `writeSuccess then read round-trips the model list and clears a prior failure`.
  - `writeFailure keeps the last good models for the same source digest` → models unchanged, `failure.code === 'CATALOG_UNAVAILABLE'`.
  - `writeFailure under a new source digest drops the old models` → `models === null`, `sourceDigest` updated.
- [ ] **Step 2:** `bun test packages/core/src/provider-model-catalog` → FAIL.
- [ ] **Step 3: Implement** schema, migration, repository (`sqlite.query(...)` prepared statements, `INSERT ... ON CONFLICT(provider_id) DO UPDATE`, models encoded with `JSON.stringify`).
- [ ] **Step 4:** `bun run --filter @aio-proxy/core test` → PASS (includes `migrations.test.ts`).
- [ ] **Step 5: Commit** `feat(core): store discovered Provider model catalogs`.

---

### Task 3: Shared model discovery

**Files:**
- Create: `packages/server/src/provider-model-discovery/{index.ts, provider-model-discovery.ts, provider-model-discovery.test.ts}`
- Modify: `packages/server/src/dashboard-routes/provider-draft/provider-draft-operations.ts` — move the api branch of `loadProviderDraftCatalog`, `loadAiSdkDraftCatalog`, `catalogEntryIds`, `catalogHeaders`, `geminiCatalog`, `catalogPath`, `catalogPage`, `stringProperty`, `booleanProperty`, `catalogModels` into the new module. `loadProviderDraftCatalog` keeps its OAuth `catalog_unsupported` branch, calls `discoverProviderModels(state.currentConfig(), provider, AbortSignal.timeout(5_000), { strict: false })`, and maps `{ ok: false, code }` to the existing `failure(code)` wire shape (`{ ok: false, error: { code, recoverable: true } }`).

**Interfaces:**
- Produces:
  ```ts
  export type ProviderModelDiscovery =
    | { readonly ok: true; readonly models: readonly string[] }
    | { readonly ok: false; readonly code: 'catalog_unsupported' | 'catalog_unavailable' };
  export function discoverProviderModels(
    config: Config,
    provider: ApiProvider | AiSdkProvider,
    signal: AbortSignal,
    options: { readonly strict: boolean },
  ): Promise<ProviderModelDiscovery>;
  ```
  Returns upstream order, de-duplicated. `strict: false` is today's draft behavior (malformed rows skipped). `strict: true` returns `catalog_unavailable` when any row lacks a non-blank string ID, a present pagination field (`nextPageToken`, `has_more`, `last_id`) has the wrong type, or `listModels` returns a non-array. The `api` branch materializes `materializeProviders({ ...config, invalidProviders: [], providers: [{ ...provider, enabled: true }] })` — `materializeProviders` skips disabled Providers, and a manual refresh must reach one.

- [ ] **Step 1: Write failing tests** against a `Bun.serve({ port: 0 })` fake:
  - `pages an Anthropic catalog through has_more` → two pages, `{ ok: true, models: ['a', 'b'] }`.
  - `returns catalog_unavailable on a 503`.
  - `strict discovery rejects a page with one malformed row` → `data: [{ id: 'a' }, { id: 42 }]`: strict `{ ok: false, code: 'catalog_unavailable' }`, lenient `{ ok: true, models: ['a'] }`.
  - `discovers a disabled Provider` → `enabled: false` still returns the fake's list.
- [ ] **Step 2:** `bun test packages/server/src/provider-model-discovery` → FAIL.
- [ ] **Step 3: Implement** by moving code; no behavior change for the draft endpoint.
- [ ] **Step 4:** `bun test packages/server/src/provider-model-discovery packages/server/src/dashboard-routes/provider-draft` → PASS (existing draft tests unchanged).
- [ ] **Step 5: Commit** `refactor(server): share upstream model discovery`.

---

### Task 4: Storage-agnostic catalog job descriptor

**Files:**
- Modify: `packages/server/src/plugin-runtime/types.ts` (`CatalogJobDescriptor`)
- Create: `packages/server/src/plugin-runtime/catalog-job.ts` — `oauthCatalogJob(...)` building the OAuth descriptor; called from `materialize.ts` `catalogJobFor` (keeps `materialize.ts` from growing)
- Modify: `packages/server/src/catalog-scheduler/catalog-scheduler.ts` (`#runOnce`, `CatalogSchedulerOptions` drops `repository` and `diagnostics`)
- Modify: `packages/server/src/server-state/index.ts:216` (scheduler construction)
- Modify: `packages/server/src/catalog-scheduler/*.test.ts` (construct descriptors in the new shape)
- Modify: `packages/server/src/plugin-runtime/catalog.test.ts:157-159` (no more `plugin` / `capability` / `accountRuntimeRevision` on the descriptor: assert instead that the job's commit is fenced off after the account's runtime revision moves)

**Interfaces:**
- Produces:
  ```ts
  export type CatalogJobDescriptor = {
    readonly providerId: string;
    readonly enabled: boolean;
    readonly policy: { readonly kind: 'static' } | { readonly kind: 'ttl'; readonly ttlMs: number };
    readonly stored: { readonly refreshedAt: number; readonly revision: number } | null;
    readonly unavailableOccurredAt?: number;
    /** Discovers and returns the synchronous commit for that result. Throws on discovery failure. */
    readonly discover: (signal: AbortSignal) => Promise<CatalogCommit>;
    /** Records a failed discovery. Returns true when stored state changed and the snapshot must rebuild. */
    readonly markUnavailable: (error: unknown) => boolean;
  };
  /** Returns false when the write was fenced off. */
  export type CatalogCommit = () => boolean;
  ```
- `#runOnce`: `const commit = await Promise.race([discover(signal), aborted])`; if `!#current || signal.aborted` → `'failed'`; `commit()` synchronously; then request `rebuild('catalog')` with no `await` between the commit and the request (today's ordering — an async commit would let a concurrent config commit install a snapshot built from the old list and replace the job before the rebuild is requested).
- OAuth `discover`: records `startedAt = Date.now()`, `catalog = validateModelCatalog(await adapter.catalog.discover(...))`, returns `() => repository.compareAndSwapCatalog({ ..., catalog, startedAt, refreshedAt: Date.now() }).ok`. OAuth `markUnavailable`: `repository.writeCatalogUnavailableIfCurrent({..., diagnostic: diagnostics('CATALOG_UNAVAILABLE', { providerId, retryable: true }) })`.
- Scheduler semantics otherwise unchanged: `dueAt` (including `max(catalogDue, retryDue)`), single flight, timeout, retry, rebuild retry, `refreshNow`.

- [ ] **Step 1: Write failing tests** in `catalog-scheduler.failure.test.ts`:
  - `an aborted refresh commits nothing` — `discover` awaits a deferred; `replaceJobs([])` while pending; resolve with a commit spy; spy not called, `rebuild` not called.
  - `the rebuild is requested in the same turn as the commit` — `rebuild` spy records whether the commit spy had already run and that no microtask separated them (commit sets a flag; a `queueMicrotask` scheduled inside the commit must not have run when `rebuild` is called).
- [ ] **Step 2:** `bun test packages/server/src/catalog-scheduler` → FAIL (type/shape mismatch).
- [ ] **Step 3: Implement** the descriptor change, update the five scheduler test files' fixtures, and move the OAuth closures into `catalog-job.ts`.
- [ ] **Step 4:** `bun test packages/server/src/catalog-scheduler packages/server/src/plugin-runtime packages/server/src/dashboard-routes` → PASS.
- [ ] **Step 5: Commit** `refactor(server): make catalog jobs storage-agnostic`.

---

### Task 5: Synced Providers in the snapshot

**Files:**
- Create: `packages/server/src/provider-model-sync/{index.ts, provider-model-sync.ts, provider-model-sync.test.ts}`
- Modify: `packages/server/src/server-state/snapshot.ts` (`buildSnapshot` takes the repository; injects models; merges jobs, states, `catalogLastSuccessAt`)
- Modify: `packages/server/src/server-state/types.ts` / `lifecycle.ts` / `index.ts` (`ServerRuntime.providerModels: ProviderModelCatalogRepository`, created from `dbHandle.sqlite`; pass to both `buildSnapshot` calls)
- Modify: `packages/server/src/model-routing/inventory.ts` (`syntheticSource` uses `syncedModels` for synced Providers; `createModelRoutingControlPlane` gets the repository)

**Interfaces:**
- Consumes: `ProviderModelCatalogRepository` (Task 2), `discoverProviderModels` (Task 3), `CatalogJobDescriptor` (Task 4).
- Produces:
  ```ts
  export const SYNCED_MODELS_TTL_MS = 60 * 60_000;
  export function isSyncedProvider(provider: Provider): provider is (ApiProvider | AiSdkProvider) & { syncModels: true };
  export function modelSourceDigest(provider: ApiProvider | AiSdkProvider): string; // sha256 (Bun.CryptoHasher) of JSON {kind, protocol, baseURL, mode} of apiProviderEndpoints(provider)[0], or {kind, packageName, baseURL: options.baseURL}; never credentials
  /** Stored list for the current source digest minus excludedModels, sorted; undefined when none. */
  export function syncedModels(provider: ApiProvider | AiSdkProvider, stored: StoredProviderModels | null): readonly string[] | undefined;
  export type SyncedProviderResolution = {
    readonly providers: readonly Provider[];               // synced ones with `models` injected, others unchanged
    readonly jobs: readonly CatalogJobDescriptor[];
    readonly states: ReadonlyMap<string, ProviderState>;
    readonly lastSuccessAt: ReadonlyMap<string, string>;    // ISO
  };
  export function resolveSyncedProviders(
    config: Config,
    repository: ProviderModelCatalogRepository,
    diagnostics: DiagnosticFactory,
  ): SyncedProviderResolution;
  ```
- Job `discover`: `discoverProviderModels(config, provider, signal, { strict: true })`; `ok: false` → throw an `Error` carrying the code; empty list → throw; else return `() => { repository.writeSuccess(id, digest, uniq(models).toSorted(), Date.now()); return true; }`. The job's `enabled` is the configured value. `markUnavailable(error)`: `writeFailure(id, digest, code, Date.now())` with `code = 'CATALOG_UNSUPPORTED'` for `catalog_unsupported`, else `'CATALOG_UNAVAILABLE'`; returns `true`.
- States: never `unavailable` (the routing inventory marks `unavailable` ineligible while the router still routes aliases). No list for the digest, or list + failure → `{ status: 'ready', catalog: 'stale', diagnostic }` with the stored failure code, or `CATALOG_UNAVAILABLE` before any attempt; list, no failure → `{ status: 'ready', catalog: 'fresh' }`.
- Injected arrays are copied (`[...models]`) into mutable `Provider`/`Config` shapes; no type assertions.
- `buildSnapshot`: `nonOAuth.providers` passed to `materializeProviders` and `resolveCatalogModalities` come from `resolution.providers`; `configWithExtend` (the snapshot's `config`) stays authored. `assembleProviders` uses `resolution.states` over the default `ready`, and summaries of synced Providers get `catalogLastSuccessAt`. `catalogJobs` = OAuth jobs + `resolution.jobs`.

- [ ] **Step 1: Write failing tests** in `provider-model-sync.test.ts`, end to end through `createServerState` (`#server-test-lifecycle`, `dbHome` in a temp dir) with a `Bun.serve({ port: 0 })` OpenAI-style `/v1/models` fake whose response the test mutates, an `api` Provider `relay` with `syncModels: true`, and `listModels(state)` from `server/list-models`:
  Provider config in every case: `{ kind: 'api', protocol: 'openai-compatible', baseURL: fake.url, syncModels: true }`; ids are read with `(await listModels(state)).data.map((row) => row.id)`.
  - `a newly discovered model becomes routable without a config edit` — fake lists `['m-1']`; `await state.refreshProviderCatalog('relay')` → `'refreshed'`; fake lists `['m-1', 'm-2']`; refresh again; ids contain `'m-2'`; `state.currentConfig().providers[0].models` is `undefined`.
  - `an upstream outage removes no route` — after a good refresh, fake answers 503; refresh → `'failed'`; ids unchanged; summary state `{ status: 'ready', catalog: 'stale' }` with `CATALOG_UNAVAILABLE`.
  - `empty discovery keeps the last good list` — fake answers `{ data: [] }`; same assertions as the outage.
  - `source digest change hides the stored list` — commit config with a different `baseURL` (fake down); `m-1` no longer listed; state `ready` + `catalog: 'stale'` + `CATALOG_UNAVAILABLE`. Same for switching the same URL from top-level `protocol`/`baseURL` to `endpoints: [{ protocol, baseURL }]`.
  - `first discovery failure keeps aliases eligible` — fake down from the start, `alias: { fast: { model: 'm-1' } }`; `fast` listed; `state.modelRouting` inventory row for `fast` has `effective.eligible === true`.
  - `a disabled synced Provider refreshes manually but never on a timer` — `enabled: false`; `refreshProviderCatalog` → `'refreshed'`; the fake's hit count does not grow afterwards with a short TTL override.
  - `excluded model stays reachable through an alias` — `excludedModels: ['m-1']`, `alias: { fast: { model: 'm-1' } }`; ids contain `fast`, not `m-1`.
  - `static models are unchanged` — Provider with `models: ['x']` and no `syncModels`: no catalog job for it (`__test.onCatalogJobsReplaced` spy), the fake is never hit, ids `['x']`.
  - `ids are listed in sorted order` — fake lists `['b', 'a']`; ids `['a', 'b']`.
- [ ] **Step 2:** `bun test packages/server/src/provider-model-sync` → FAIL.
- [ ] **Step 3: Implement** the module and wiring.
- [ ] **Step 4:** `bun run --filter @aio-proxy/server test` → PASS.
- [ ] **Step 5: Commit** `feat(server): keep synced Provider model lists in step with upstream`.

---

### Task 6: Dashboard API for synced Providers

**Files:**
- Modify: `packages/server/src/dashboard-routes/provider-routes/provider-routes.ts` (`readEditView`)
- Modify: `packages/server/src/server-state/types.ts`, `lifecycle.ts` (`syncedProviderEditView`)
- Test: `packages/server/src/dashboard-routes/provider-routes/provider-routes.edit-view-catalog.test.ts`

**Interfaces:**
- Produces: `ServerState.syncedProviderEditView(providerId: string): { readonly models: readonly string[]; readonly refreshedAt?: string } | undefined` — the stored list for the current source digest **before** `excludedModels` (the editor needs hidden rows to un-hide them), `undefined` for non-synced Providers.
- Edit view response gains `sync?: { models: readonly string[]; refreshedAt?: string }`. `refreshCatalog` runs `state.refreshProviderCatalog(id)` for OAuth **and** synced Providers; `catalogRefreshed` semantics unchanged. `readEditView` reads `provider`, `oauth`, `sync`, and `routing` **after** the refresh, and answers 404 if the Provider is gone by then.
- `testProviderDraft` (`provider-draft-operations.ts`): for a synced draft, eligibility = `discoverProviderModels(..., { strict: false })` result minus the draft's `excludedModels` (`model_not_enabled` otherwise); the one-model test Provider is parsed with `syncModels` and `excludedModels` removed.

- [ ] **Step 1: Write failing tests:**
  - `POST edit-view refreshes a synced api Provider` — fixture as Task 5; POST `/providers/relay/edit-view` → `catalogRefreshed: true`, `sync.models` equals the fake's list, `sync.refreshedAt` is an ISO string; GET on a static Provider has no `sync`.
  - `draft test accepts a discovered model of a synced draft` (in `provider-draft.test.ts`) — synced draft, fake lists `['m-1']`, test `m-1` → not `model_not_enabled`; `excludedModels: ['m-1']` → `model_not_enabled`.
- [ ] **Step 2:** run the test file → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `bun test packages/server/src/dashboard-routes/provider-routes` → PASS.
- [ ] **Step 5: Commit** `feat(server): expose synced model catalogs to the dashboard`.

---

### Task 7: Dashboard sync mode

**Files:**
- Create: `packages/dashboard/src/modules/providers/components/provider-editor/models-section/models-sync-switch.tsx` (switch + last-refreshed line)
- Modify: `models-section.tsx` — treat `discoveryMode = kind === OAuth || syncModels === true` wherever the OAuth branch is chosen today (field `excludedModels`, `oauthEditorExposedModels`, refresh via `fetchProviderEditView(id, { refreshCatalog: true })` reading `data.sync?.models` for synced, no manual add). Keep the file under 400 lines; put switching logic in the new component.
- Modify: `packages/dashboard/src/modules/providers/templates/provider-editor-page/provider-editor-page.tsx:57-61,146` (candidates = `oauth?.models ?? sync?.models ?? probe result`; preview and testable models use `oauthEditorExposedModels` when `syncModels`)
- Modify: `packages/dashboard/src/modules/providers/templates/provider-editor-page/use-provider-editor-page.ts` (471 lines — must not grow: extract the exposure/section-status inputs it builds at lines ~387-403 into a helper under `lib/` that also covers synced Providers) and `packages/dashboard/src/routes/providers/$id.edit.tsx` (seed `syncModels`, `excludedModels`, `sync`)
- Modify: `use-provider-editor-form.ts` (`ProviderEditorInitial.syncModels?: boolean`; seed `excludedModels: []` for synced api/ai-sdk)
- Modify: `packages/dashboard/src/modules/providers/lib/alias-editor/alias-editor.ts` callers — in sync mode pass the full discovered list (not the exposed list) as the alias-target set
- Modify: `packages/dashboard/src/modules/providers/lib/section-status/section-status.ts` (synced Providers count exposed models like OAuth)
- Modify: `packages/i18n/messages/*.json` (`dashboard.providers.form.models_sync_label` "Sync with upstream", `models_sync_hint` "New upstream models are added automatically; hide the ones you don't want.", `models_sync_refreshed_at` "Last refreshed {time}", `models_sync_never` "Not refreshed yet")
- Test: `models-section.test.tsx`

**Interfaces:**
- Consumes: edit view `sync` (Task 6), draft catalog mutation (`useProviderCatalogMutation`).
- The draft probe result is page-level state (lifted from the section into `use-provider-editor-page.ts`'s existing candidate flow) because the preview, section status, and test panel all read it.
- Switch on: run the draft catalog mutation; on `ok: false` **or an empty list** keep the switch off and toast `catalog_failed` (code, or `catalog_unavailable` for empty); on success set `syncModels: true`, `models: []`, `excludedModels: []`, candidates = probe result.
- Switch off: `models` = `uniq([...oauthEditorExposedModels(discovered, excludedModels), ...aliasTargetModels(alias).filter((id) => discovered.includes(id))])`; unset `syncModels` and `excludedModels`.
- Refresh button: persisted refresh (`fetchProviderEditView(id, { refreshCatalog: true })`, reading `sync.models`) only when the Provider is saved with `syncModels: true` and the form's `protocol`/`baseURL`/`endpoints`/`packageName`/`options.baseURL` equal the initial values; otherwise the draft probe.

- [ ] **Step 1: Write failing tests:**
  - `switching to sync probes the catalog and saves syncModels` — mocked catalog `{ ok: true, models: ['a', 'b'] }`; form values `syncModels === true`, `models` `[]`.
  - `switch stays off when the catalog is unsupported` — mocked `{ ok: false, error: { code: 'catalog_unsupported' } }`; `syncModels` not true; error toast shown.
  - `hiding a discovered model writes excludedModels` — synced initial with candidates `['a','b']`; untick `b` → `excludedModels` `['b']`.
  - `switching to manual seeds models from exposed models and alias targets` — synced, candidates `['a','b','c']`, `excludedModels: ['b','c']`, alias `fast → b`; switch off → `models` `['a','b']`, no `syncModels`, no `excludedModels`; the resulting body passes `ProviderMutationBodySchema`.
  - `an alias may target a hidden model in sync mode` — candidates `['a','b']`, `excludedModels: ['b']`, alias `fast → b` → no `target-missing` issue.
  - `switch stays off on an empty catalog` — mocked `{ ok: true, models: [] }`.
  - `refresh uses the draft probe after the base URL changes` — saved synced Provider, edit `baseURL`, click refresh → draft catalog endpoint called, edit-view POST not called.
  - `editor page saves a synced Provider` (page-level test) — the PUT body carries `syncModels: true` and `excludedModels`.
  - `shows when the catalog was last refreshed` — `refreshedAt` set → text matches the formatted time.
- [ ] **Step 2:** `bun run --filter @aio-proxy/dashboard test -- models-section` → FAIL.
- [ ] **Step 3: Implement** following `packages/dashboard/AGENTS.md` (shared `@aio-proxy/ui` `Switch`, typed Hono client types, state owned by the section).
- [ ] **Step 4:** `bun run --filter @aio-proxy/dashboard test` → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): switch Providers between static and synced models`.

---

### Task 8: Docs and changeset

**Files:**
- Modify: `README.md`, `README.zh-Hans.md` (Provider config section: `syncModels`, `excludedModels`, mutual exclusion with `models`, first refresh behavior, 1-hour refresh)
- Modify: `website/docs/en/guide/providers/api/*.md`, `website/docs/zh/guide/providers/api/*.md`, `website/docs/{en,zh}/guide/providers/ai-sdk-providers.md` (ai-sdk: requires `listModels` or `options.baseURL`)
- Create: `.changeset/*.md` via `bun changeset` — `minor` for `aio-proxy`, `@aio-proxy/types`, `@aio-proxy/core`, `@aio-proxy/server`, `@aio-proxy/dashboard`, `@aio-proxy/i18n` (only the packages actually touched). Body, one paragraph ≤ 5 lines, e.g. "API and AI SDK Providers can set `syncModels: true` to follow the upstream model list: new upstream models become routable within an hour (or on a manual refresh in the Dashboard) without editing the config, an upstream outage keeps the last good list, and `excludedModels` hides models you don't want. A hand-written `models` list works as before."

- [ ] **Step 1:** Write the docs and changeset.
- [ ] **Step 2:** `bun run build` then `bun run preflight` → PASS; also `bun run lint:types` after the build.
- [ ] **Step 3: Commit** `docs: document syncModels`.
