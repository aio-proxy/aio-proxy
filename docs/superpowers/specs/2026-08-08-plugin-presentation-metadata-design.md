# Plugin presentation metadata

## Goal

Give each plugin one authoritative presentation identity. Its localized display name and icon belong together in descriptor metadata; OAuth capabilities and OAuth accounts keep only the names appropriate to their own scopes.

## Public SDK

`PluginDescriptor.metadata` will expose optional `displayName`, `description`, `icon`, and `options`. `icon` accepts the existing validated Lobe icon key, HTTP(S) URL, or image data URL type, renamed from `OAuthIcon` to `PluginIcon`.

`OAuthAdapter` will expose required `displayName` and optional `description`; its `label` and `icon` fields are removed. OAuth login results and refresh metadata will rename their account-facing `label` to `accountLabel`. OAuth quota items will use `displayName`.

Removed and renamed public fields have no deprecated aliases or dual-read paths. Presentation metadata and `PluginApi.logger` are compatible extensions kept on descriptor v1, so no descriptor major bump or dual-version loader is warranted. `PLUGIN_API_VERSION`, the descriptor brand, and the supported version set remain v1 only. The host supports only v1. A branded v2 descriptor must fail as `PLUGIN_API_INCOMPATIBLE` before metadata is read.

## Data flow

The plugin loader validates and stores the plugin descriptor's display metadata. Invalid plugin icons are stripped and logged as `plugin.metadata.icon.invalid` with only the package name; the log sink is guarded so a throwing sink never blocks plugin loading. The existing icon classifier is renamed for plugin use and retains its existing URL/data-URI safety rules.

The plugin control-plane summary returns `displayName` and `icon`. Dashboard plugin pages and Provider OAuth aggregate rows consume that single summary source. OAuth capabilities return only capability `displayName` and description; creating an OAuth account does not need plugin identity metadata. The CLI capability selector renames `CapabilityChoice.label` to `displayName` and renders the adapter display name.

`accountLabel` is public at every login and refresh boundary, but the repository's internal `label` column remains unchanged. The mapping is explicit at login, credential refresh, and persistence boundaries, so the refactor needs no data migration.

The Provider table maps a group by plugin package name, renders the plugin icon and a visible expand/collapse chevron in its aggregate indicator cell, and continues to expand from the entire row and its keyboard-accessible indicator button. Lobe keys use the existing icon component; safe URL/data icons render as decorative images. Missing or failed images leave the chevron intact as the fallback indicator.

## Validation and tests

Tests cover the rejected branded-v2 incompatibility path, descriptor icon validation/logging (including a throwing sink), SDK type contracts, built-in plugin descriptors, dashboard schemas and endpoint serialization, CLI capability prompt localization, OAuth capability serialization, Provider aggregate icon rendering and fallback, and login plus both account-label refresh paths. Existing focused Dashboard table tests plus workspace checks verify the UI change.

## Release

Add a minor changeset for the product packages `@aio-proxy/plugin-sdk` and `aio-proxy`, alongside every directly changed internal workspace package (at minimum `@aio-proxy/core`, `@aio-proxy/types`, `@aio-proxy/cli`, and `@aio-proxy/dashboard`). Document every removed public field and its replacement, including the Dashboard API fields.
