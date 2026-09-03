# OAuth model denylist and alias inherit

Date: 2026-09-03

## Problem

OAuth `models` is a whitelist over the discovered catalog. The dashboard snapshots the remaining catalog into `models` the first time a row is unchecked. After that, newly discovered upstream ids never appear.

Plugin `defaultAliases` are written into `providers.*.alias` on first login and catalog refresh. Users who only want plugin defaults still see those keys in the file. A later plugin default appears only after that write path runs.

## Goals

- OAuth exposure is a denylist. New catalog ids are exposed unless the user hid them.
- Plugin default aliases inherit at runtime. They do not need to be written into the file.
- The existing `alias` map is the override / hide layer on top of that inherit.
- Inherit is on unless the file turns it off. A key omitted from `alias` is not a hide.

## Non-goals

- Do not change api / ai-sdk `models` or their `alias` grammar.
- Do not auto-delete already-persisted plugin aliases.
- Do not keep a legacy OAuth `models` allowlist. Leftover `models` is ignored at runtime and at parse.
- Do not add `excludedAliases` or `syncPluginAliases`.

## Config

OAuth providers gain `excludedModels?: string[]`. Catalog ids in that list are hidden. Absent or empty hides nothing. Stale ids that left the catalog are ignored.

OAuth **does not consume** `models`. A leftover `models` key is stripped by the OAuth object schema (unknown keys already drop on `z.object`). Parse, `validateAliasTargets`, runtime exposure, and the draft Test gate all ignore it. A dashboard save omits it so it disappears from the file.

`alias` today lives on `SharedProviderSchemaBase` and is spread into api, oauth, and ai-sdk. OAuth **splits that field off**. api / ai-sdk keep `Record<string, AliasConfig>`. OAuth authored alias is a different type.

```yaml
providers:
  copilot:
    kind: oauth
    plugin: '@aio-proxy/plugin-copilot'
    excludedModels:
      - o1-preview
    alias:
      mini:
        model: gpt-5-mini
        preserve: true
      codex: false
      fast: gpt-5-nano
```

### Authored vs effective alias

| Type | Where | Value |
| --- | --- | --- |
| `AuthoredOAuthAlias` | OAuth config, mutation body, editor save | `Record<string, AliasConfig \| false>`, plus optional reserved key `*` |
| `ProviderAlias` | router, `createRuntimeProvider`, `withRoutingConfig`, exposure rail, `aliasEditorIssues` | `Record<string, AliasConfig>` only |

`false` and `*` exist only on the authored type. Resolve is the only place they are consumed. Downstream must not grow `if (config === false)` checks. Membership tests on authored maps use `Object.hasOwn`, not a bare lookup (`constructor` / `__proto__`).

Two independent `z.strictObject` surfaces drop `models` and add `excludedModels` plus the authored alias grammar in the same change:

- `OAuthProviderMutationBodySchema` (Save / PUT)
- `DashboardOAuthProviderPatchSchema` (login / re-login `providerPatch`)

Missing either one leaves a dead field or a strict parse error. `DashboardOAuthProviderPatchSchema` is not derived from the mutation body; both must be edited.

### Authored alias rules

| Written | Meaning |
| --- | --- |
| no `alias`, or `alias` without `*: false` | inherit plugin `defaultAliases` |
| `mini: { model, preserve? }` or `fast: gpt-5-nano` | override that inherited key; authored wins |
| `codex: false` | hide that inherited key |
| `*: false` | do not inherit; only the other `AliasConfig` entries apply |
| key absent | inherit that plugin key (when inherit is on) |

`*` is reserved on OAuth. It accepts only `false`. Any other value is a parse error. `*` is never a routable alias name.

Key reservation runs **after key normalization** (`trim`). `' *'` and `'*'` are the same reserved key. A refine that sees the raw key first would let `' *'` become a real route (`${providerId}/*`). Value schema cannot enforce this: `AliasConfig` already accepts a model-id string, so `'*': 'gpt-5'` looks like a normal alias until the reserved-key refine runs.

When inherit is off (`*: false`), a `false` value on any other key is ignored at resolve. The editor keeps those rows visible and marks them unused until inherit is turned back on.

Authored value grammar is `z.union([z.literal(false), AliasConfigSchema])` with `false` first. `AliasConfigSchema` already `.transform`s. A failed object/`false` mix must still report `alias.<key>`, not a union blob — custom `errorMap` or a refine, not a bare union message.

## Runtime

Exposure: `catalog − excludedModels`. There is no allowlist branch. `exposedModelIds` / the draft Test gate take the OAuth provider (or `{ excludedModels }`), not `provider.models`.

### Where inherit resolves

Zod parse has neither catalog nor adapter. Inherit does **not** run in the schema.

The only functions that have `config` and `catalog` together are `createRuntimeProvider` and `withRoutingConfig` in `packages/server/src/plugin-runtime/capabilities.ts`. Both take plugin defaults as an argument (`ProviderAlias | undefined`) and assign `provider.alias` from the **effective** map.

`materialize.ts` computes those defaults with the per-entry helper (below) and passes them in. The cache-reuse path that already calls `withRoutingConfig` when `previous.identity === identity` must pass current defaults too. Otherwise a plugin upgrade that only adds a `defaultAliases` key keeps serving the old effective map.

`defaultAliases` is **not** stored on `CatalogJobDescriptor` for write-back. That descriptor field and the scheduler merge hook go away.

### Effective alias

Shared helper (types or core, one function, used by materialize, `withRoutingConfig`, and the editor preview). Edit-view does **not** run step 5:

1. Plugin defaults come from the per-entry helper. A throwing hook or a wholly unusable return is empty defaults, not a failed login / refresh / editor page.
2. Bad entries drop individually. One broken suggestion does not drop its neighbors. Editor and router see the same set.
3. If inherit is on, start from those defaults. If inherit is off, start from `{}`.
4. For each authored key, `Object.hasOwn`: `AliasConfig` replaces that key; `false` deletes it (inherit on) or is ignored (inherit off). Skip `*`.
5. Drop any remaining entry — authored or inherited — whose targets are not all in the exposed catalog. This is resolve, not parse.
6. Result is `ProviderAlias`. That is what the router and `routingCapabilities` see.

`preservedAliasModels` runs on the **effective** map only. `excludedModels` wins: a `preserve: true` alias cannot put an excluded catalog id back into `models` / `upstreamMetadata`.

### Alias checks, two layers

| Condition | When | Effect |
| --- | --- | --- |
| authored `AliasConfig` target is in `excludedModels` | parse (`validateAliasTargets`, OAuth branch) | error on `alias.<key>.model` (and variant paths) |
| leftover OAuth `models` | parse | ignored; do not require alias targets to be in it |
| api / ai-sdk `alias` value `false` or reserved `*` | parse | error on `alias.<key>` |
| target missing from catalog | resolve | drop that entry, authored and inherited alike |
| inherited target in `excludedModels` | resolve | drop that inherited entry (it never became authored) |

`validateAliasTargets` branches on `kind`. OAuth ignores `models` and reads `excludedModels`. api / ai-sdk keep today's whitelist rule.

An authored alias that still targets a model the user just hid **fails parse**, so Save stays blocked. The editor must say so on that alias row (existing alias-issues path), not with a message about `models`. Unchecking a catalog id that authored aliases still target does not silently delete those aliases; the user retargets or removes them, or uses the hide/restore actions below.

### Write paths that go away

Delete these, including tests that only exist to protect them:

- `mergeInsertedAliases` in `packages/core/src/plugins/account-login/login.ts` and the post-commit call
- first-login `validatedDefaultAliases` seed in `login/stage.ts` (`providerEntry` `defaults`)
- `mergeCatalogDefaultAliases` in `packages/server/src/catalog-scheduler.ts`
- `CatalogSchedulerOptions.mergeDefaultAliases`
- `CatalogMergeIdentity.defaultAliases`
- `mergeHost` / `mergeDefaultAliases` wiring in `packages/server/src/server-state/index.ts`
- `insertMissingAliases` and its tests
- `assertAliasTargetsInCatalog` / `validatedDefaultAliases` throw-the-whole-map helpers, once the per-entry helper is the only reader

`insertMissingAliases` is not kept as an unused export.

Dashboard re-login is a third persist path and is not removed by deleting those server merges. `oauthProviderEditAction` already puts `values.alias` on `providerPatch`. That patch must use the **same authored serialization as Save**: inherited rows stay out of the map. A test that only asserts server-side re-login (no `providerPatch.alias`) does not cover this.

### Plugin-default helper

One function in core (today's edit-view `pluginAliasSuggestions` loop, not `assertAliasTargetsInCatalog`):

- call `adapter.catalog.defaultAliases(catalog)`
- catch → `undefined`
- per entry: `AliasConfigSchema.safeParse`, then every target must be in the catalog; drop the entry otherwise
- `Object.hasOwn` when copying keys
- empty result → `undefined`

Login, catalog refresh, edit-view, and materialize all use this function for **schema/catalog** validity only. Edit-view `pluginAliases` is that unfiltered-by-denylist set. `excludedModels` is editor draft state; the server has not seen the latest uncheck. Filtering inherit rows against `catalog − excludedModels` happens on the client (reuse `applicablePluginAliases`, change its input from a `models` allowlist to the draft exposed set). `mergePluginAliasRows` goes away with the one-shot sync button. `applicablePluginAliases` stays.

## Dashboard

Models list stays enable/disable checkboxes.

- Uncheck writes that id into `excludedModels` only. It does not snapshot the catalog into `models`.
- Check removes that id from `excludedModels`.
- Save writes `excludedModels` and omits `models`.
- If an authored alias still targets the unchecked id, Save stays blocked and that alias row names the excluded target.

Alias list:

- Inherit on (no `*: false`): plugin defaults that are not hidden and whose targets are exposed appear as inherited rows. They are not written on save.
- Edit an inherited row → persist it as `AliasConfig`.
- Hide an inherited row → persist `key: false`.
- An authored key that is also a plugin default has **two** actions: restore plugin default (delete the entry so inherit returns) and hide (`key: false`). Removing the entry must not be the only delete control — that would look like delete and then show the plugin value again. This is the exit for keys already seeded into existing files.
- 「跟插件同步」off → persist `*: false`. Inherited-only rows leave the effective set. The editor does not snapshot them into `alias`. Existing `false` rows stay in the file and render as unused.
- 「跟插件同步」on → omit `*: false`.
- The one-shot 「同步插件别名」copy-into-`alias` action is removed. Inherit replaces it. Delete `mergePluginAliasRows` only.
- Save and re-login `providerPatch.alias` share one serializer. Inherited rows never enter that map.

Exposure rail and alias preview resolve on the client from `pluginAliases` + draft `alias` + draft `excludedModels`, so unchecking a model hides inherit rows that target it before save.

## Compatibility

Literal: missing `*: false` means inherit. A plugin key that used to be deleted from the file and is not `false` comes back.

| Stored OAuth shape | Exposure |
| --- | --- |
| no `excludedModels` (leftover `models` ignored) | all catalog ids |
| `excludedModels: []` | all catalog ids |
| `excludedModels: ['o1-preview']` | catalog minus `{o1-preview}` |

| Stored OAuth `alias` | Effective aliases |
| --- | --- |
| absent / `{}` | all applicable plugin defaults |
| `{ mini: { model: gpt-5-mini } }` | plugin defaults, `mini` overridden |
| `{ codex: false }` | plugin defaults minus `codex` |
| `{ '*': false }` | none |
| `{ '*': false, mini: { model: gpt-5-mini } }` | only `mini` |

Already-persisted plugin keys that remain as `AliasConfig` stay in the file. They behave as overrides. They are not rewritten or deleted.

Startup emits a diagnostic warning per OAuth provider that still has a leftover `models` key: the list no longer restricts exposure; use `excludedModels`. This is a silent widening of the offer set.

The changeset targets `aio-proxy` plus the packages that actually change (`@aio-proxy/types`, `@aio-proxy/core`, `@aio-proxy/server`, `@aio-proxy/dashboard`). The `aio-proxy` note states the leftover-`models` behavior change.

## Testing

- Exposure is `catalog − excludedModels`. Leftover `models` does not restrict `validateAliasTargets`, `exposedModelIds`, or the draft Test gate.
- Inherit on: plugin defaults appear; authored keys win; `false` hides; a later plugin key appears without a file edit.
- Inherit off (`*: false`): only authored `AliasConfig` entries.
- Seeded leftover key stays at the file value when the plugin default for that key changes (`mini: gpt-4o-mini` in file, plugin now says `gpt-5-mini` → effective is still `gpt-4o-mini`).
- `withRoutingConfig` cache reuse still picks up a newly inherited plugin key.
- `*: true` / `*: { model: ... }` / `' *': false` fail parse. `' *'` does not become a route.
- `preserve: true` cannot re-admit an `excludedModels` id into `models` / `upstreamMetadata`. Authored target in `excludedModels` fails parse.
- One bad `defaultAliases` entry plus three good ones → three inherited (login, catalog refresh, edit-view, materialize).
- api / ai-sdk reject `false` and reserved `*`, path `alias.<key>`.
- Create / re-login / catalog refresh do not persist plugin defaults.
- Re-login **with** `providerPatch` does not persist plugin defaults (inherited rows absent from `providerPatch.alias`).
- Dashboard: uncheck one catalog row writes only that id to `excludedModels`, and inherit rows targeting it leave the preview immediately.
- Dashboard: inherited row is visible and absent from the mutation **and** `providerPatch` `alias` map; hide persists `false`; restore removes the authored key; turning inherit off persists `*: false` and does not snapshot.
- `DashboardOAuthProviderPatchSchema` parse errors for `false` / `*` / duplicate `when` still point at `alias.<key>` after `models` is removed (`alias-variant.test.ts` patch-schema case included).
