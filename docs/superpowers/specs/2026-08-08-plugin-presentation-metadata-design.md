# Plugin presentation metadata

## Goal

Give each plugin one authoritative presentation identity. Its localized display name and icon belong together in descriptor metadata; OAuth capabilities and OAuth accounts keep only the names appropriate to their own scopes.

## Public SDK

`PluginDescriptor.metadata` will expose optional `displayName`, `description`, `icon`, and `options`. `icon` accepts the existing validated Lobe icon key, HTTP(S) URL, or image data URL type, renamed from `OAuthIcon` to `PluginIcon`.

`OAuthAdapter` will expose required `displayName` and optional `description`; its `label` and `icon` fields are removed. OAuth login results and refresh metadata will rename their account-facing `label` to `accountLabel`. OAuth quota items will use `displayName`.

This is intentionally a breaking change. No deprecated aliases or dual-read paths will remain.

## Data flow

The plugin loader validates and stores the plugin descriptor's display metadata. The plugin control-plane summary returns `displayName` and `icon`. Dashboard plugin pages and Provider OAuth aggregate rows consume that single summary source. OAuth capabilities return only capability `displayName` and description; creating an OAuth account does not need plugin identity metadata.

The Provider table maps a group by plugin package name, renders the plugin icon in its aggregate indicator cell, and continues to expand from the entire row and its keyboard-accessible indicator button.

## Validation and tests

Tests cover descriptor icon validation and logging, SDK type contracts, built-in plugin descriptors, dashboard schemas and endpoint serialization, OAuth capability serialization, Provider aggregate icon rendering, and account-label persistence. Existing focused Dashboard table tests plus workspace checks verify the UI change.

## Release

Add a major changeset for `@aio-proxy/plugin-sdk` and `aio-proxy`, documenting the removed fields and their replacements.
