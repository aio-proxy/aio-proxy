# @aio-proxy/plugin-muse-code

## 0.20.2

### Patch Changes

- [#316](https://github.com/aio-proxy/aio-proxy/pull/316) [`3b4c12e`](https://github.com/aio-proxy/aio-proxy/commit/3b4c12e0e3f5b502cacf4c22aa9a88188608c3da) Thanks [@baranwang](https://github.com/baranwang)! - The plugin SDK now exports shared abortableSleep and dedupeQuotaItemIds helpers, preserving OAuth cancellation reasons and provider-specific quota IDs. Removed unused UI and internal wrappers, plus the unused AioModelMessage and AioStreamPart schemas and associated types from @aio-proxy/types.
- Updated dependencies [[`3b4c12e`](https://github.com/aio-proxy/aio-proxy/commit/3b4c12e0e3f5b502cacf4c22aa9a88188608c3da)]:
  - @aio-proxy/plugin-sdk@0.20.2

## 0.20.1

### Patch Changes

- [#314](https://github.com/aio-proxy/aio-proxy/pull/314) [`3c31f50`](https://github.com/aio-proxy/aio-proxy/commit/3c31f505c862b18a314e19cfac580d7a935d0d07) Thanks [@baranwang](https://github.com/baranwang)! - Muse Code quota bars now show the even-burn mark. The plugin read the window length from the
  upstream response but never passed it on, so the dashboard knew when each window resets without
  knowing how long it runs and had nothing to pace against.
- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.20.1

## 0.20.0

### Minor Changes

- [#305](https://github.com/aio-proxy/aio-proxy/pull/305) [`d036485`](https://github.com/aio-proxy/aio-proxy/commit/d0364851282aaf6aaa56c6dc6bfa515d7e0c3209) Thanks [@baranwang](https://github.com/baranwang)! - Add a built-in Muse Code OAuth plugin that logs in with a Meta device code, mints a Model API key, and routes Meta models through the OpenAI Responses API.

### Patch Changes

- Updated dependencies [[`13a6c91`](https://github.com/aio-proxy/aio-proxy/commit/13a6c9153739049dab5443dd3ac7d570f7e80690), [`681b039`](https://github.com/aio-proxy/aio-proxy/commit/681b039164281d7ab28c09ce1a61aae064caa6a0), [`8b02edd`](https://github.com/aio-proxy/aio-proxy/commit/8b02edd711a54102661c41199a60f10396f7dce3)]:
  - @aio-proxy/plugin-sdk@0.20.0
