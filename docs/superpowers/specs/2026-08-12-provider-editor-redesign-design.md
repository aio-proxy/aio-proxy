# Provider Editor Redesign Design

## Goal

Replace the three separate provider authoring surfaces (the 4-step api/ai-sdk stepper, the oauth create page, the oauth edit page) with one single-page editor whose section list is identical for all three provider kinds, and close the backend gaps that currently make that page impossible to build: oauth providers cannot carry a model whitelist, ai-sdk providers cannot list a catalog, and oauth providers cannot participate in draft model validation.

The reference prototype is `.reference/provider-editor` (3326 lines under `src/prototype`, gitignored, outside the worktree). It models a saved provider only; every place this spec departs from it is called out.

## Scope

- One page shell, five fixed sections, one right rail. Provider kind changes only the inside of the connection section.
- Route entry becomes `/providers/new` (in-page kind picker) plus `/providers/$id/edit`. `/providers/new/$kind` is deleted, not redirected.
- Backend changes ship in the same change as the frontend, because the page cannot be built without them.
- Request-transform editing, provider-options schema resolution, and workflow install keep their current implementations; they only move into the advanced section as-is.
- No new upstream dependency and no new HTTP proxy route. `@base-ui/react` and the cached models.dev catalog already cover the two new controls.

## Decisions Already Settled

| # | Decision |
|---|---|
| 1 | One shell for all three kinds; five sections always present in the same order |
| 2 | Weight control is a slider plus a real attempt-order preview |
| 3 | Right rail is always visible: exposure list plus model validation |
| 4 | Section status badges are persistent; only `todo` blocks save, `attention` does not |
| 5 | Alias editing moves inline into the routing section; per-model metadata stays in a drawer, gaining a visual tab beside the JSON tab |
| 6 | Kind is picked in-page; `/providers/new/$kind` is removed |
| 7 | OAuth creation is a two-stage flow inside the same shell, unlocking in place after authorization |

## Page Shell

```
+- section nav ---+- main (max-w-6xl) --------------+- rail (18rem) -+
| 1 Identity   ok | 1 Identity  kind / id / name    | Exposure list  |
| 2 Connection  * | 2 Connection  <- only kind fork | (modelRoutes)  |
| 3 Models      ! | 3 Models    rows/filter/add     | ---------------|
| 4 Routing    ok | 4 Routing   weight + aliases    | Model test     |
| 5 Advanced   ok | 5 Advanced  headers/proxy/xform |                |
+-----------------+---------------------------------+----------------+
  ok = valid    * = todo (blocks save)    ! = attention (does not)
```

The footer lists every `todo` section as a clickable jump target and disables save while any exists. `attention` appears only on the section badge and in the rail.

### File Layout

Current shells (`templates/provider-form-page.tsx` 216, `templates/oauth-provider-create-page.tsx` 171, `templates/oauth-provider-edit-page.tsx` 112, `templates/use-oauth-provider-edit-page.ts` 162) collapse into the layout below. It is constrained by three rules in `packages/dashboard/AGENTS.md`: a module holds only the six listed subdirectories (`:67`), each `.tsx` declares exactly one component (`:80`), and `lib` entries use same-name-directory grouping (`:75`). So the section components are `components/`, not a nested folder under `templates/`, and the pure logic is module-level `lib/`:

```
modules/providers/
  templates/provider-editor-page/
    index.ts                        exports only
    provider-editor-page.tsx        layout + save/delete orchestration only
    section-nav.tsx
    editor-footer.tsx
  components/provider-editor/
    identity-section.tsx
    connection-section.tsx          switches on kind, delegates to existing field components
    models-section.tsx
    routing-section.tsx
    advanced-section.tsx
    exposure-panel.tsx
    model-validation-panel.tsx
  lib/section-status/               index.ts + section-status.ts + section-status.test.ts
  lib/model-rows/                   index.ts + model-rows.ts + model-rows.test.ts
```

No leaf field component is rewritten. The three kind-specific files already delegate to per-concern children, and `ProviderCommonFields` already takes `section: 'connection' | 'routing'` (`components/provider-common-fields.tsx:15`), so the split this redesign needs partly exists:

| Leaf component | Moves to section |
|---|---|
| `ProviderCommonFields section="connection"` | Identity |
| `ProviderCommonFields section="routing"`, `ProviderAliasFields`, `OAuthProviderAliasFields` | Routing |
| protocol / `baseURL` / `apiKey` fields, `OAuthAccountFields` | Connection |
| `ProviderModelsField` internals | Models |
| `ProviderProxyField`, `ProviderHeadersField`, `ProviderRequestTransformsFormField` | Advanced |

What shrinks is the three kind-specific wrappers: `provider-form-fields-api.tsx` (146), `provider-form-fields-ai-sdk.tsx` (161), and `oauth-provider-edit-fields.tsx` (153) stop being whole-form layouts and keep only their connection-section fields. The new `sections/*.tsx` files own layout and re-parent the leaves listed above.

`components/reui/stepper.tsx` loses its only consumer. Leave the component in place; deleting it is a separate cleanup.

## Form State and Validation

`hooks/use-provider-form.ts` (136), `hooks/use-oauth-provider-form.ts`, and `hooks/use-oauth-provider-edit-form.ts` collapse into one `use-provider-editor-form` holding a kind-discriminated value shape.

Section status is a pure function in `lib/section-status.ts`, not a boolean living in the hook. The current `stepInvalid` only materializes when the user presses Next, which is exactly the feedback timing this redesign removes.

| Status | Meaning | Blocks save |
|---|---|---|
| `todo` | A field the mutation schema requires is empty, or an alias targets a model outside a non-empty whitelist, which the schema rejects outright | Yes |
| `attention` | Saveable but suspect: the weight ties another provider serving the same model, or a whitelist entry is no longer in the discovered catalog | No |
| `ok` | Neither | No |

The required set is taken from the mutation schema, not from what looks mandatory:

| Field | Required | Source |
|---|---|---|
| provider id | Yes, on POST and PUT | `provider.ts:158` |
| `baseURL` | Yes for `api` | `provider.ts:176`, `z.url()` with no `.optional()` |
| `packageName` | Effectively yes for `ai-sdk`, but defaulted to `@ai-sdk/openai-compatible` | `provider.ts:126-141` |
| `apiKey` | **No** | `provider.ts:86` and `:166`, `z.string().optional()` |
| oauth capability | Yes, at authorization time | `dashboard-oauth.ts` |

`apiKey` must not be a `todo`. It is optional in the schema and the current stepper does not demand it, so requiring it would stop an unauthenticated local endpoint such as Ollama from being saved — a behavior regression. `baseURL` is the field that is genuinely required and was missing from this list; without it in the table, an empty base URL does not block save and instead fails silently at schema parse on submit.

`apiKey` also carries edit-time semantics the old stepper hid: `""` means "retain the stored key" server-side (`provider.ts:158`). The single page always renders the field, so it must show that an empty box on an existing provider keeps the current key rather than clearing it.

It must **not** offer a clear affordance. `provider-mutation.ts:103-108` restores the previous key whenever the incoming `apiKey` is absent or `""`, and stores any non-empty string verbatim, so the mutation has no clear path at all — a client-side sentinel such as `'<clear>'` would be saved as the API key. Clearing a stored key is out of scope for this change; adding it means a real server-side flag, not a client convention.

An alias whose target is outside the whitelist is **not** a soft warning. `validateAliasTargets` (`packages/types/src/provider-alias.ts:38-45`) raises a Zod issue on `['alias', <name>, 'model']`, and `validateVariants` (`:51`) does the same for every variant target, so the mutation returns 400. The UI must therefore block save and restrict the alias target picker to whitelisted models rather than letting the user save into a rejected state.

Alias target issues already exist as data (`lib/alias-editor/alias-editor.ts:178`); they move from drawer-time validation to inline row errors that also raise the section to `todo`.

`models[]` semantics differ per kind, and the difference is load-bearing:

| Kind | `models` absent or `[]` | `models` non-empty |
|---|---|---|
| `api`, `ai-sdk` | No direct routes; only aliases are exposed | Exactly those models are exposed |
| `oauth` | Every discovered model is exposed | The intersection with the discovered catalog |

`directModelIds` (`packages/core/src/router.ts:104`) treats absent and `[]` identically — as "no direct models" — so "empty means everything" is **not** a router convention. For oauth it is realized by populating the runtime provider's `models` with the discovered catalog (`plugin-runtime/capabilities.ts:97`), which the router then sees as an explicit list. An implementer who unifies the two readings breaks either oauth backward compatibility or api routing.

## Models Section

Three current entry points mutate the same `models[]` (catalog grid, enabled list, `TagsInput` in `components/provider-models-field/provider-models-field.tsx`, 162 lines). They collapse into one row list with a filter, a count, and a single manual-add input.

`lib/model-rows.ts` joins `models: string[]` with `metadata: Record<ModelId, ModelMetadata>` into row objects and splits them back on submit. The round trip must preserve metadata keys for models that are not in `models[]` (metadata may legitimately describe an aliased-only model), and must not drop unrecognized metadata fields.

Candidate sources, by kind. Catalog capability is decided by whether a base URL exists, never by provider kind:

| Kind | Candidates |
|---|---|
| `api` | Draft catalog (already works) |
| `ai-sdk` | Draft catalog, when `options.baseURL` is a string and answers an OpenAI-shaped `/v1/models` (backend change 4) |
| `oauth` | The plugin-discovered catalog already returned by `oauthProviderEditView` (`packages/server/src/server-state/oauth-views.ts:41`) |

### Metadata Drawer

`components/provider-models-field/provider-model-metadata-drawer-content.tsx` (74) gains a tab strip:

- Visual tab: `extend` combobox, `limit`, `cost`, `capabilities`.
- JSON tab: the current textarea, unchanged in behavior.

`ModelMetadataSchema` is `.loose()` (`packages/types/src/model-metadata/model-metadata.ts:142`), so unknown keys survive parsing and must survive editing. The visual tab renders a count of fields it does not know about and states that they are editable only in the JSON tab. The visual tab must merge its output over the existing object rather than replacing it.

`extend` is already a first-class field (`model-metadata.ts:135`) resolved server-side by `packages/server/src/server-state/resolve-extend/`. Its combobox candidates come from the models.dev catalog that `packages/core/src/models-dev` already caches on disk with a 6h TTL. Add `GET /dashboard/api/models-dev/slugs` reading that cache; the Hono RPC client derives the type, so no manual type plumbing is needed. A cold cache returns an empty list and the combobox says so; it never blocks the drawer. The prototype's `/dashboard/api/proxy` fetch of `https://models.dev/model-schema.json` is not ported.

## Routing Section

The weight slider is added to `packages/ui/src/components/` with `bun x --bun --no-install shadcn add slider --overwrite` run from `packages/ui`, per `AGENTS.md:17` and the registry in `packages/ui/components.json`. It wraps `@base-ui/react/slider`, already a `packages/ui` dependency, so this adds no package.

Its range is the prototype's: `min=0`, `max=100`, `step=5`, disabled while the provider is disabled. But `weight` is `z.number().optional()` with no bounds (`provider.ts:61`), so a stored `500`, `-3`, or `2.5` is valid config the slider cannot represent. The control must not rewrite a value the user did not touch: an out-of-range or off-step weight is displayed as-is and only snaps to the grid once the user drags. Absent weight stays absent rather than being written as `0` — not because they order differently (they do not: the single ordering point is `providers.sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0))` at `packages/types/src/config/config.ts:185`, so absent coalesces to `0`), but because the editor must not rewrite config the user did not touch. The attempt-order preview mirrors that same `?? 0` rule and needs no re-sort: `snapshot.ts:229` builds the summary list by walking `config.providers`, which config load already ordered, and `probe.ts:19` filters without reordering. The one caveat is the head of that list — `snapshot.ts:217-228` prepends `config.invalidProviders`, which are not weight-ordered. They carry `clientModels: []`, so the preview's own "serves one of these models" filter drops them before order matters.

The attempt-order preview needs no new endpoint. `DashboardProviderSummarySchema` already carries `weight` (`packages/types/src/dashboard/dashboard.ts:26`) and `clientModels` (`:29`), so the page computes "other providers serving these models, descending by weight" from the provider list it already fetches. The preview states plainly that session affinity can override weight order, matching the routing contract in `CLAUDE.md`.

Alias editing moves inline, but only the drawer goes away. `components/provider-alias/provider-alias-drawer.tsx` (126) is deleted, along with its only two callers, `provider-alias/provider-alias-fields.tsx` and `oauth-provider-alias-fields.tsx`, which the routing section replaces.

`use-alias-drafts.ts` (100) **survives**. The draft layer is not the drawer's staging mechanism — it exists because a not-yet-named alias cannot be a key in the `alias` record, and because renaming has to reject duplicates. `useAliasDrafts(alias, onAliasChange)` takes no drawer state and the drawer is a pure pass-through (`provider-alias-drawer.tsx:43`, then `:73-88`), so the routing section calls the hook directly and renders `ProviderAliasList` with the same props, unchanged. What dies with the drawer is the sheet itself, the close-time `clearDrafts`, and the dirty-discard confirm; `discardOpen`/`hasDirtyDrafts` become unread and are trimmed only if that costs no change to `ProviderAliasList`.

Rows therefore write the form as soon as an alias has a name. `provider-alias-list.tsx` (107), `provider-alias-card.tsx`, `provider-alias-draft.tsx`, `provider-alias-config-fields.tsx` (157), and `provider-alias-variants.tsx` (143) are all reused as-is.

The prototype's `exposedRoutes()` helper is discarded: the exposure panel must call the same `modelRoutes()` the server uses to compute `clientModels`, or the panel and the router will disagree. That function lives in `packages/core/src/router.ts:94` and `packages/dashboard` does not depend on `@aio-proxy/core` (`packages/dashboard/package.json:18-23`), and should not — the core root export pulls in server-only modules.

So `modelRoutes` and its two private helpers `directModelIds`/`preservedModelIds` move into `@aio-proxy/types`, next to `validateAliasTargets` in `provider-alias.ts`, which already owns the same domain logic (`collectPreservedModels`, `targetModels`). `packages/core/src/router.ts` re-exports `modelRoutes` so no core consumer changes. The dashboard imports it from `@aio-proxy/types`, which it already depends on.

That colocation makes the near-duplication between `preservedModelIds` and `collectPreservedModels` visible. Consolidating them is a follow-up, not part of this change.

## OAuth Creation: Two Stages, One Shell

OAuth creation is not a form save, and the prototype does not model this. In `templates/oauth-provider-create-page.tsx:56-72` the submit action is `startOAuthSession()`, which opens a popup and runs a device-code / authorize-url / loopback state machine.

Two facts force the split, and neither is "the fields have nowhere to go" — `DashboardOAuthProviderPatchSchema` (`packages/types/src/dashboard-oauth.ts:67-74`) already accepts `name`, `weight`, `alias`, `proxy`, and `transforms`:

- The provider id is generated server-side as `session.providerId`. The user never types it, so section 1 cannot show an id field before authorization, and nothing can be patched before an id exists.
- The model whitelist's candidate list comes from plugin discovery, which needs credentials. Section 3 has nothing to offer until the account exists — not because `models` cannot be stored, but because the choices are unknown.

The shell therefore has an authorization stage:

- Before authorization, sections 3-5 render disabled with the reason "authorization required", and the primary button is Authorize, not Save. Sections 1 and 2 are live: kind, plugin capability, account fields, proxy.
- Section 1 shows no id field for a new oauth provider, because the server assigns it.
- On `session.status === 'succeeded'` the page does not navigate. It adopts `session.providerId`, refetches the edit view, and unlocks sections 3-5 in place. The primary button becomes Save.
- This replaces the current `navigate({ to: '/providers', search: { focus: session.providerId } })`. The `warning` currently forwarded in that search param must surface in the rail instead, or it is lost.
- Failed and cancelled sessions keep the current popup cleanup (`closeUnclaimedPopup`) and leave the page in the authorization stage.

`/providers/new` becomes `/providers/$id/edit` for the adopted id via a history replace, so a reload after authorization lands on the saved provider rather than an empty create page.

Re-authorization on an existing provider needs the same treatment. `use-oauth-provider-edit-page.ts` leaves the page in two places today: `:97` after a save and `:119-126` after a re-authorize session succeeds, both navigating to `/providers` with `focus` and an optional `warning`. In the single page neither navigates. A save stays put and shows a saved indicator; a successful re-authorize refetches the edit view in place. Both surface `session.warning` in the rail, which is the only place it can go once the list is no longer the destination.

## Backend Changes

Each of the six changes below was verified against the current source.

### 1. OAuth providers gain a model whitelist

`modelsField` is defined at `packages/types/src/provider.ts:67-69` and spread into the api and ai-sdk shapes, but not into `OAuthPluginProviderSchema` (`:104-112`). Add it there, and add `models` to `OAuthProviderMutationBodySchema` (`:218-228`) and `DashboardOAuthProviderPatchSchema` (`packages/types/src/dashboard-oauth.ts:67-74`).

### 2. The whitelist filters the runtime catalog

`packages/server/src/plugin-runtime/capabilities.ts:97` currently exposes every discovered model:

```ts
models: catalog.language.map(({ id }) => id),
```

It becomes the intersection of the discovered catalog with `config.models`, extracted into one exported helper — `exposedModelIds(catalog, config.models)` — so the rule lives in exactly one place. Two call sites use it:

- `createRuntimeProvider` (`:70+`), which already has `catalog` in scope.
- `withRoutingConfig` (`:60-68`), which does not. It currently overlays only `enabled`/`alias`/`configMetadata` onto the cached provider, and its `models` rides along untouched inside `...previousProvider` — already filtered by whatever whitelist was in effect when the runtime was built, so it cannot be re-filtered. The signature gains a third parameter carrying the unfiltered catalog: both callers (`materialize.ts:233` and `:244`) have `storedCatalog` in scope and pass `storedCatalog.catalog`, the same value `createRuntimeProvider` receives.

Both call sites must use the helper. Missing `withRoutingConfig` makes the whitelist silently depend on cache state: it would apply on a cold start and be ignored on every subsequent edit.

An absent or empty whitelist means expose everything, which keeps every existing oauth config working unchanged. Ids in the whitelist that are no longer in the catalog are dropped, so a stale whitelist cannot create dead routes.

No router change is needed. `directModelIds` (`packages/core/src/router.ts:104`) reads `'models' in provider ? provider.models ?? [] : []` — a structural check, not a kind check — so the oauth runtime provider participates the moment it carries `models`.

### 3. Runtime identity must *not* include the whitelist

`runtimeIdentity` (`packages/server/src/plugin-runtime/materialize.ts:212-224`) hashes `catalogDigest` and credential inputs. Adding `modelsDigest` to it would be the obvious move and is wrong: identity equality is exactly what selects the cheap path at `materialize.ts:232-246`, where `options.previous?.identity === identity` reuses the existing credentials and catalog and only re-applies `withRoutingConfig`. A whitelist edit is a pure routing change, so it must keep identity stable and flow through that path — no credential rebuild, no re-discovery, no upstream call to change which models are exposed.

To be unambiguous about the two decisions: the intersection goes into **both** functions named in change 2, and `modelsDigest` goes into **neither** `runtimeIdentity` nor any other identity input. Adding it to identity while also filtering in `withRoutingConfig` is not belt-and-braces; it defeats the cheap path the filtering exists to preserve.

### 4. Catalog capability follows base URL, not kind

`packages/server/src/dashboard-routes/provider-draft/provider-draft-operations.ts:26` rejects every ai-sdk draft:

```ts
if (provider.kind === ProviderKind.AiSdk) return failure('catalog_unsupported');
```

Removing that line is not enough. The existing catalog loader (`:22-52`) resolves the upstream through `runtime.raw?.resolve({ protocol: provider.protocol, ... })` and parses the response with `catalogPath(protocol)` / `catalogPage(protocol, payload)` (`:136-159`). Neither input exists for ai-sdk: `materialize.ts:68-82` builds ai-sdk runtimes with a `model` capability only and no `raw`, and ai-sdk config has no `protocol` field at all.

The ai-sdk path is therefore separate, and narrow by design:

- Read `baseURL` and `apiKey` off the free-form `options` record (`provider.ts:126-141` types it as `z.record(z.string(), z.unknown())`, so both are conventional `@ai-sdk/openai-compatible` keys, not schema fields).
- Fetch `${options.baseURL}/models` directly, honoring the provider proxy, and parse with `catalogPage(ProviderProtocol.OpenAICompatible, ...)`. Not `baseURL + catalogPath(...)`: `catalogPath()` returns the inbound request path that the api raw capability rewrites (`provider-draft-operations.ts:36` builds `http://provider-draft.invalid/v1/models`), never a suffix appended to a base URL — and ai-sdk base URLs already carry their version segment (`https://host/v1`, the same convention `@ai-sdk/openai-compatible` appends `/chat/completions` to), so concatenating `catalogPath()` would produce `/v1/v1/models`.
- A non-string `baseURL` keeps returning `catalog_unsupported`. A base URL that does not answer the OpenAI `{ data: [{ id }] }` shape returns a new `catalog_unavailable` code, so "this package cannot list models" reads differently from "this endpoint failed".

Any ai-sdk package whose upstream is not OpenAI-shaped is out of scope; it lands on `catalog_unavailable` and the user types model ids manually, exactly as today.

### 5. OAuth drafts can be tested

`DashboardProviderDraftSchema` (`packages/types/src/dashboard-provider-draft/dashboard-provider-draft.ts:7-10`) is a discriminated union of api and ai-sdk only. Add an oauth branch so the rail's model test works for oauth providers. Three layers stand in the way, and the third is a design decision, not a type widening.

**Resolution.** `provider-draft-resolution.ts:58-61` returns `persisted_provider_mismatch` for any provider whose persisted config parses as oauth, before credentials are ever considered. That early return has to admit oauth. `fresh_credentials_required` does not apply — oauth never carries draft credentials — and a draft naming an id with no persisted entry keeps failing earlier, at `:39`, with `persisted_provider_not_found`.

Admitting oauth at `:58-61` is necessary but not sufficient. The non-identity-changed merge path at `:46-50` runs the candidate through `replaceProvider`, whose carry-over list is exactly `headers`, `metadata`, `proxy`, `transforms`, `alias`, and `apiKey` (`provider-mutation.ts:91-110`). `plugin` and `capability` are not on it, so an oauth candidate loses both and fails `ProviderSchema.safeParse` — landing back on `persisted_provider_mismatch` with the early return already fixed. The oauth branch must merge through `replaceOAuthProvider` (`provider-mutation.ts:115`) instead.

**Signatures.** `Exclude<Provider, { kind: ProviderKind.OAuth }>` appears on `testProviderDraft` (`:55`), `materializeDraftRuntime` (`:98`), `materializeDraft` (`:109`), and `withDraftAttempt` (`:115`). Only `testProviderDraft` and `withDraftAttempt` widen to `Provider`; the oauth path branches at the top of `testProviderDraft`, so the materialization helpers keep their `Exclude` types accurately — they stay reachable only for api and ai-sdk. The oauth bail at `:62` is runtime-unreachable after the entry branch but type-load-bearing: `testProvider` is re-parsed from `ProviderSchema.parse` (type `Provider`), and this check is what narrows it for the `materializeDraftRuntime` call. It stays, with a comment saying why.

**Where the runtime comes from.** This is the real gap. `materializeDraftRuntime` calls `materializeProviders({ ...state.currentConfig(), providers: [provider] })` and reads `runtime.providers[0]` and `runtime.probes.get(id)`. For oauth, `provider-runtime/materialize.ts:167-170` pushes only a summary — no runtime instance, no probe — so that call throws `'draft provider materialization failed'`. OAuth runtimes are built asynchronously in `plugin-runtime` from stored credentials and a catalog job. Two options, and the spec picks one:

The oauth test **borrows the live runtime instance from the plugin-runtime snapshot** by provider id, rather than materializing a throwaway. It does not re-materialize, so `ProviderSchema.parse({ ...provider, models: [modelId] })` at `:61` does not apply to the oauth path.

That choice is not a compromise, because an oauth provider cannot exist unsaved: the account is created by authorization, so by the time a model can be tested the credentials are already persisted. The only unsaved fields are routing ones, and none of them affect whether the account can reach a model. The one real limitation is that an unsaved draft `transforms.request` is not exercised, unlike api and ai-sdk where the whole draft is materialized — the rail must say the oauth test checks the saved account. Falling back to one-shot materialization would mean driving plugin auth and catalog discovery from a test button, which can refresh and rewrite stored credentials as a side effect of a read-only action.

**The enablement gate.** `testProviderDraft:58` reads `if (!provider.models?.includes(modelId)) return failure('model_not_enabled')`. Under change 2 an oauth provider with an empty whitelist exposes everything, so this gate would reject every model on exactly the configs that are most common. It becomes a check against the *effective* exposed set — the runtime provider's `models` after `exposedModelIds` — which is unchanged for api and ai-sdk (their runtime `models` is their config `models`) and correct for oauth. That reorders the function: resolve the runtime first, then gate, then probe.

### 6. Empty `models` must stop invalidating aliases, on both sides

`validateAliasTargets` (`packages/types/src/provider-alias.ts:33-49`) builds `new Set(provider.models)` whenever `models` is not `undefined`, then requires every alias target to be in it. With `models: []` the set is empty, so **every** alias becomes invalid — a provider that exposes nothing directly and everything through aliases cannot be saved, even though `directModelIds` supports exactly that shape. `validateVariants` (`:51`) receives the same set and has the same behavior for variant targets.

Change the guard to skip the target check when `models` is empty as well as when it is absent, matching the router's reading of `[]`.

The dashboard has an independent copy of this rule that must change in the same commit. `aliasEditorIssues` (`modules/providers/lib/alias-editor/alias-editor.ts:165`) computes `models === undefined ? undefined : new Set(models)` and flags `target-missing` from it, at `:182` for the alias target and `:195` for each variant target. Fixing only the server produces the mirror image of the bug this change closes: the server accepts the payload and the editor refuses to submit it, because section status treats alias issues as blocking `todo`. Both guards move to the same "absent or empty means no whitelist" rule.

This is also a prerequisite for change 1, not an unrelated fix. Adding `models` to `OAuthProviderMutationBodySchema` puts oauth providers under `validateAliasTargets` for the first time, since `ProviderMutationBodySchema.superRefine(validateAliasTargets)` (`provider.ts:230-238`) applies to the whole union. Without this fix, the first oauth provider saved with an empty whitelist and any alias starts returning 400 on a payload that used to succeed.

## Internationalization

Five locales (`en`, `zh-Hans`, `zh-Hant`, `ja`, `ko`) in `packages/i18n/messages/*.json`, 869-870 keys each, 341 of them under `dashboard.providers.*`.

- Rename `dashboard.providers.editor.step_{connection,models,routing,validate,invalid}` to `section_*`, and add `section_identity` and `section_advanced`.
- Retire `dashboard.providers.oauth.models_readonly` ("Models are discovered by the OAuth provider and cannot be edited manually"), which the whitelist makes false.
- Reword `form.metadata_description` and `form.metadata_json_label`/`metadata_json_error`, which currently assert the editor is JSON-only.
- Add roughly 30 keys across all five locales: section names and descriptions, status labels, the blocking-section footer, the authorization stage, the exposure panel, the attempt-order preview, and the metadata visual tab.

There is no locale parity check in the repository, and the store has already drifted: `zh-Hant`, `ja`, and `ko` are missing `dashboard.providers.oauth.authorize_url_title`, and all three carry two keys absent from `en` (`cli.upgrade.daemon_running_hint`, `cli.upgrade.option_restart_description`). Adding 30 keys by hand into that state will drift again, so this change adds a test in `packages/i18n/__tests__` asserting all five locales have identical key sets, and fixes those three discrepancies to make it pass.

## Test Accounting

`modules/providers` holds 9092 lines of implementation and 4480 lines of tests, with a further 125 lines under `routes/providers/` that the module count excludes.

| Test | Lines | Fate |
|---|---|---|
| `templates/provider-stepper-import.test.tsx` | 263 | Delete; the stepper is gone |
| `templates/oauth-provider-create-page.test.tsx` | 220 | Rewrite against the authorization stage |
| `templates/oauth-provider-edit-page.test.tsx` | 256 | Rewrite against the unified shell, including stay-in-place re-authorize |
| `components/providers-table/providers-table.test.tsx` | 357 | Update; the create menu no longer carries a kind |
| `components/provider-validate-step/provider-validate-step.test.tsx` | 86 | Update; the step becomes the rail panel |
| `lib/alias-editor/alias-editor.drafts.test.ts` | 107 | Delete with the draft layer |
| `lib/alias-editor/alias-editor.issues.test.ts` | 59 | Update; change 6 alters `target-missing` for empty `models` |
| `lib/oauth-provider-edit/oauth-provider-edit.test.ts` | 88 | Extend with whitelist round-tripping |
| `components/provider-form-fields-api.test.tsx` | 290 | Update; the component keeps only connection fields, so assertions on models, alias, and transforms move to the new section tests |
| request-transform suite | ~1400 | Untouched |

New tests, each protecting a user-visible outcome rather than restating structure:

- `lib/section-status/section-status.test.ts`: an empty `baseURL` on an `api` provider yields `todo` and blocks save; an empty `apiKey` does **not**, so an unauthenticated local endpoint stays saveable; an alias pointing outside a non-empty whitelist yields `todo`; a stale whitelist entry yields `attention` and does not block.
- `lib/model-rows/model-rows.test.ts`: rows round-trip without dropping metadata for alias-only models or unrecognized metadata fields.
- `packages/types/src/provider-alias`: an alias-only provider with `models: []` passes validation, including variant targets; an alias outside a non-empty whitelist still fails.
- `lib/alias-editor`: `aliasEditorIssues` reports no `target-missing` for `models: []`, matching the server. This is the paired assertion that keeps the two guards from drifting.
- `plugin-runtime/capabilities`: an empty whitelist exposes the whole catalog; a whitelist intersects it; a whitelist entry absent from the catalog is dropped. Asserted through both `createRuntimeProvider` and `withRoutingConfig`, since a cached edit only exercises the second.
- `plugin-runtime/materialize`: changing only the whitelist leaves `runtimeIdentity` unchanged, so the edit takes the cached routing path instead of rebuilding credentials.
- `provider-draft-operations`: an ai-sdk draft with `options.baseURL` lists models; one without still returns `catalog_unsupported`; one whose endpoint is not OpenAI-shaped returns `catalog_unavailable`. An oauth draft with an empty whitelist can test a discovered model rather than failing `model_not_enabled`.
- `packages/i18n/__tests__/`: all five locales share one key set. That directory is already scanned by `test:unit` (`packages/i18n/package.json:17`) and is the right home, since the assertion is over `messages/*.json` rather than a source module.

## Non-Goals

- No models.dev HTTP proxy route. The prototype's `/dashboard/api/proxy` is not ported; `packages/core/src/models-dev` already caches the catalog.
- No new endpoint for the attempt-order preview; the provider summary already carries `weight` and `clientModels`.
- No change to `/providers/:id/edit-view`. It already returns the redacted full config alongside the oauth view (`packages/server/src/dashboard-routes/provider-routes.ts:25-39`), so `name` and `weight` are present in one fetch today.
- No changes to request-transform editing, `components/provider-options-editor.tsx` schema resolution, or workflow install. They move containers only.
- No deletion of `components/reui/stepper.tsx`, even though it loses its last consumer.
- No consolidation of `preservedModelIds` and `collectPreservedModels`, which end up in the same file.
- No metadata visual editor for fields outside `extend`, `limit`, `cost`, and `capabilities`; the JSON tab covers the rest.
- No support for ai-sdk packages whose upstream does not expose an OpenAI-shaped `/v1/models`.

## Release

The change spans `@aio-proxy/types`, `@aio-proxy/core`, `server`, `@aio-proxy/ui`, `@aio-proxy/i18n`, and `packages/dashboard`, none of which publish release notes on their own. The changeset must therefore also target `aio-proxy` at the same bump level, or the note is written into a CHANGELOG that `scripts/release.ts` skips. The oauth model whitelist is a new user-facing config field, so the bump is `minor`.

## Risks

- The authorization stage is the only place where one shell must model two different submit semantics. If adopting `session.providerId` in place proves unstable, the fallback is the current navigate-to-list behavior, which is a footer change rather than a redesign.
- `models[]` now means two different things depending on kind: the exposed set for api and ai-sdk, a filter over a discovered catalog for oauth. The models section must word this difference explicitly — "all 47 discovered" versus an explicit subset — or an oauth user will read an empty list as "nothing exposed" and an api user will read it as "everything".
- Adding `models` to the oauth mutation body silently enrolls oauth providers in `validateAliasTargets`. Backend change 6 is what keeps that from turning previously valid payloads into 400s; shipping change 1 without it is a regression, not a missing feature. The same fix must land on `aliasEditorIssues`, or the block simply moves from the server to the submit button.
- The oauth model test checks the saved account, not the draft. A user who edits a request transform and immediately tests a model gets a pass or fail that ignores the edit. Wording in the rail is the whole mitigation; the alternative drives plugin auth from a test button.
- Deleting the alias draft layer removes conflict detection at commit time. Inline rows must surface the same `alias-editor` issues immediately, or a conflicting alias reaches submit and fails there instead.

