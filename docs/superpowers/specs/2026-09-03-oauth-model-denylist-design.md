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
- Do not keep a legacy OAuth `models` allowlist. Leftover `models` is ignored.
- Do not add `excludedAliases` or `syncPluginAliases`.

## Config

OAuth providers gain `excludedModels?: string[]`. Catalog ids in that list are hidden. Absent or empty hides nothing. Stale ids that left the catalog are ignored.

OAuth **does not consume** `models`. A leftover `models` key is ignored at parse/runtime. A dashboard save omits it so it disappears from the file.

OAuth `alias` stays one map. Values are today's `AliasConfig` (string shorthand or `{ model, preserve?, variants? }`) or `false`. The key `*` is reserved. api / ai-sdk `alias` stays `Record<string, AliasConfig>` and rejects `false` and a reserved `*`.

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

Alias rules:

| Written | Meaning |
| --- | --- |
| no `alias`, or `alias` without `*: false` | inherit plugin `defaultAliases` |
| `mini: { model, preserve? }` or `fast: gpt-5-nano` | override that inherited key; authored wins |
| `codex: false` | hide that inherited key |
| `*: false` | do not inherit; only the other `AliasConfig` entries apply |
| key absent | inherit that plugin key (when inherit is on) |

`*` accepts only `false`. Any other value is a parse error. `*` is never a routable alias name.

When inherit is off (`*: false`), a `false` value on any other key is ignored. It hides nothing because nothing is inherited.

## Runtime

Exposure: `catalog − excludedModels`. There is no allowlist branch.

Effective aliases:

1. If `defaultAliases` throws or is malformed, treat plugin defaults as empty. Do not fail login, catalog refresh, or the editor.
2. If inherit is on, start from plugin defaults, drop entries whose targets are not all in the exposed catalog, then apply the `alias` map.
3. If inherit is off, use only `AliasConfig` entries from `alias`.
4. Authored `AliasConfig` keys override same-named inherited keys.
5. `false` keys drop an inherited key. They do not remove an authored `AliasConfig` on the same key; a key cannot be both.

Login, re-login, and catalog TTL stop writing plugin defaults into `providers.*.alias`. First-login `providerEntry` does not seed `defaults`.

`insertMissingAliases` is not a config-write path.

Authored alias targets that sit in `excludedModels` fail validation. Inherited suggestions that point at a hidden or missing catalog id are dropped, not a parse error.

## Dashboard

Models list stays enable/disable checkboxes.

- Uncheck writes that id into `excludedModels` only. It does not snapshot the catalog into `models`.
- Check removes that id from `excludedModels`.
- Save writes `excludedModels` and omits `models`.

Alias list:

- Inherit on (no `*: false`): plugin defaults that are not hidden and whose targets are exposed appear as inherited rows. They are not written on save.
- Edit an inherited row → persist it as `AliasConfig`.
- Delete an inherited row → persist `key: false`.
- 「跟插件同步」off → persist `*: false`. Inherited-only rows leave the effective set. The editor does not snapshot them into `alias`.
- 「跟插件同步」on → omit `*: false`.
- The one-shot 「同步插件别名」copy-into-`alias` action is removed. Inherit replaces it.

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

## Testing

- Exposure is `catalog − excludedModels`. Leftover `models` does not restrict.
- Inherit on: plugin defaults appear; authored keys win; `false` hides; a later plugin key appears without a file edit.
- Inherit off (`*: false`): only authored `AliasConfig` entries.
- `*: true` / `*: { model: ... }` fail parse.
- Create / re-login / catalog refresh do not persist plugin defaults. Invalid `defaultAliases` does not fail those paths.
- Dashboard: uncheck one catalog row writes only that id to `excludedModels`.
- Dashboard: inherited row is visible and absent from the mutation `alias` map; delete persists `false`; turning inherit off persists `*: false` and does not snapshot.
