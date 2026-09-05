# @aio-proxy/plugin-openai-chatgpt

## 0.19.2

### Patch Changes

- [#286](https://github.com/aio-proxy/aio-proxy/pull/286) [`981e765`](https://github.com/aio-proxy/aio-proxy/commit/981e765965a881af845aff413db711f779ff2ffb) Thanks [@baranwang](https://github.com/baranwang)! - Drop reasoning item ids the ChatGPT Codex backend never persisted.

  A turn served through the AI SDK model path leaves the proxy's own synthetic
  "rs_..." id on the reasoning item, and the client replays that id in the next
  turn's input. This runtime forces store: false, so the upstream never persisted
  it and the lookup failed with "Item with id 'rs_...' not found. Items are not
  persisted when store is set to false." Reasoning items that carry no
  encrypted_content now forward without the id and are re-sent as new content;
  the summary is kept. The invalid_encrypted_content retry replays through the
  same rewrite, so an item that just lost its unusable blob also loses the id.

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.19.2
  - @aio-proxy/types@0.19.2

## 0.19.1

### Patch Changes

- Updated dependencies [[`80f8b9d`](https://github.com/aio-proxy/aio-proxy/commit/80f8b9d10eef15214fc3f55342ccf097fc00b6ef)]:
  - @aio-proxy/plugin-sdk@0.19.1
  - @aio-proxy/types@0.19.1

## 0.19.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.19.0
  - @aio-proxy/types@0.19.0

## 0.18.1

### Patch Changes

- [#277](https://github.com/aio-proxy/aio-proxy/pull/277) [`e2d8a23`](https://github.com/aio-proxy/aio-proxy/commit/e2d8a2381cb6c9f32dac2c26d2dd476934d2a71c) Thanks [@baranwang](https://github.com/baranwang)! - Surface the newest ChatGPT (Codex) models again. The pinned `codex-tui` client version was stale, and the upstream model catalog gates each model on its `minimal_client_version`, so the `gpt-5.6` family and `gpt-6-astra` were silently missing from ChatGPT OAuth Providers.
- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.18.1
  - @aio-proxy/types@0.18.1

## 0.18.0

### Minor Changes

- [#274](https://github.com/aio-proxy/aio-proxy/pull/274) [`1cf2838`](https://github.com/aio-proxy/aio-proxy/commit/1cf2838bb8cec1ed8e3354646b1b39d2695d3664) Thanks [@baranwang](https://github.com/baranwang)! - Redeem ChatGPT rate-limit reset credits from the Dashboard. The OpenAI ChatGPT plugin now implements the OAuth quota `reset` capability, the quota popup turns an available credit count into a confirmed redeem button, and the reading is invalidated afterwards so the spent credit disappears immediately — including when the redemption is refused because the credit was already spent elsewhere, so the button cannot be re-offered for the rest of the cooldown. The button stays disabled until that post-reset reading lands, so a second redemption cannot be confirmed against the stale count. Only credits the upstream reports as available Codex rate-limit grants are counted.

### Patch Changes

- Updated dependencies [[`9608e07`](https://github.com/aio-proxy/aio-proxy/commit/9608e070b5faf585cf591fa007e190e7493362c3), [`1cf2838`](https://github.com/aio-proxy/aio-proxy/commit/1cf2838bb8cec1ed8e3354646b1b39d2695d3664)]:
  - @aio-proxy/types@0.18.0
  - @aio-proxy/plugin-sdk@0.18.0

## 0.17.0

### Minor Changes

- [#259](https://github.com/aio-proxy/aio-proxy/pull/259) [`44a978e`](https://github.com/aio-proxy/aio-proxy/commit/44a978eb2a58a1e36c9c5cd3fd933f082995580b) Thanks [@baranwang](https://github.com/baranwang)! - ChatGPT OAuth providers now discover models from the signed-in account's own Codex endpoint instead of a published `models.json` snapshot, so the exposed list matches what the account can actually call. Models the account cannot use no longer appear, and `gpt-5.3-codex-spark` — previously hidden by a `supported_in_api` filter that does not apply to ChatGPT accounts — is now available. Because the list is fetched with the account's own credential and there is no bundled fallback, a ChatGPT provider whose login is missing or can no longer be refreshed now exposes no models until you sign in again, where before it listed the published snapshot regardless of login state. An expired access token alone is unaffected — it is refreshed as usual.

  `gpt-image-2` is also exposed, and `/v1/images/generations` and `/v1/images/edits` now pass through to the ChatGPT image endpoints. JSON image requests are supported; `multipart/form-data` requests to `/v1/images/edits` are not, because the ChatGPT backend rejects that content type.

- [#260](https://github.com/aio-proxy/aio-proxy/pull/260) [`b7d9520`](https://github.com/aio-proxy/aio-proxy/commit/b7d9520cdc280d1b6785c53d4d079b5db2d5311f) Thanks [@baranwang](https://github.com/baranwang)! - Refresh an OAuth Provider's credential on demand from the dashboard Provider card menu.

  OAuth Providers whose plugin supports it gain a "Refresh Credential" entry in the card's ⋯ menu that
  forces an upstream token exchange even when the current credential has not expired, clears a stale
  `CREDENTIAL_REFRESH_FAILED` diagnostic on success, and reloads the Provider list so the account label
  and expiry reflect the new credential. A refresh the plugin reports as permanently failed — a revoked
  refresh token, for example — records the same reauthentication diagnostic the automatic refresh path
  does, so the card tells you to re-login instead of continuing to report the Provider as ready. A
  transient failure leaves the Provider untouched. The entry is hidden — not
  disabled — for plugins without the capability, which Provider summaries now report as
  `canRefreshCredential`. All six bundled OAuth plugins support it.

  `OAuthAdapter` gains an optional `refreshCredential`, exported alongside the new
  `OAuthCredentialRefreshContext` and `OAuthCredentialRefreshResult` types. It is a pure exchange: the
  framework owns the lease, single-flight dedupe, revision compare-and-swap, and persistence, and calls
  the adapter unconditionally rather than only past expiry. Adapter registration previously dropped
  fields outside its closed list, so an adapter declaring `refreshCredential` would have lost it.

### Patch Changes

- Updated dependencies [[`b7d9520`](https://github.com/aio-proxy/aio-proxy/commit/b7d9520cdc280d1b6785c53d4d079b5db2d5311f), [`2c6da7a`](https://github.com/aio-proxy/aio-proxy/commit/2c6da7a8ccd7246bcc81daf83001e046ce376e16), [`6d02c87`](https://github.com/aio-proxy/aio-proxy/commit/6d02c876980ee55963fd0db6298adffe23bc42a2), [`8150738`](https://github.com/aio-proxy/aio-proxy/commit/815073848e78ed7195f7f6d97077f3b495d103bd)]:
  - @aio-proxy/plugin-sdk@0.17.0
  - @aio-proxy/types@0.17.0

## 0.16.0

### Minor Changes

- [#249](https://github.com/aio-proxy/aio-proxy/pull/249) [`e5e18af`](https://github.com/aio-proxy/aio-proxy/commit/e5e18af5f48f54c9dcc8e823fbcda137a97ad4b5) Thanks [@baranwang](https://github.com/baranwang)! - openai-chatgpt: report ChatGPT OAuth quota in the dashboard

  The ChatGPT (Codex) OAuth adapter now reads `wham/usage`, so its Provider card shows the quota ring: the 5-hour and weekly windows, any model-specific limits the account reports (Codex Spark and the like), the subscription plan, and the available rate-limit reset credits.

### Patch Changes

- Updated dependencies [[`142cc1b`](https://github.com/aio-proxy/aio-proxy/commit/142cc1b419b0109585a53f020343d0eb72b6673f)]:
  - @aio-proxy/plugin-sdk@0.16.0
  - @aio-proxy/types@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [[`1daece3`](https://github.com/aio-proxy/aio-proxy/commit/1daece3dd2dad3ddfe86c12784ef379e99424c91)]:
  - @aio-proxy/types@0.15.0
  - @aio-proxy/plugin-sdk@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.14.0
  - @aio-proxy/types@0.14.0

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

### Minor Changes

- [#212](https://github.com/aio-proxy/aio-proxy/pull/212) [`64718ae`](https://github.com/aio-proxy/aio-proxy/commit/64718aea31a3a26ef691443246163713278b5e2b) Thanks [@baranwang](https://github.com/baranwang)! - openai: add Completions and Responses compact ports

  `POST /v1/completions` and `POST /v1/responses/compact` now use the existing language-generation pipeline. Remaining official Responses resource operations return a protocol-shaped 501 instead of a generic 404. ChatGPT OAuth providers forward compact to the Codex compaction endpoint. GitHub Copilot and Kimi Code providers decline endpoints they do not serve so the same candidate can convert through its language model, or a later provider can take the request. Legacy Completions streams omit usage unless the client can opt in.

- [#214](https://github.com/aio-proxy/aio-proxy/pull/214) [`84901fd`](https://github.com/aio-proxy/aio-proxy/commit/84901fd5fd54ad95418ef74bb578f5b210e30612) Thanks [@baranwang](https://github.com/baranwang)! - Add inbound OpenAI Embeddings and Gemini embed/batch embed through same-protocol raw, embedding convert, and fallback.

### Patch Changes

- Updated dependencies [[`4ce6cee`](https://github.com/aio-proxy/aio-proxy/commit/4ce6cee2412a13cc18d250af52335f456ad1db13), [`64718ae`](https://github.com/aio-proxy/aio-proxy/commit/64718aea31a3a26ef691443246163713278b5e2b), [`b6e65cd`](https://github.com/aio-proxy/aio-proxy/commit/b6e65cddeaab8ce356f1d5f7c0f0f7e98a401608), [`84901fd`](https://github.com/aio-proxy/aio-proxy/commit/84901fd5fd54ad95418ef74bb578f5b210e30612)]:
  - @aio-proxy/types@0.11.0
  - @aio-proxy/plugin-sdk@0.11.0

## 0.10.0

### Minor Changes

- [#203](https://github.com/aio-proxy/aio-proxy/pull/203) [`076c67b`](https://github.com/aio-proxy/aio-proxy/commit/076c67ba698c4cd7a3756ef370adc7a62a530402) Thanks [@baranwang](https://github.com/baranwang)! - Add `aio-proxy provider import [path]` to copy supported CPA OAuth auth files into aio-proxy accounts. OAuth plugins can declare typed CPA credential importers through the plugin SDK, and the built-in ChatGPT, Google Antigravity, Kimi Code, and xAI Grok plugins now provide them.

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

- Updated dependencies [[`3f0e371`](https://github.com/aio-proxy/aio-proxy/commit/3f0e3719028e1a506b2dffd81982c2def32d1db8), [`87126aa`](https://github.com/aio-proxy/aio-proxy/commit/87126aadb95151258c8d1a4e52e0f3e854ee0e54), [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9), [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9), [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b), [`2797531`](https://github.com/aio-proxy/aio-proxy/commit/2797531548755924713f880e6ef0cbcb00923bf5), [`c5b04c1`](https://github.com/aio-proxy/aio-proxy/commit/c5b04c183b0a9669f518bcb18f38019e96d3a8ca), [`f2d1122`](https://github.com/aio-proxy/aio-proxy/commit/f2d1122b6a946a302902070b288c9093d091808b), [`bf7a1cc`](https://github.com/aio-proxy/aio-proxy/commit/bf7a1cce861313f8294822bb78e2d573c658c250), [`4bddead`](https://github.com/aio-proxy/aio-proxy/commit/4bddead355c37861e89dd57cf2a6a3514d4b35dc), [`60996d3`](https://github.com/aio-proxy/aio-proxy/commit/60996d3f0927636a3531c01fce35ba30015973a7), [`9b6f0a3`](https://github.com/aio-proxy/aio-proxy/commit/9b6f0a3f26d6bb22fc20298dc203825dca818309)]:
  - @aio-proxy/types@0.9.0
  - @aio-proxy/plugin-sdk@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [[`667d232`](https://github.com/aio-proxy/aio-proxy/commit/667d2322171b9e41ebdb6ae727701ef7b3866203), [`3975995`](https://github.com/aio-proxy/aio-proxy/commit/3975995850c0bd7c8282d25387bd56c2f9b3c705), [`b5e40ce`](https://github.com/aio-proxy/aio-proxy/commit/b5e40ceaa0d60eb5fee734c63fb92c9794c3ebc9)]:
  - @aio-proxy/types@0.8.0
  - @aio-proxy/plugin-sdk@0.8.0

## 0.7.0

### Minor Changes

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Plugins move display identity into descriptor metadata (`displayName` / `accountLabel`; remove legacy `label` and OAuth capability icons). Add Cursor account OAuth/provider support. Normalize OpenAI Responses errors to `response.failed` for Codex.

### Patch Changes

- Updated dependencies [[`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5), [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5), [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5)]:
  - @aio-proxy/types@0.7.0
  - @aio-proxy/plugin-sdk@0.7.0

## 0.6.4

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.6.4
  - @aio-proxy/types@0.6.4

## 0.6.3

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.6.3
  - @aio-proxy/types@0.6.3

## 0.6.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.6.2
  - @aio-proxy/types@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.6.1
  - @aio-proxy/types@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [[`abf31a4`](https://github.com/aio-proxy/aio-proxy/commit/abf31a4c2eaa5c6fedf7dd9831f00e54d2fef8ee), [`f15d8d3`](https://github.com/aio-proxy/aio-proxy/commit/f15d8d301a2172eff687bd414cc9a05b7cab4085), [`6963859`](https://github.com/aio-proxy/aio-proxy/commit/6963859bed52fbb6e56060015bf37c97a9f0abfd)]:
  - @aio-proxy/types@0.6.0
  - @aio-proxy/plugin-sdk@0.6.0

## 0.5.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.5.2
  - @aio-proxy/types@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.5.1
  - @aio-proxy/types@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.5.0
  - @aio-proxy/types@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.4.0
  - @aio-proxy/types@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.3.0
  - @aio-proxy/types@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.2.1
  - @aio-proxy/types@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.2.0
  - @aio-proxy/types@0.2.0
