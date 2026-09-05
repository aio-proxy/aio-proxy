# @aio-proxy/plugin-xai-grok

## 0.19.1

### Patch Changes

- Updated dependencies [[`80f8b9d`](https://github.com/aio-proxy/aio-proxy/commit/80f8b9d10eef15214fc3f55342ccf097fc00b6ef)]:
  - @aio-proxy/plugin-sdk@0.19.1

## 0.19.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.19.0

## 0.18.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.18.1

## 0.18.0

### Patch Changes

- Updated dependencies [[`1cf2838`](https://github.com/aio-proxy/aio-proxy/commit/1cf2838bb8cec1ed8e3354646b1b39d2695d3664)]:
  - @aio-proxy/plugin-sdk@0.18.0

## 0.17.0

### Minor Changes

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

- Updated dependencies [[`b7d9520`](https://github.com/aio-proxy/aio-proxy/commit/b7d9520cdc280d1b6785c53d4d079b5db2d5311f)]:
  - @aio-proxy/plugin-sdk@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [[`142cc1b`](https://github.com/aio-proxy/aio-proxy/commit/142cc1b419b0109585a53f020343d0eb72b6673f)]:
  - @aio-proxy/plugin-sdk@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.14.0

## 0.13.0

### Minor Changes

- [#239](https://github.com/aio-proxy/aio-proxy/pull/239) [`b1f5bff`](https://github.com/aio-proxy/aio-proxy/commit/b1f5bff2f2e92abfd54b90fb32b29b4b145e8c1d) Thanks [@baranwang](https://github.com/baranwang)! - Redesign the dashboard Provider list as a card grid and surface OAuth remaining quota.

  Each Provider — including each OAuth account — is now one card showing its name, kind, protocols,
  plan, routing priority and weight, 24-hour success rate and p95 latency, model count, and request
  count, with search and availability/enablement/kind filters replacing the old table's pagination and
  grouping. OAuth Providers whose plugin exposes a quota capability show a remaining-quota ring that
  opens a detail dialog with one bar per quota window that reports a remaining amount.

  The quota read is cached in memory behind a per-provider five-minute cooldown, refreshed
  asynchronously once a Provider has finished answering a model request, and exposed at
  `QUERY /dashboard/api/providers/:id/quota`; the dialog's refresh button bypasses the cooldown, and the
  Providers page polls the reading the way it already polls health. `OAuthQuotaSnapshot` gains an
  optional `plan`, which `kimi-code` and `xai-grok` now populate, and `xai-grok` also reports per-product
  usage. Dashboard Provider summaries gain `protocols` and `hasQuota` in place of the single `protocol`
  field.

### Patch Changes

- Updated dependencies [[`99755b5`](https://github.com/aio-proxy/aio-proxy/commit/99755b58b7492f9da4161ac429325dd319ba48f8), [`b1f5bff`](https://github.com/aio-proxy/aio-proxy/commit/b1f5bff2f2e92abfd54b90fb32b29b4b145e8c1d)]:
  - @aio-proxy/plugin-sdk@0.13.0

## 0.12.3

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.12.3

## 0.12.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.12.2

## 0.12.1

### Patch Changes

- [#230](https://github.com/aio-proxy/aio-proxy/pull/230) [`e674d9a`](https://github.com/aio-proxy/aio-proxy/commit/e674d9a225d36d03fb388c223a6559beff6adb4d) Thanks [@baranwang](https://github.com/baranwang)! - oauth: show normalized account emails for connected OAuth providers
- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.12.1

## 0.12.0

### Minor Changes

- [#226](https://github.com/aio-proxy/aio-proxy/pull/226) [`9c16d0b`](https://github.com/aio-proxy/aio-proxy/commit/9c16d0b56a954563a296e5363869d5bae12ffda2) Thanks [@baranwang](https://github.com/baranwang)! - Configure model metadata once per exposed model at `router.models.<slug>.metadata`, including `extend`, with per-Provider `cost` and `limit` overrides under `router.models.<slug>.providers.<id>`. The removed `providers.<id>.metadata` field is silently ignored, and metadata keys no longer create routes; expose models through `providers.<id>.models` or `alias`. Metadata editing now lives in the Dashboard routing drawer instead of the Provider editor.

  Rename the plugin SDK's free-form `ModelDescriptor.metadata`, `ModelCatalog.metadata`, and raw-resolver `metadata` input to `extra`, and add typed `ModelDescriptor.modelMetadata` for host-consumed model metadata. Publish `@aio-proxy/types` as the SDK metadata type source.

### Patch Changes

- [#228](https://github.com/aio-proxy/aio-proxy/pull/228) [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca) Thanks [@baranwang](https://github.com/baranwang)! - Upgrade Zod to 4.5 and compile inbound protocol request schemas with `z.compile()` (except OpenAI Responses, whose unknown-item transform logs). Upgrade es-toolkit to 1.52. Use `isPlainObject` for JSON and other plain data. Structural plugin/SDK contracts that may be class instances use `isRecord` from the published `@aio-proxy/shared` leaf package. Replace spread-Set arrays with `uniq` in packages that already depend on es-toolkit.
- Updated dependencies [[`9c16d0b`](https://github.com/aio-proxy/aio-proxy/commit/9c16d0b56a954563a296e5363869d5bae12ffda2), [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca)]:
  - @aio-proxy/plugin-sdk@0.12.0

## 0.11.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.11.2

## 0.11.1

### Patch Changes

- [#220](https://github.com/aio-proxy/aio-proxy/pull/220) [`0635583`](https://github.com/aio-proxy/aio-proxy/commit/0635583d2067b41c1a27170d4330c6d7a3e53773) Thanks [@baranwang](https://github.com/baranwang)! - Preserve Codex function-tool schemas on xAI Grok OAuth requests by resolving local references and explicit object unions, while isolating only tools whose schemas cannot be converted safely.
- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.11.1

## 0.11.0

### Patch Changes

- [#217](https://github.com/aio-proxy/aio-proxy/pull/217) [`e0c9ea0`](https://github.com/aio-proxy/aio-proxy/commit/e0c9ea0b6c8cea6329cf2eeefc2dc4ee2675d44c) Thanks [@baranwang](https://github.com/baranwang)! - Continue OpenAI Responses model fallback across completed hosted-search history and fall back xAI Grok OAuth custom grammar declarations to ordinary function tools with reversible client wire restoration.
- Updated dependencies [[`4ce6cee`](https://github.com/aio-proxy/aio-proxy/commit/4ce6cee2412a13cc18d250af52335f456ad1db13), [`64718ae`](https://github.com/aio-proxy/aio-proxy/commit/64718aea31a3a26ef691443246163713278b5e2b), [`b6e65cd`](https://github.com/aio-proxy/aio-proxy/commit/b6e65cddeaab8ce356f1d5f7c0f0f7e98a401608), [`84901fd`](https://github.com/aio-proxy/aio-proxy/commit/84901fd5fd54ad95418ef74bb578f5b210e30612)]:
  - @aio-proxy/plugin-sdk@0.11.0

## 0.10.0

### Minor Changes

- [#203](https://github.com/aio-proxy/aio-proxy/pull/203) [`076c67b`](https://github.com/aio-proxy/aio-proxy/commit/076c67ba698c4cd7a3756ef370adc7a62a530402) Thanks [@baranwang](https://github.com/baranwang)! - Add `aio-proxy provider import [path]` to copy supported CPA OAuth auth files into aio-proxy accounts. OAuth plugins can declare typed CPA credential importers through the plugin SDK, and the built-in ChatGPT, Google Antigravity, Kimi Code, and xAI Grok plugins now provide them.

### Patch Changes

- Updated dependencies [[`076c67b`](https://github.com/aio-proxy/aio-proxy/commit/076c67ba698c4cd7a3756ef370adc7a62a530402)]:
  - @aio-proxy/plugin-sdk@0.10.0

## 0.9.1

### Patch Changes

- [#197](https://github.com/aio-proxy/aio-proxy/pull/197) [`c9fe40d`](https://github.com/aio-proxy/aio-proxy/commit/c9fe40dfb7b1ad7fbadb94f4c9ce64ced43dc294) Thanks [@baranwang](https://github.com/baranwang)! - Compile OpenAI Responses custom tools to Grok-compatible function tools for xAI OAuth providers while preserving custom tool responses for clients.
- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.9.1

## 0.9.0

### Minor Changes

- [#187](https://github.com/aio-proxy/aio-proxy/pull/187) [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b) Thanks [@baranwang](https://github.com/baranwang)! - Add managed OpenCode, Pi, and oh-my-pi Agent integrations. Configure them with `aio-proxy agent configure` (floors: OpenCode 1.17.10, Pi 0.84.2, oh-my-pi 17.3.7; login with `opencode auth login --provider aio-proxy` or `/login aio-proxy`). `aio-proxy upgrade` refreshes managed adapters; reload or restart the Agent after configure or upgrade. Exact string KPI values no longer lose visible precision. The plugin SDK descriptor contract, brand, and host accepted version are restored to v1; v2 descriptors are rejected. The xAI artifact smoke gate now follows plugin API v1.

### Patch Changes

- [#192](https://github.com/aio-proxy/aio-proxy/pull/192) [`29a90c2`](https://github.com/aio-proxy/aio-proxy/commit/29a90c24c45d4e00ada1960ca4cfd492344f6535) Thanks [@baranwang](https://github.com/baranwang)! - Grok OAuth now sends current Grok CLI identity headers and strips Codex Desktop Responses fields that `cli-chat-proxy.grok.com` rejects or hangs on.
- Updated dependencies [[`87126aa`](https://github.com/aio-proxy/aio-proxy/commit/87126aadb95151258c8d1a4e52e0f3e854ee0e54), [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b), [`4bddead`](https://github.com/aio-proxy/aio-proxy/commit/4bddead355c37861e89dd57cf2a6a3514d4b35dc), [`9b6f0a3`](https://github.com/aio-proxy/aio-proxy/commit/9b6f0a3f26d6bb22fc20298dc203825dca818309)]:
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

## 0.6.4

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.6.4

## 0.6.3

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.6.3

## 0.6.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.6.0

## 0.5.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.2.0
