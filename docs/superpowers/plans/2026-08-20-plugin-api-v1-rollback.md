# Plugin API v1 rollback

**Date:** 2026-08-20

**Status:** Implemented; preflight pending

Rolled the plugin descriptor contract back to a single supported version. `definePlugin` emits `apiVersion: 1` with the `descriptor/v1` brand. The host loads only branded v1 descriptors. Branded `apiVersion: 2` is rejected with `PLUGIN_API_INCOMPATIBLE`. `PluginMetadata` and `PluginApi.logger` are compatible extensions kept on descriptor v1, so no descriptor major bump or dual-version loader is warranted.

## Implementation

In `packages/plugin-sdk/src/plugin/plugin.ts`:

- `PLUGIN_API_VERSION = 1`
- `PLUGIN_API_VERSIONS_SUPPORTED = [1]`
- `PLUGIN_DESCRIPTOR_BRAND = Symbol.for('@aio-proxy/plugin-sdk/descriptor/v1')`

## Verification

Focused SDK, core loader, logger, OpenAI ChatGPT, xAI artifact, and CLI fixture tests; `plugin-sdk` type tests.
