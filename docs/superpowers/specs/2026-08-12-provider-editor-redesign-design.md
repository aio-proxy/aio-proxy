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

The connection section reuses `components/provider-form-fields-api.tsx` (146), `components/provider-form-fields-ai-sdk.tsx` (161), and `components/oauth-provider-edit-fields.tsx` (153) unchanged. None of the three is rewritten.

`components/reui/stepper.tsx` loses its only consumer. Leave the component in place; deleting it is a separate cleanup.

## Form State and Validation

`hooks/use-provider-form.ts` (136), `hooks/use-oauth-provider-form.ts`, and `hooks/use-oauth-provider-edit-form.ts` collapse into one `use-provider-editor-form` holding a kind-discriminated value shape.

Section status is a pure function in `lib/section-status.ts`, not a boolean living in the hook. The current `stepInvalid` only materializes when the user presses Next, which is exactly the feedback timing this redesign removes.

| Status | Meaning | Blocks save |
|---|---|---|
| `todo` | A required field is empty: provider id, api key, package name, oauth capability | Yes |
| `attention` | Saveable but suspect: an alias targets a model outside the whitelist, or the weight ties another provider serving the same model | No |
| `ok` | Neither | No |

Alias target issues already exist as data (`lib/alias-editor/alias-editor.ts:178`); they move from drawer-time validation to inline row errors that also raise the section to `attention`.

## Models Section

Three current entry points mutate the same `models[]` (catalog grid, enabled list, `TagsInput` in `components/provider-models-field/provider-models-field.tsx`, 162 lines). They collapse into one row list with a filter, a count, and a single manual-add input.

`lib/model-rows.ts` joins `models: string[]` with `metadata: Record<ModelId, ModelMetadata>` into row objects and splits them back on submit. The round trip must preserve metadata keys for models that are not in `models[]` (metadata may legitimately describe an aliased-only model), and must not drop unrecognized metadata fields.

Candidate sources, by kind. Catalog capability is decided by whether a base URL exists, never by provider kind:

| Kind | Candidates |
|---|---|
| `api` | Draft catalog (already works) |
| `ai-sdk` | Draft catalog, when `options.baseURL` is present |
| `oauth` | The plugin-discovered catalog already returned by `oauthProviderEditView` (`packages/server/src/server-state/oauth-views.ts:41`) |

### Metadata Drawer

`components/provider-models-field/provider-model-metadata-drawer-content.tsx` (74) gains a tab strip:

- Visual tab: `extend` combobox, `limit`, `cost`, `capabilities`.
- JSON tab: the current textarea, unchanged in behavior.

`ModelMetadataSchema` is `.loose()` (`packages/types/src/model-metadata/model-metadata.ts:142`), so unknown keys survive parsing and must survive editing. The visual tab renders a count of fields it does not know about and states that they are editable only in the JSON tab. The visual tab must merge its output over the existing object rather than replacing it.

`extend` is already a first-class field (`model-metadata.ts:135`) resolved server-side by `packages/server/src/server-state/resolve-extend/`. Its combobox candidates come from the models.dev catalog that `packages/core/src/models-dev` already caches on disk with a 6h TTL. Add `GET /dashboard/api/models-dev/slugs` reading that cache; the Hono RPC client derives the type, so no manual type plumbing is needed. A cold cache returns an empty list and the combobox says so; it never blocks the drawer. The prototype's `/dashboard/api/proxy` fetch of `https://models.dev/model-schema.json` is not ported.

## Routing Section

The weight slider is `slider.tsx` copied from the prototype into `packages/ui/src/components/`. It is `@base-ui/react/slider`, and `@base-ui/react` is already a `packages/ui` dependency, so this adds no package.

The attempt-order preview needs no new endpoint. `DashboardProviderSummarySchema` already carries `weight` (`packages/types/src/dashboard/dashboard.ts:26`) and `clientModels` (`:29`), so the page computes "other providers serving these models, descending by weight" from the provider list it already fetches. The preview states plainly that session affinity can override weight order, matching the routing contract in `CLAUDE.md`.

Alias editing moves inline. `components/provider-alias/provider-alias-drawer.tsx` (126) and `components/provider-alias/use-alias-drafts.ts` (100) are deleted: without a drawer there is no draft to stage, no dirty check, and no commit step. Rows write the form immediately. `provider-alias-config-fields.tsx` (157), `provider-alias-variants.tsx` (143), and `provider-alias-list.tsx` (107) are reused inside the inline rows.

The prototype's `exposedRoutes()` helper is discarded. The exposure panel calls the real `modelRoutes()` from `packages/core/src/router.ts:94`, which is the same function the server uses to compute `clientModels`.

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

It becomes the intersection of the discovered catalog with `config.models`. An absent or empty whitelist means expose everything, which keeps every existing oauth config working unchanged. Ids in the whitelist that are no longer in the catalog are dropped, so a stale whitelist cannot create dead routes.

No router change is needed. `directModelIds` (`packages/core/src/router.ts:104`) reads `'models' in provider ? provider.models ?? [] : []` — a structural check, not a kind check — so the oauth runtime provider participates the moment it carries `models`.

### 3. Runtime identity must include the whitelist

`runtimeIdentity` (`packages/server/src/plugin-runtime/materialize.ts:212-224`) hashes `catalogDigest` but not the whitelist. Editing the whitelist would otherwise reuse a cached runtime with the old model set. Add `modelsDigest: digest(config.models ?? [])`.

### 4. Catalog capability follows base URL, not kind

`packages/server/src/dashboard-routes/provider-draft/provider-draft-operations.ts:26` rejects every ai-sdk draft:

```ts
if (provider.kind === ProviderKind.AiSdk) return failure('catalog_unsupported');
```

Replace the kind test with a base-URL test, so an ai-sdk provider configured with `options.baseURL` can list models and one without it still fails with `catalog_unsupported`.

### 5. OAuth drafts can be tested

`DashboardProviderDraftSchema` (`packages/types/src/dashboard-provider-draft/dashboard-provider-draft.ts:7-10`) is a discriminated union of api and ai-sdk only. Add an oauth branch so the rail's model test works for oauth providers. An oauth draft is always backed by a persisted account, so it uses `persistedProviderId` for credentials; a draft with no persisted account fails with the existing `fresh_credentials_required`.

### 6. The edit view returns the whole provider

`oauthProviderEditView` (`packages/server/src/server-state/oauth-views.ts:21-44`) returns only `accountLabel`, `publicValues`, `form`, and `models`. Its `models` is the plugin-discovered catalog, which is the candidate list the picker needs and is kept. `name`, `weight`, and `protocol` are missing, and `provider-routes.ts:37` currently patches around this by merging a separate summary. Extend `DashboardOAuthProviderEditSchema` (`packages/types/src/dashboard-oauth.ts:58-63`) with those fields and make `metadataProtocol()` non-private so one fetch of `/providers/:id/edit-view` populates the whole page.

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

- `lib/section-status.test.ts`: a missing api key yields `todo` and blocks save; an alias pointing outside the whitelist yields `attention` and does not.
- `lib/model-rows.test.ts`: rows round-trip without dropping metadata for alias-only models or unrecognized metadata fields.
- `plugin-runtime/capabilities`: an empty whitelist exposes the whole catalog; a whitelist intersects it; a whitelist entry absent from the catalog is dropped.
- `plugin-runtime/identity`: changing only the whitelist changes the runtime identity.
- `provider-draft-operations`: an ai-sdk draft with `options.baseURL` lists models; one without still returns `catalog_unsupported`.
- `packages/i18n/__tests__`: all five locales share one key set.

## Non-Goals

- No models.dev HTTP proxy route. The prototype's `/dashboard/api/proxy` is not ported; `packages/core/src/models-dev` already caches the catalog.
- No new endpoint for the attempt-order preview; the provider summary already carries `weight` and `clientModels`.
- No changes to request-transform editing, `components/provider-options-editor.tsx` schema resolution, or workflow install. They move containers only.
- No deletion of `components/reui/stepper.tsx`, even though it loses its last consumer.
- No metadata visual editor for fields outside `extend`, `limit`, `cost`, and `capabilities`; the JSON tab covers the rest.

## Release

The change spans `@aio-proxy/types`, `@aio-proxy/core`, `server`, `@aio-proxy/ui`, `@aio-proxy/i18n`, and `packages/dashboard`, none of which publish release notes on their own. The changeset must therefore also target `aio-proxy` at the same bump level, or the note is written into a CHANGELOG that `scripts/release.ts` skips. The oauth model whitelist is a new user-facing config field, so the bump is `minor`.

## Risks

- The authorization stage is the only place where one shell must model two different submit semantics. If adopting `session.providerId` in place proves unstable, the fallback is the current navigate-to-list behavior, which is a footer change rather than a redesign.
- Whitelist semantics are asymmetric by necessity: for oauth an empty whitelist means everything, because existing configs have none. The models section must therefore distinguish "all N discovered" from an explicit subset in its wording, or users will read an empty list as "nothing exposed".
- Deleting the alias draft layer removes conflict detection at commit time. Inline rows must surface the same `alias-editor` issues immediately, or a conflicting alias reaches submit and fails there instead.

