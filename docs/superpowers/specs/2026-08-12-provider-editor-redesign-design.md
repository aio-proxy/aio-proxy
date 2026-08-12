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

Current shells (`templates/provider-form-page.tsx` 216, `templates/oauth-provider-create-page.tsx` 171, `templates/oauth-provider-edit-page.tsx` 112, `templates/use-oauth-provider-edit-page.ts` 162) collapse into one directory that respects the 400/500-line rule:

```
modules/providers/templates/provider-editor-page/
  index.ts                          exports only
  provider-editor-page.tsx          layout, section nav, footer, save/delete
  sections/identity-section.tsx
  sections/connection-section.tsx   switches on kind, delegates to existing field components
  sections/models-section.tsx
  sections/routing-section.tsx
  sections/advanced-section.tsx
  rail/exposure-panel.tsx
  rail/model-validation-panel.tsx
  lib/section-status.ts             pure: (values, issues) -> per-section status
  lib/model-rows.ts                 pure: models[] x metadata{} <-> row objects
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
| `todo` | A required field is empty: provider id, api key, package name, oauth capability. Or an alias targets a model outside a non-empty whitelist, which the schema rejects outright | Yes |
| `attention` | Saveable but suspect: the weight ties another provider serving the same model, or a whitelist entry is no longer in the discovered catalog | No |
| `ok` | Neither | No |

An alias whose target is outside the whitelist is **not** a soft warning. `validateAliasTargets` (`packages/types/src/provider-alias.ts:38-45`) raises a Zod issue on `['alias', <name>, 'model']`, so the mutation returns 400. The UI must therefore block save and restrict the alias target picker to whitelisted models rather than letting the user save into a rejected state.

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

The weight slider is a `slider.tsx` added to `packages/ui/src/components/` through the registry already configured in `packages/ui/components.json` (style `base-rhea`, base color `olive`, `@reui` registry), not hand-copied from the prototype. It wraps `@base-ui/react/slider`, and `@base-ui/react` is already a `packages/ui` dependency, so this adds no package.

The attempt-order preview needs no new endpoint. `DashboardProviderSummarySchema` already carries `weight` (`packages/types/src/dashboard/dashboard.ts:26`) and `clientModels` (`:29`), so the page computes "other providers serving these models, descending by weight" from the provider list it already fetches. The preview states plainly that session affinity can override weight order, matching the routing contract in `CLAUDE.md`.

Alias editing moves inline. `components/provider-alias/provider-alias-drawer.tsx` (126) and `components/provider-alias/use-alias-drafts.ts` (100) are deleted: without a drawer there is no draft to stage, no dirty check, and no commit step. Rows write the form immediately. `provider-alias-config-fields.tsx` (157), `provider-alias-variants.tsx` (143), and `provider-alias-list.tsx` (107) are reused inside the inline rows.

The prototype's `exposedRoutes()` helper is discarded: the exposure panel must call the same `modelRoutes()` the server uses to compute `clientModels`, or the panel and the router will disagree. That function lives in `packages/core/src/router.ts:94` and `packages/dashboard` does not depend on `@aio-proxy/core` (`packages/dashboard/package.json:18-23`), and should not — the core root export pulls in server-only modules.

So `modelRoutes` and its two private helpers `directModelIds`/`preservedModelIds` move into `@aio-proxy/types`, next to `validateAliasTargets` in `provider-alias.ts`, which already owns the same domain logic (`collectPreservedModels`, `targetModels`). `packages/core/src/router.ts` re-exports `modelRoutes` so no core consumer changes. The dashboard imports it from `@aio-proxy/types`, which it already depends on.

That colocation makes the near-duplication between `preservedModelIds` and `collectPreservedModels` visible. Consolidating them is a follow-up, not part of this change.

## OAuth Creation: Two Stages, One Shell

OAuth creation is not a form save, and the prototype does not model this. In `templates/oauth-provider-create-page.tsx:56-72` the submit action is `startOAuthSession()`, which opens a popup and runs a device-code / authorize-url / loopback state machine. The provider id is generated server-side as `session.providerId`; the user never types it. At creation time `providerPatch` carries only `enabled` and `proxy`, so weight, aliases, model whitelist, and transforms have nowhere to be stored until the account exists.

The shell therefore has an authorization stage:

- Before authorization, sections 3-5 render disabled with the reason "authorization required", and the primary button is Authorize, not Save. Sections 1 and 2 are live: kind, plugin capability, account fields, proxy.
- Section 1 shows no id field for a new oauth provider, because the server assigns it.
- On `session.status === 'succeeded'` the page does not navigate. It adopts `session.providerId`, refetches the edit view, and unlocks sections 3-5 in place. The primary button becomes Save.
- This replaces the current `navigate({ to: '/providers', search: { focus: session.providerId } })`. The `warning` currently forwarded in that search param must surface in the rail instead, or it is lost.
- Failed and cancelled sessions keep the current popup cleanup (`closeUnclaimedPopup`) and leave the page in the authorization stage.

`/providers/new` becomes `/providers/$id/edit` for the adopted id via a history replace, so a reload after authorization lands on the saved provider rather than an empty create page.

## Backend Changes

Each of the six changes below was verified against the current source.

### 1. OAuth providers gain a model whitelist

`modelsField` is defined at `packages/types/src/provider.ts:67-69` and spread into the api and ai-sdk shapes, but not into `OAuthPluginProviderSchema` (`:104-112`). Add it there, and add `models` to `OAuthProviderMutationBodySchema` (`:218-228`) and `DashboardOAuthProviderPatchSchema` (`packages/types/src/dashboard-oauth.ts:67-74`).

### 2. The whitelist filters the runtime catalog

`packages/server/src/plugin-runtime/capabilities.ts:97` currently exposes every discovered model:

```ts
models: catalog.language.map(({ id }) => id),
```

It becomes the intersection of the discovered catalog with `config.models`, applied at both places the runtime provider's `models` is set: `createRuntimeProvider` (fresh materialization) and `withRoutingConfig` (`capabilities.ts:60-68`, the cached path, which today overlays only `enabled`/`alias`/`configMetadata`). Missing either one makes the whitelist silently depend on cache state.

An absent or empty whitelist means expose everything, which keeps every existing oauth config working unchanged. Ids in the whitelist that are no longer in the catalog are dropped, so a stale whitelist cannot create dead routes.

No router change is needed. `directModelIds` (`packages/core/src/router.ts:104`) reads `'models' in provider ? provider.models ?? [] : []` — a structural check, not a kind check — so the oauth runtime provider participates the moment it carries `models`.

### 3. Runtime identity must *not* include the whitelist

`runtimeIdentity` (`packages/server/src/plugin-runtime/materialize.ts:212-224`) hashes `catalogDigest` and credential inputs. Adding `modelsDigest` to it would be the obvious move and is wrong: identity equality is exactly what selects the cheap path at `materialize.ts:232-246`, where `options.previous?.identity === identity` reuses the existing credentials and catalog and only re-applies `withRoutingConfig`. A whitelist edit is a pure routing change, so it must keep identity stable and flow through that path — no credential rebuild, no re-discovery, no upstream call to change which models are exposed.

This is why change 2 has to touch `withRoutingConfig` and not just `createRuntimeProvider`. Do one or the other, never both.

### 4. Catalog capability follows base URL, not kind

`packages/server/src/dashboard-routes/provider-draft/provider-draft-operations.ts:26` rejects every ai-sdk draft:

```ts
if (provider.kind === ProviderKind.AiSdk) return failure('catalog_unsupported');
```

Removing that line is not enough. The existing catalog loader (`:22-52`) resolves the upstream through `runtime.raw?.resolve({ protocol: provider.protocol, ... })` and parses the response with `catalogPath(protocol)` / `catalogPage(protocol, payload)` (`:136-159`). Neither input exists for ai-sdk: `materialize.ts:68-82` builds ai-sdk runtimes with a `model` capability only and no `raw`, and ai-sdk config has no `protocol` field at all.

The ai-sdk path is therefore separate, and narrow by design:

- Read `baseURL` and `apiKey` off the free-form `options` record (`provider.ts:126-141` types it as `z.record(z.string(), z.unknown())`, so both are conventional `@ai-sdk/openai-compatible` keys, not schema fields).
- Fetch `baseURL` + `catalogPath(ProviderProtocol.OpenAICompletions)` directly, honoring the provider proxy, and parse with `catalogPage(ProviderProtocol.OpenAICompletions, ...)`.
- A non-string `baseURL` keeps returning `catalog_unsupported`. A base URL that does not answer the OpenAI `{ data: [{ id }] }` shape returns a new `catalog_unavailable` code, so "this package cannot list models" reads differently from "this endpoint failed".

Any ai-sdk package whose upstream is not OpenAI-shaped is out of scope; it lands on `catalog_unavailable` and the user types model ids manually, exactly as today.

### 5. OAuth drafts can be tested

`DashboardProviderDraftSchema` (`packages/types/src/dashboard-provider-draft/dashboard-provider-draft.ts:7-10`) is a discriminated union of api and ai-sdk only. Add an oauth branch so the rail's model test works for oauth providers.

The blocker is one line earlier in the flow: `provider-draft-resolution.ts:58-61` returns `persisted_provider_mismatch` for *any* provider whose persisted config parses as oauth, before credentials are ever considered. That early return has to admit oauth drafts. An oauth draft is always backed by a persisted account, so it resolves credentials by `persistedProviderId`; a draft naming an id with no persisted account keeps failing with `persisted_provider_mismatch`. The `fresh_credentials_required` code does not apply here — oauth never carries draft credentials.

### 6. Empty `models` must stop invalidating aliases

`validateAliasTargets` (`packages/types/src/provider-alias.ts:33-49`) builds `new Set(provider.models)` whenever `models` is not `undefined`, then requires every alias target to be in it. With `models: []` the set is empty, so **every** alias becomes invalid — a provider that exposes nothing directly and everything through aliases cannot be saved, even though `directModelIds` supports exactly that shape.

Change the guard to skip the target check when `models` is empty as well as when it is absent, matching the router's reading of `[]`.

This is a prerequisite for change 1, not an unrelated fix. Adding `models` to `OAuthProviderMutationBodySchema` puts oauth providers under `validateAliasTargets` for the first time, since `ProviderMutationBodySchema.superRefine(validateAliasTargets)` (`provider.ts:230-238`) applies to the whole union. Without this fix, the first oauth provider saved with an empty whitelist and any alias starts returning 400 on a payload that used to succeed.

## Internationalization

Five locales (`en`, `zh-Hans`, `zh-Hant`, `ja`, `ko`) in `packages/i18n/messages/*.json`, 869-870 keys each, 341 of them under `dashboard.providers.*`.

- Rename `dashboard.providers.editor.step_{connection,models,routing,validate,invalid}` to `section_*`, and add `section_identity` and `section_advanced`.
- Retire `dashboard.providers.oauth.models_readonly` ("Models are discovered by the OAuth provider and cannot be edited manually"), which the whitelist makes false.
- Reword `form.metadata_description` and `form.metadata_json_label`/`metadata_json_error`, which currently assert the editor is JSON-only.
- Add roughly 30 keys across all five locales: section names and descriptions, status labels, the blocking-section footer, the authorization stage, the exposure panel, the attempt-order preview, and the metadata visual tab.

There is no locale parity check in the repository, and the store has already drifted: `zh-Hant`, `ja`, and `ko` are missing `dashboard.providers.oauth.authorize_url_title`, and all three carry two keys absent from `en` (`cli.upgrade.daemon_running_hint`, `cli.upgrade.option_restart_description`). Adding 30 keys by hand into that state will drift again, so this change adds a test in `packages/i18n/__tests__` asserting all five locales have identical key sets, and fixes those three discrepancies to make it pass.

## Test Accounting

`modules/providers` currently holds 9217 lines of implementation and 4480 lines of tests.

| Test | Lines | Fate |
|---|---|---|
| `templates/provider-stepper-import.test.tsx` | 263 | Delete; the stepper is gone |
| `templates/oauth-provider-create-page.test.tsx` | 220 | Rewrite against the authorization stage |
| `templates/oauth-provider-edit-page.test.tsx` | 256 | Rewrite against the unified shell |
| `components/providers-table/providers-table.test.tsx` | 357 | Update; the create menu no longer carries a kind |
| `components/provider-validate-step/provider-validate-step.test.tsx` | 86 | Update; the step becomes the rail panel |
| `lib/alias-editor/alias-editor.drafts.test.ts` | 107 | Delete with the draft layer |
| `lib/alias-editor/alias-editor.issues.test.ts` | 59 | Keep; issue computation is unchanged |
| `lib/oauth-provider-edit/oauth-provider-edit.test.ts` | 88 | Extend with whitelist round-tripping |
| `components/provider-form-fields-api.test.tsx` | 290 | Keep; connection fields are unchanged |
| request-transform suite | ~1400 | Untouched |

New tests, each protecting a user-visible outcome rather than restating structure:

- `lib/section-status.test.ts`: a missing api key yields `todo` and blocks save; an alias pointing outside a non-empty whitelist also yields `todo`, because the schema would reject it; a stale whitelist entry yields `attention` and does not block.
- `lib/model-rows.test.ts`: rows round-trip without dropping metadata for alias-only models or unrecognized metadata fields.
- `packages/types/src/provider-alias`: an alias-only provider with `models: []` passes validation; an alias outside a non-empty whitelist still fails.
- `plugin-runtime/capabilities`: an empty whitelist exposes the whole catalog; a whitelist intersects it; a whitelist entry absent from the catalog is dropped. Asserted on both the fresh and the `withRoutingConfig` path, since only one of them is exercised by a cached edit.
- `plugin-runtime/materialize`: changing only the whitelist leaves `runtimeIdentity` unchanged, so the edit takes the cached routing path instead of rebuilding credentials.
- `provider-draft-operations`: an ai-sdk draft with `options.baseURL` lists models; one without still returns `catalog_unsupported`; one whose endpoint is not OpenAI-shaped returns `catalog_unavailable`.
- `packages/i18n/__tests__/`: all five locales share one key set. That directory is already scanned by `test:unit` (`packages/i18n/package.json:17`) and is the right home, since the assertion is over `messages/*.json` rather than a source module.

## Non-Goals

- No models.dev HTTP proxy route. The prototype's `/dashboard/api/proxy` is not ported; `packages/core/src/models-dev` already caches the catalog.
- No new endpoint for the attempt-order preview; the provider summary already carries `weight` and `clientModels`.
- No change to `/providers/:id/edit-view`. It already returns the redacted full config alongside the oauth view (`packages/server/src/dashboard-routes/provider-routes.ts:25-39`), so `name`, `weight`, and `protocol` are present in one fetch today.
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
- Adding `models` to the oauth mutation body silently enrolls oauth providers in `validateAliasTargets`. Backend change 6 is what keeps that from turning previously valid payloads into 400s; shipping change 1 without it is a regression, not a missing feature.
- Deleting the alias draft layer removes conflict detection at commit time. Inline rows must surface the same `alias-editor` issues immediately, or a conflicting alias reaches submit and fails there instead.

