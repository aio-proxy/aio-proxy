# @aio-proxy/plugin-sdk

## 0.42.0

### Minor Changes

- [#498](https://github.com/aio-proxy/aio-proxy/pull/498) [`a2c3d0e`](https://github.com/aio-proxy/aio-proxy/commit/a2c3d0e304db29be37a7284202e17ac3373f0dbb) Thanks @baranwang - Add the OpenAI Decisions API for predicate, choice, and score evaluations. Same-protocol requests pass through, including inline and HTTP(S) images; other evaluation providers share SystemOne routing, fallback, and conversion. Usage includes cache pricing, converted responses always include the full usage object, and evaluations that cannot be converted are still billed. Plugins can recognize the new Decisions protocol.

### Patch Changes

- Updated dependencies [[`3758dc9`](https://github.com/aio-proxy/aio-proxy/commit/3758dc9ed72259d33df567cf69e8ef86c59d5ca9), [`a2c3d0e`](https://github.com/aio-proxy/aio-proxy/commit/a2c3d0e304db29be37a7284202e17ac3373f0dbb)]:
  - @aio-proxy/types@0.42.0
  - @aio-proxy/shared@0.42.0

## 0.41.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.41.1
  - @aio-proxy/types@0.41.1

## 0.41.0

### Patch Changes

- Updated dependencies [[`855383c`](https://github.com/aio-proxy/aio-proxy/commit/855383cd5f462aa5ad9bab48aab81d4123dcd659)]:
  - @aio-proxy/types@0.41.0
  - @aio-proxy/shared@0.41.0

## 0.40.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.40.0
  - @aio-proxy/types@0.40.0

## 0.39.1

### Patch Changes

- Updated dependencies [[`d5218bf`](https://github.com/aio-proxy/aio-proxy/commit/d5218bfaf68e0af8d9b97cc09ac90b3ebe2f8593)]:
  - @aio-proxy/types@0.39.1
  - @aio-proxy/shared@0.39.1

## 0.39.0

### Minor Changes

- [#486](https://github.com/aio-proxy/aio-proxy/pull/486) [`2763925`](https://github.com/aio-proxy/aio-proxy/commit/27639251609ad47a3d5265815c2a27bd7bc0abb9) Thanks @baranwang - Plugins can offer a vendor tool's existing local sign-in as an alternative to the browser OAuth flow.

- [#483](https://github.com/aio-proxy/aio-proxy/pull/483) [`946073c`](https://github.com/aio-proxy/aio-proxy/commit/946073caf8219dd6309498aba893b77993193ef1) Thanks @baranwang - Quota items can declare a `scope` — the whole account, or a list of model patterns — to tell aio-proxy which models are refused once that window is exhausted, so routing can skip the Provider for those models until the window resets. Items without a scope stay display-only.

### Patch Changes

- Updated dependencies [[`94024af`](https://github.com/aio-proxy/aio-proxy/commit/94024af667f4b691cef234a3f305d6561c5a9192), [`a59559d`](https://github.com/aio-proxy/aio-proxy/commit/a59559db8ba07d62f1f2b8dab50a77b5fba272b8), [`dd47aa2`](https://github.com/aio-proxy/aio-proxy/commit/dd47aa2333b53934df5b65deec9d72894c629bfa), [`13ff41d`](https://github.com/aio-proxy/aio-proxy/commit/13ff41dba0d21ef4ec79589e0598d1973fb72f64), [`b2e7941`](https://github.com/aio-proxy/aio-proxy/commit/b2e7941313846cea0c6e179f64c73cc137565e13)]:
  - @aio-proxy/types@0.39.0
  - @aio-proxy/shared@0.39.0

## 0.38.0

### Patch Changes

- [#468](https://github.com/aio-proxy/aio-proxy/pull/468) [`24d77d0`](https://github.com/aio-proxy/aio-proxy/commit/24d77d05fd4e27bfa918a568d904e71ce3593f3b) Thanks @baranwang - Preserve transport timings, retry failure reasons, and response attribution for each upstream HTTP send. Trace details now show send counts and indices, so retries with multiple responses no longer appear to be missing timing data.
- Updated dependencies [[`24d77d0`](https://github.com/aio-proxy/aio-proxy/commit/24d77d05fd4e27bfa918a568d904e71ce3593f3b)]:
  - @aio-proxy/shared@0.38.0
  - @aio-proxy/types@0.38.0

## 0.37.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.37.0
  - @aio-proxy/types@0.37.0

## 0.36.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.36.1
  - @aio-proxy/types@0.36.1

## 0.36.0

### Patch Changes

- Updated dependencies [[`dcb1ebd`](https://github.com/aio-proxy/aio-proxy/commit/dcb1ebd82b6fddd964c3083c83ff3c2d57c275be)]:
  - @aio-proxy/types@0.36.0
  - @aio-proxy/shared@0.36.0

## 0.35.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.35.1
  - @aio-proxy/types@0.35.1

## 0.35.0

### Patch Changes

- Updated dependencies [[`76e2bc6`](https://github.com/aio-proxy/aio-proxy/commit/76e2bc6a2405ab48dca41ffcfbcc22189602d349)]:
  - @aio-proxy/types@0.35.0
  - @aio-proxy/shared@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies [[`6dbb50d`](https://github.com/aio-proxy/aio-proxy/commit/6dbb50deb8a3f7540802e67484056c5bfcfecd54)]:
  - @aio-proxy/types@0.34.0
  - @aio-proxy/shared@0.34.0

## 0.33.4

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.33.4
  - @aio-proxy/types@0.33.4

## 0.33.3

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.33.3
  - @aio-proxy/types@0.33.3

## 0.33.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.33.2
  - @aio-proxy/types@0.33.2

## 0.33.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.33.1
  - @aio-proxy/types@0.33.1

## 0.33.0

### Minor Changes

- [#422](https://github.com/aio-proxy/aio-proxy/pull/422) [`de76673`](https://github.com/aio-proxy/aio-proxy/commit/de76673fe07ae3be9f3d7e3a84d1bd541ca07479) Thanks @baranwang - Plugin Provider fields can declare the protocols they accept. Guardian now asks for a TypeSafe System One Provider, and the model control lists that Provider's routed models instead of accepting any ID.

- [#422](https://github.com/aio-proxy/aio-proxy/pull/422) [`24a1468`](https://github.com/aio-proxy/aio-proxy/commit/24a14688083a14639af225a0d8d908373cf8f568) Thanks @baranwang - ChatGPT OAuth now offers optional Guardian approval strategies that evaluate with a selected System One Provider and model. The default keeps Codex behavior, and supported System One decisions can be final or send denials to the original model for review; unavailable evaluations fall back safely.

### Patch Changes

- Updated dependencies [[`24a1468`](https://github.com/aio-proxy/aio-proxy/commit/24a14688083a14639af225a0d8d908373cf8f568)]:
  - @aio-proxy/types@0.33.0
  - @aio-proxy/shared@0.33.0

## 0.32.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.32.0
  - @aio-proxy/types@0.32.0

## 0.31.0

### Minor Changes

- [#410](https://github.com/aio-proxy/aio-proxy/pull/410) [`f0b3105`](https://github.com/aio-proxy/aio-proxy/commit/f0b3105e4dc74a674303c89e1d2eb2e106b7b12b) Thanks @baranwang - Configure ChatGPT's User-Agent once on the Plugins page for all ChatGPT providers, without signing in again. The default follows the latest stable Codex version through cached, proxy-aware npm and GitHub lookups, with a fallback when both fail. Plugin options support simple Handlebars variables such as `{{latest_codex_rs_version}}`, and plugin form fields can declare default values. Previously saved provider-level User-Agent values are ignored.

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.31.0
  - @aio-proxy/types@0.31.0

## 0.30.0

### Patch Changes

- Updated dependencies [[`69867fc`](https://github.com/aio-proxy/aio-proxy/commit/69867fc1cf275d3f72f4ebea41a0ad8b4f398493)]:
  - @aio-proxy/types@0.30.0
  - @aio-proxy/shared@0.30.0

## 0.29.0

### Minor Changes

- [#399](https://github.com/aio-proxy/aio-proxy/pull/399) [`571c394`](https://github.com/aio-proxy/aio-proxy/commit/571c3944b9345196468a241212618def08955d9d) Thanks @baranwang - Trace timelines now use stable start ordering, standard HTTP and GenAI semantics, redacted upstream URLs, and accurate provider, failover, TTFT, and usage attribution. OAuth runtimes can explicitly declare their GenAI provider identity; raw transports can declare upstream URL templates, while converted calls omit templates unless authoritative transport metadata is available.

### Patch Changes

- Updated dependencies [[`571c394`](https://github.com/aio-proxy/aio-proxy/commit/571c3944b9345196468a241212618def08955d9d)]:
  - @aio-proxy/types@0.29.0
  - @aio-proxy/shared@0.29.0

## 0.28.0

### Minor Changes

- [#394](https://github.com/aio-proxy/aio-proxy/pull/394) [`21d30e3`](https://github.com/aio-proxy/aio-proxy/commit/21d30e321b902e2fba11801b23ce87aad6207334) Thanks @baranwang - Evaluate with TypeSafe System One. `POST /v1/systemone` routes System One requests like any other model request, with priority and weight failover and System One-shaped errors. Every answered evaluation records usage, so this traffic now bills. The dashboard offers the new `typesafe-systemone` protocol for providers and traces, and reports newer bundled AI SDK provider versions.

### Patch Changes

- Updated dependencies [[`2841175`](https://github.com/aio-proxy/aio-proxy/commit/2841175f2d07089d13beaa629857227cbcd9d0d4), [`25f9ec0`](https://github.com/aio-proxy/aio-proxy/commit/25f9ec0be50b28f8f5cc75f20a250e8b0bbc8ed7), [`21d30e3`](https://github.com/aio-proxy/aio-proxy/commit/21d30e321b902e2fba11801b23ce87aad6207334)]:
  - @aio-proxy/types@0.28.0
  - @aio-proxy/shared@0.28.0

## 0.27.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.27.1
  - @aio-proxy/types@0.27.1

## 0.27.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.27.0
  - @aio-proxy/types@0.27.0

## 0.26.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.26.0
  - @aio-proxy/types@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.25.0
  - @aio-proxy/types@0.25.0

## 0.24.0

### Minor Changes

- [#370](https://github.com/aio-proxy/aio-proxy/pull/370) [`1cb5c9f`](https://github.com/aio-proxy/aio-proxy/commit/1cb5c9f3fc91c5e48ef673eb7be0b9971942386e) Thanks @YePiXpert - Discover Grok OAuth image and video models instead of filtering them from the account catalog. Support image generation/editing and video creation, polling, and content retrieval with the same account. Plugins can optionally declare a video catalog without exposing video-only models as chat models.

### Patch Changes

- Updated dependencies [[`d50feb0`](https://github.com/aio-proxy/aio-proxy/commit/d50feb0764829686811aaff59b8134e47b493ea4)]:
  - @aio-proxy/types@0.24.0
  - @aio-proxy/shared@0.24.0

## 0.23.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.23.2
  - @aio-proxy/types@0.23.2

## 0.23.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.23.1
  - @aio-proxy/types@0.23.1

## 0.23.0

### Patch Changes

- Updated dependencies [[`6fd1738`](https://github.com/aio-proxy/aio-proxy/commit/6fd173878a3574113571b2cf8499e679f83e1b96)]:
  - @aio-proxy/types@0.23.0
  - @aio-proxy/shared@0.23.0

## 0.22.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.22.1
  - @aio-proxy/types@0.22.1

## 0.22.0

### Minor Changes

- [#339](https://github.com/aio-proxy/aio-proxy/pull/339) [`834f9b3`](https://github.com/aio-proxy/aio-proxy/commit/834f9b359f29b229e3930a0b435200d805361789) Thanks @baranwang - Add official OpenAI Videos ports: create, retrieve, content, delete, remix, edits, and extensions.

### Patch Changes

- Updated dependencies [[`c98e10c`](https://github.com/aio-proxy/aio-proxy/commit/c98e10c1decd66972d10561b3e0fdaa5aae84da0), [`2d05095`](https://github.com/aio-proxy/aio-proxy/commit/2d0509557bbb35a14046ab0a5dcc0cc5e9563b4f), [`834f9b3`](https://github.com/aio-proxy/aio-proxy/commit/834f9b359f29b229e3930a0b435200d805361789)]:
  - @aio-proxy/types@0.22.0
  - @aio-proxy/shared@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.21.0
  - @aio-proxy/types@0.21.0

## 0.20.5

### Patch Changes

- Updated dependencies [[`7ca4736`](https://github.com/aio-proxy/aio-proxy/commit/7ca473664bff145f4f27570c2d4a36bd7179c854)]:
  - @aio-proxy/types@0.20.5
  - @aio-proxy/shared@0.20.5

## 0.20.4

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.20.4
  - @aio-proxy/types@0.20.4

## 0.20.3

### Patch Changes

- Updated dependencies [[`6eca232`](https://github.com/aio-proxy/aio-proxy/commit/6eca2326aec9908634e4975448485b9972ea0ee8)]:
  - @aio-proxy/types@0.20.3
  - @aio-proxy/shared@0.20.3

## 0.20.2

### Patch Changes

- [#316](https://github.com/aio-proxy/aio-proxy/pull/316) [`3b4c12e`](https://github.com/aio-proxy/aio-proxy/commit/3b4c12e0e3f5b502cacf4c22aa9a88188608c3da) Thanks @baranwang - The plugin SDK now exports shared abortableSleep and dedupeQuotaItemIds helpers, preserving OAuth cancellation reasons and provider-specific quota IDs. Removed unused UI and internal wrappers, plus the unused AioModelMessage and AioStreamPart schemas and associated types from @aio-proxy/types.
- Updated dependencies [[`3b4c12e`](https://github.com/aio-proxy/aio-proxy/commit/3b4c12e0e3f5b502cacf4c22aa9a88188608c3da)]:
  - @aio-proxy/types@0.20.2
  - @aio-proxy/shared@0.20.2

## 0.20.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.20.1
  - @aio-proxy/types@0.20.1

## 0.20.0

### Minor Changes

- [#298](https://github.com/aio-proxy/aio-proxy/pull/298) [`13a6c91`](https://github.com/aio-proxy/aio-proxy/commit/13a6c9153739049dab5443dd3ac7d570f7e80690) Thanks @baranwang - Serve the Codex Live / Realtime endpoint family as signaling passthrough.

- [#301](https://github.com/aio-proxy/aio-proxy/pull/301) [`681b039`](https://github.com/aio-proxy/aio-proxy/commit/681b039164281d7ab28c09ce1a61aae064caa6a0) Thanks @baranwang - Add the OpenAI Audio inbound protocol.

- [#308](https://github.com/aio-proxy/aio-proxy/pull/308) [`8b02edd`](https://github.com/aio-proxy/aio-proxy/commit/8b02edd711a54102661c41199a60f10396f7dce3) Thanks @baranwang - Subscription quota bars now mark where an even burn would have left the allowance by now, turning
  red when the window is being spent faster than that and drawing nothing while it tracks even. The
  marker appears wherever the provider reports how long the window lasts, which the bundled OAuth
  plugins now do; plugins can opt in through the new optional `OAuthQuotaItem.windowMinutes`. The
  reading is also spoken by the bar's accessible value text.

### Patch Changes

- Updated dependencies [[`692795c`](https://github.com/aio-proxy/aio-proxy/commit/692795c49f26e93e93af79cb611043a1e82c307a), [`84b206c`](https://github.com/aio-proxy/aio-proxy/commit/84b206c1d2f296748d2b86cedf0ef97c2b65d8e2), [`681b039`](https://github.com/aio-proxy/aio-proxy/commit/681b039164281d7ab28c09ce1a61aae064caa6a0)]:
  - @aio-proxy/types@0.20.0
  - @aio-proxy/shared@0.20.0

## 0.19.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.19.2
  - @aio-proxy/types@0.19.2

## 0.19.1

### Patch Changes

- [#284](https://github.com/aio-proxy/aio-proxy/pull/284) [`80f8b9d`](https://github.com/aio-proxy/aio-proxy/commit/80f8b9d10eef15214fc3f55342ccf097fc00b6ef) Thanks @baranwang - Refresh dependencies across the workspace, including `eventsource-parser` 4 for SSE parsing, `hono` 4.13.7 for the proxy and Dashboard routes, and `jose` 6.2.12 for token handling. Behavior is unchanged.
- Updated dependencies []:
  - @aio-proxy/shared@0.19.1
  - @aio-proxy/types@0.19.1

## 0.19.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.19.0
  - @aio-proxy/types@0.19.0

## 0.18.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.18.1
  - @aio-proxy/types@0.18.1

## 0.18.0

### Patch Changes

- [#274](https://github.com/aio-proxy/aio-proxy/pull/274) [`1cf2838`](https://github.com/aio-proxy/aio-proxy/commit/1cf2838bb8cec1ed8e3354646b1b39d2695d3664) Thanks @baranwang - plugin-sdk: document and enforce the OAuth quota reset contract — report `resetCredits` only alongside a `reset` implementation, and treat every `reset` call as a new intentional redemption rather than a retry of the last one.
- Updated dependencies [[`9608e07`](https://github.com/aio-proxy/aio-proxy/commit/9608e070b5faf585cf591fa007e190e7493362c3)]:
  - @aio-proxy/types@0.18.0
  - @aio-proxy/shared@0.18.0

## 0.17.0

### Minor Changes

- [#260](https://github.com/aio-proxy/aio-proxy/pull/260) [`b7d9520`](https://github.com/aio-proxy/aio-proxy/commit/b7d9520cdc280d1b6785c53d4d079b5db2d5311f) Thanks @baranwang - Refresh an OAuth Provider's credential on demand from the dashboard Provider card menu.

### Patch Changes

- Updated dependencies [[`b7d9520`](https://github.com/aio-proxy/aio-proxy/commit/b7d9520cdc280d1b6785c53d4d079b5db2d5311f), [`2c6da7a`](https://github.com/aio-proxy/aio-proxy/commit/2c6da7a8ccd7246bcc81daf83001e046ce376e16), [`6d02c87`](https://github.com/aio-proxy/aio-proxy/commit/6d02c876980ee55963fd0db6298adffe23bc42a2), [`8150738`](https://github.com/aio-proxy/aio-proxy/commit/815073848e78ed7195f7f6d97077f3b495d103bd)]:
  - @aio-proxy/types@0.17.0
  - @aio-proxy/shared@0.17.0

## 0.16.0

### Patch Changes

- [#252](https://github.com/aio-proxy/aio-proxy/pull/252) [`142cc1b`](https://github.com/aio-proxy/aio-proxy/commit/142cc1b419b0109585a53f020343d0eb72b6673f) Thanks @wqsworks - core: terminate converted OpenAI Responses stream failures with `response.failed` and normalize cumulative OpenAI-compatible tool argument snapshots.
- Updated dependencies []:
  - @aio-proxy/shared@0.16.0
  - @aio-proxy/types@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [[`1daece3`](https://github.com/aio-proxy/aio-proxy/commit/1daece3dd2dad3ddfe86c12784ef379e99424c91)]:
  - @aio-proxy/types@0.15.0
  - @aio-proxy/shared@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.14.0
  - @aio-proxy/types@0.14.0

## 0.13.0

### Minor Changes

- [#239](https://github.com/aio-proxy/aio-proxy/pull/239) [`b1f5bff`](https://github.com/aio-proxy/aio-proxy/commit/b1f5bff2f2e92abfd54b90fb32b29b4b145e8c1d) Thanks @baranwang - Redesign the dashboard Provider list as a card grid and surface OAuth remaining quota.

### Patch Changes

- [#238](https://github.com/aio-proxy/aio-proxy/pull/238) [`99755b5`](https://github.com/aio-proxy/aio-proxy/commit/99755b58b7492f9da4161ac429325dd319ba48f8) Thanks @baranwang - core: preserve stable session affinity across supported language protocols and native Gemini Interactions continuations.
- Updated dependencies [[`b1f5bff`](https://github.com/aio-proxy/aio-proxy/commit/b1f5bff2f2e92abfd54b90fb32b29b4b145e8c1d)]:
  - @aio-proxy/types@0.13.0
  - @aio-proxy/shared@0.13.0

## 0.12.3

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.12.3
  - @aio-proxy/types@0.12.3

## 0.12.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.12.2
  - @aio-proxy/types@0.12.2

## 0.12.1

### Patch Changes

- Updated dependencies [[`70756e3`](https://github.com/aio-proxy/aio-proxy/commit/70756e3fe1bd63be4871bd2dc9901b159db47de6)]:
  - @aio-proxy/types@0.12.1
  - @aio-proxy/shared@0.12.1

## 0.12.0

### Minor Changes

- [#226](https://github.com/aio-proxy/aio-proxy/pull/226) [`9c16d0b`](https://github.com/aio-proxy/aio-proxy/commit/9c16d0b56a954563a296e5363869d5bae12ffda2) Thanks @baranwang - Configure model metadata once per exposed model at `router.models.<slug>.metadata`, including `extend`, with per-Provider `cost` and `limit` overrides under `router.models.<slug>.providers.<id>`.

### Patch Changes

- [#228](https://github.com/aio-proxy/aio-proxy/pull/228) [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca) Thanks @baranwang - Upgrade Zod to 4.5 and compile inbound protocol request schemas with `z.compile()` (except OpenAI Responses, whose unknown-item transform logs). Upgrade es-toolkit to 1.52. Use `isPlainObject` for JSON and other plain data. Structural plugin/SDK contracts that may be class instances use `isRecord` from the published `@aio-proxy/shared` leaf package. Replace spread-Set arrays with `uniq` in packages that already depend on es-toolkit.
- Updated dependencies [[`9c16d0b`](https://github.com/aio-proxy/aio-proxy/commit/9c16d0b56a954563a296e5363869d5bae12ffda2), [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca)]:
  - @aio-proxy/types@0.12.0
  - @aio-proxy/shared@0.12.0

## 0.11.2

## 0.11.1

## 0.11.0

### Minor Changes

- [#215](https://github.com/aio-proxy/aio-proxy/pull/215) [`4ce6cee`](https://github.com/aio-proxy/aio-proxy/commit/4ce6cee2412a13cc18d250af52335f456ad1db13) Thanks @baranwang - Add Gemini Interactions as an inbound protocol at `POST /v1beta/interactions`.

- [#212](https://github.com/aio-proxy/aio-proxy/pull/212) [`64718ae`](https://github.com/aio-proxy/aio-proxy/commit/64718aea31a3a26ef691443246163713278b5e2b) Thanks @baranwang - openai: add Completions and Responses compact ports `POST /v1/completions` and `POST /v1/responses/compact` now use the existing language-generation pipeline.

- [#213](https://github.com/aio-proxy/aio-proxy/pull/213) [`b6e65cd`](https://github.com/aio-proxy/aio-proxy/commit/b6e65cddeaab8ce356f1d5f7c0f0f7e98a401608) Thanks @baranwang - Add OpenAI Images inbound (`POST /v1/images/generations` and `POST /v1/images/edits`) with same-protocol raw passthrough and `imageModel` convert.

- [#214](https://github.com/aio-proxy/aio-proxy/pull/214) [`84901fd`](https://github.com/aio-proxy/aio-proxy/commit/84901fd5fd54ad95418ef74bb578f5b210e30612) Thanks @baranwang - Add inbound OpenAI Embeddings and Gemini embed/batch embed through same-protocol raw, embedding convert, and fallback.

## 0.10.0

### Minor Changes

- [#203](https://github.com/aio-proxy/aio-proxy/pull/203) [`076c67b`](https://github.com/aio-proxy/aio-proxy/commit/076c67ba698c4cd7a3756ef370adc7a62a530402) Thanks @baranwang - Add `aio-proxy provider import [path]` to copy supported CPA OAuth auth files into aio-proxy accounts. OAuth plugins can declare typed CPA credential importers through the plugin SDK, and the built-in ChatGPT, Google Antigravity, Kimi Code, and xAI Grok plugins now provide them.

## 0.9.1

## 0.9.0

### Minor Changes

- [#189](https://github.com/aio-proxy/aio-proxy/pull/189) [`87126aa`](https://github.com/aio-proxy/aio-proxy/commit/87126aadb95151258c8d1a4e52e0f3e854ee0e54) Thanks @baranwang - Generate Antigravity default aliases from live model discovery and insert newly seen logical ids on refresh.

- [#187](https://github.com/aio-proxy/aio-proxy/pull/187) [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b) Thanks @baranwang - Add managed OpenCode, Pi, and oh-my-pi Agent integrations.

### Patch Changes

- [#188](https://github.com/aio-proxy/aio-proxy/pull/188) [`4bddead`](https://github.com/aio-proxy/aio-proxy/commit/4bddead355c37861e89dd57cf2a6a3514d4b35dc) Thanks @baranwang - core: pin the bundled Bun runtime to 1.4.0 and restore streamed request bodies through HTTP proxies. Bun 1.4.0 ships the `fetch` + `proxy` `ReadableStream` body fix, so `createProxyFetch` no longer buffers the request. Plugin runtime compatibility is now Bun `>=1.4.0`. Compiled macOS binaries are ad-hoc re-signed after `bun build --compile` so they launch on macOS 27. Release runs on macOS so that signature is applied when the CLI is actually published.

- [#184](https://github.com/aio-proxy/aio-proxy/pull/184) [`9b6f0a3`](https://github.com/aio-proxy/aio-proxy/commit/9b6f0a3f26d6bb22fc20298dc203825dca818309) Thanks @baranwang - Cursor first-login now writes family aliases from AvailableModels, so clients can request names like `claude-sonnet-4-6` / `grok-4.6` and match thinking, effort, and speed onto the live wire slug.

## 0.8.0

## 0.7.0

### Minor Changes

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks @baranwang - Plugins move display identity into descriptor metadata (`displayName` / `accountLabel`; remove legacy `label` and OAuth capability icons). Add Cursor account OAuth/provider support. Normalize OpenAI Responses errors to `response.failed` for Codex.

## 0.6.4

## 0.6.3

## 0.6.2

## 0.6.1

## 0.6.0

## 0.5.2

## 0.5.1

## 0.5.0

## 0.4.0

## 0.3.0

## 0.2.1

## 0.2.0
