# @aio-proxy/plugin-cursor

## 0.13.0

### Patch Changes

- Updated dependencies [[`99755b5`](https://github.com/aio-proxy/aio-proxy/commit/99755b58b7492f9da4161ac429325dd319ba48f8), [`b1f5bff`](https://github.com/aio-proxy/aio-proxy/commit/b1f5bff2f2e92abfd54b90fb32b29b4b145e8c1d)]:
  - @aio-proxy/plugin-sdk@0.13.0
  - @aio-proxy/types@0.13.0

## 0.12.3

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.12.3
  - @aio-proxy/types@0.12.3

## 0.12.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.12.2
  - @aio-proxy/types@0.12.2

## 0.12.1

### Patch Changes

- [#230](https://github.com/aio-proxy/aio-proxy/pull/230) [`e674d9a`](https://github.com/aio-proxy/aio-proxy/commit/e674d9a225d36d03fb388c223a6559beff6adb4d) Thanks [@baranwang](https://github.com/baranwang)! - oauth: show normalized account emails for connected OAuth providers
- Updated dependencies [[`70756e3`](https://github.com/aio-proxy/aio-proxy/commit/70756e3fe1bd63be4871bd2dc9901b159db47de6)]:
  - @aio-proxy/types@0.12.1
  - @aio-proxy/plugin-sdk@0.12.1

## 0.12.0

### Minor Changes

- [#226](https://github.com/aio-proxy/aio-proxy/pull/226) [`9c16d0b`](https://github.com/aio-proxy/aio-proxy/commit/9c16d0b56a954563a296e5363869d5bae12ffda2) Thanks [@baranwang](https://github.com/baranwang)! - Configure model metadata once per exposed model at `router.models.<slug>.metadata`, including `extend`, with per-Provider `cost` and `limit` overrides under `router.models.<slug>.providers.<id>`. The removed `providers.<id>.metadata` field is silently ignored, and metadata keys no longer create routes; expose models through `providers.<id>.models` or `alias`. Metadata editing now lives in the Dashboard routing drawer instead of the Provider editor.

  Rename the plugin SDK's free-form `ModelDescriptor.metadata`, `ModelCatalog.metadata`, and raw-resolver `metadata` input to `extra`, and add typed `ModelDescriptor.modelMetadata` for host-consumed model metadata. Publish `@aio-proxy/types` as the SDK metadata type source.

### Patch Changes

- [#228](https://github.com/aio-proxy/aio-proxy/pull/228) [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca) Thanks [@baranwang](https://github.com/baranwang)! - Upgrade Zod to 4.5 and compile inbound protocol request schemas with `z.compile()` (except OpenAI Responses, whose unknown-item transform logs). Upgrade es-toolkit to 1.52. Use `isPlainObject` for JSON and other plain data. Structural plugin/SDK contracts that may be class instances use `isRecord` from the published `@aio-proxy/shared` leaf package. Replace spread-Set arrays with `uniq` in packages that already depend on es-toolkit.
- Updated dependencies [[`9c16d0b`](https://github.com/aio-proxy/aio-proxy/commit/9c16d0b56a954563a296e5363869d5bae12ffda2), [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca)]:
  - @aio-proxy/plugin-sdk@0.12.0
  - @aio-proxy/types@0.12.0

## 0.11.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.11.2
  - @aio-proxy/types@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.11.1
  - @aio-proxy/types@0.11.1

## 0.11.0

### Patch Changes

- Updated dependencies [[`4ce6cee`](https://github.com/aio-proxy/aio-proxy/commit/4ce6cee2412a13cc18d250af52335f456ad1db13), [`64718ae`](https://github.com/aio-proxy/aio-proxy/commit/64718aea31a3a26ef691443246163713278b5e2b), [`b6e65cd`](https://github.com/aio-proxy/aio-proxy/commit/b6e65cddeaab8ce356f1d5f7c0f0f7e98a401608), [`84901fd`](https://github.com/aio-proxy/aio-proxy/commit/84901fd5fd54ad95418ef74bb578f5b210e30612)]:
  - @aio-proxy/types@0.11.0
  - @aio-proxy/plugin-sdk@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [[`076c67b`](https://github.com/aio-proxy/aio-proxy/commit/076c67ba698c4cd7a3756ef370adc7a62a530402)]:
  - @aio-proxy/plugin-sdk@0.10.0
  - @aio-proxy/types@0.10.0

## 0.9.1

### Patch Changes

- Updated dependencies [[`1a1c519`](https://github.com/aio-proxy/aio-proxy/commit/1a1c519422c9be44a770646539803c929b5b9e43)]:
  - @aio-proxy/types@0.9.1
  - @aio-proxy/plugin-sdk@0.9.1

## 0.9.0

### Patch Changes

- [#184](https://github.com/aio-proxy/aio-proxy/pull/184) [`9b6f0a3`](https://github.com/aio-proxy/aio-proxy/commit/9b6f0a3f26d6bb22fc20298dc203825dca818309) Thanks [@baranwang](https://github.com/baranwang)! - Cursor first-login now writes family aliases from AvailableModels, so clients can request names like `claude-sonnet-4-6` / `grok-4.6` and match thinking, effort, and speed onto the live wire slug.
- Updated dependencies [[`3f0e371`](https://github.com/aio-proxy/aio-proxy/commit/3f0e3719028e1a506b2dffd81982c2def32d1db8), [`87126aa`](https://github.com/aio-proxy/aio-proxy/commit/87126aadb95151258c8d1a4e52e0f3e854ee0e54), [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9), [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9), [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b), [`2797531`](https://github.com/aio-proxy/aio-proxy/commit/2797531548755924713f880e6ef0cbcb00923bf5), [`c5b04c1`](https://github.com/aio-proxy/aio-proxy/commit/c5b04c183b0a9669f518bcb18f38019e96d3a8ca), [`f2d1122`](https://github.com/aio-proxy/aio-proxy/commit/f2d1122b6a946a302902070b288c9093d091808b), [`bf7a1cc`](https://github.com/aio-proxy/aio-proxy/commit/bf7a1cce861313f8294822bb78e2d573c658c250), [`4bddead`](https://github.com/aio-proxy/aio-proxy/commit/4bddead355c37861e89dd57cf2a6a3514d4b35dc), [`60996d3`](https://github.com/aio-proxy/aio-proxy/commit/60996d3f0927636a3531c01fce35ba30015973a7), [`9b6f0a3`](https://github.com/aio-proxy/aio-proxy/commit/9b6f0a3f26d6bb22fc20298dc203825dca818309)]:
  - @aio-proxy/types@0.9.0
  - @aio-proxy/plugin-sdk@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.8.0

## 0.7.0

### Minor Changes

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Plugins move display identity into descriptor metadata (`displayName` / `accountLabel`; remove legacy `label` and OAuth capability icons). Add Cursor account OAuth/provider support. Normalize OpenAI Responses errors to `response.failed` for Codex.

### Patch Changes

- Updated dependencies [[`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5)]:
  - @aio-proxy/plugin-sdk@0.7.0
