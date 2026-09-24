# @aio-proxy/plugin-muse-code

## 0.33.3

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.33.3

## 0.33.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.33.2

## 0.33.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.33.1

## 0.33.0

### Patch Changes

- Updated dependencies [[`de76673`](https://github.com/aio-proxy/aio-proxy/commit/de76673fe07ae3be9f3d7e3a84d1bd541ca07479), [`24a1468`](https://github.com/aio-proxy/aio-proxy/commit/24a14688083a14639af225a0d8d908373cf8f568)]:
  - @aio-proxy/plugin-sdk@0.33.0

## 0.32.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.32.0

## 0.31.0

### Patch Changes

- Updated dependencies [[`f0b3105`](https://github.com/aio-proxy/aio-proxy/commit/f0b3105e4dc74a674303c89e1d2eb2e106b7b12b)]:
  - @aio-proxy/plugin-sdk@0.31.0

## 0.30.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.30.0

## 0.29.0

### Patch Changes

- Updated dependencies [[`571c394`](https://github.com/aio-proxy/aio-proxy/commit/571c3944b9345196468a241212618def08955d9d)]:
  - @aio-proxy/plugin-sdk@0.29.0

## 0.28.0

### Patch Changes

- Updated dependencies [[`21d30e3`](https://github.com/aio-proxy/aio-proxy/commit/21d30e321b902e2fba11801b23ce87aad6207334)]:
  - @aio-proxy/plugin-sdk@0.28.0

## 0.27.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.27.1

## 0.27.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.27.0

## 0.26.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.25.0

## 0.24.0

### Patch Changes

- Updated dependencies [[`1cb5c9f`](https://github.com/aio-proxy/aio-proxy/commit/1cb5c9f3fc91c5e48ef673eb7be0b9971942386e)]:
  - @aio-proxy/plugin-sdk@0.24.0

## 0.23.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.23.2

## 0.23.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.23.1

## 0.23.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.23.0

## 0.22.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.22.1

## 0.22.0

### Patch Changes

- Updated dependencies [[`834f9b3`](https://github.com/aio-proxy/aio-proxy/commit/834f9b359f29b229e3930a0b435200d805361789)]:
  - @aio-proxy/plugin-sdk@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.21.0

## 0.20.5

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.20.5

## 0.20.4

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.20.4

## 0.20.3

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.20.3

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
