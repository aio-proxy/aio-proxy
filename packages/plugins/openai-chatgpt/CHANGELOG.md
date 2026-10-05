# @aio-proxy/plugin-openai-chatgpt

## 0.40.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.40.0
  - @aio-proxy/types@0.40.0

## 0.39.1

### Patch Changes

- [#491](https://github.com/aio-proxy/aio-proxy/pull/491) [`d5218bf`](https://github.com/aio-proxy/aio-proxy/commit/d5218bfaf68e0af8d9b97cc09ac90b3ebe2f8593) Thanks @baranwang - Allow large image histories and compressed recovery requests with a configurable 256 MiB request limit, including ChatGPT and Provider body transforms. Bound body logs independently to 64 MiB per hop and direction while preserving full forwarding, request diagnostics, and privacy protections.
- Updated dependencies [[`d5218bf`](https://github.com/aio-proxy/aio-proxy/commit/d5218bfaf68e0af8d9b97cc09ac90b3ebe2f8593)]:
  - @aio-proxy/types@0.39.1
  - @aio-proxy/plugin-sdk@0.39.1

## 0.39.0

### Minor Changes

- [#486](https://github.com/aio-proxy/aio-proxy/pull/486) [`a59559d`](https://github.com/aio-proxy/aio-proxy/commit/a59559db8ba07d62f1f2b8dab50a77b5fba272b8) Thanks @baranwang - ChatGPT and GitHub Copilot Providers can use the sign-in Codex or Copilot already keeps on this machine instead of a browser login; aio-proxy keeps Codex signed in when it refreshes, and removing the Provider never signs the tool out.

- [#483](https://github.com/aio-proxy/aio-proxy/pull/483) [`4a26f10`](https://github.com/aio-proxy/aio-proxy/commit/4a26f10bde2ee22dccd0312c484327bc92bf1578) Thanks @baranwang - A Kimi Code, Muse Code, ChatGPT, or Cursor subscription whose quota window is known to be exhausted is now skipped for the models that window covers until it resets, instead of being attempted and failing on every request. Quota that is unknown or older than 10 minutes never skips a Provider. When every candidate is exhausted or cooling down, the client gets a 429 with `Retry-After` set to the earliest reset, and the request trace lists the skipped Providers and why.

### Patch Changes

- [#482](https://github.com/aio-proxy/aio-proxy/pull/482) [`a4d8780`](https://github.com/aio-proxy/aio-proxy/commit/a4d8780eeb767e00a56c151f657f888021ab69f5) Thanks @baranwang - Guardian System One approvals now evaluate the supplied review policy, including custom rules, without falling back just because its wording or formatting changed. Requests without review instructions, incompatible requests, unusable results, and failed evaluations retain the original-model fallback with diagnostic reason codes.
- Updated dependencies [[`94024af`](https://github.com/aio-proxy/aio-proxy/commit/94024af667f4b691cef234a3f305d6561c5a9192), [`a59559d`](https://github.com/aio-proxy/aio-proxy/commit/a59559db8ba07d62f1f2b8dab50a77b5fba272b8), [`2763925`](https://github.com/aio-proxy/aio-proxy/commit/27639251609ad47a3d5265815c2a27bd7bc0abb9), [`dd47aa2`](https://github.com/aio-proxy/aio-proxy/commit/dd47aa2333b53934df5b65deec9d72894c629bfa), [`946073c`](https://github.com/aio-proxy/aio-proxy/commit/946073caf8219dd6309498aba893b77993193ef1), [`13ff41d`](https://github.com/aio-proxy/aio-proxy/commit/13ff41dba0d21ef4ec79589e0598d1973fb72f64), [`b2e7941`](https://github.com/aio-proxy/aio-proxy/commit/b2e7941313846cea0c6e179f64c73cc137565e13)]:
  - @aio-proxy/types@0.39.0
  - @aio-proxy/plugin-sdk@0.39.0

## 0.38.0

### Patch Changes

- Updated dependencies [[`24d77d0`](https://github.com/aio-proxy/aio-proxy/commit/24d77d05fd4e27bfa918a568d904e71ce3593f3b)]:
  - @aio-proxy/plugin-sdk@0.38.0
  - @aio-proxy/types@0.38.0

## 0.37.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.37.0
  - @aio-proxy/types@0.37.0

## 0.36.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.36.1
  - @aio-proxy/types@0.36.1

## 0.36.0

### Patch Changes

- Updated dependencies [[`dcb1ebd`](https://github.com/aio-proxy/aio-proxy/commit/dcb1ebd82b6fddd964c3083c83ff3c2d57c275be)]:
  - @aio-proxy/types@0.36.0
  - @aio-proxy/plugin-sdk@0.36.0

## 0.35.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.35.1
  - @aio-proxy/types@0.35.1

## 0.35.0

### Patch Changes

- Updated dependencies [[`76e2bc6`](https://github.com/aio-proxy/aio-proxy/commit/76e2bc6a2405ab48dca41ffcfbcc22189602d349)]:
  - @aio-proxy/types@0.35.0
  - @aio-proxy/plugin-sdk@0.35.0

## 0.34.0

### Patch Changes

- [#443](https://github.com/aio-proxy/aio-proxy/pull/443) [`b2fb4a4`](https://github.com/aio-proxy/aio-proxy/commit/b2fb4a4c6fb246ee56502063ed410be19aad4f44) Thanks @baranwang - Optional Guardian System One strategies now work for eligible approval requests even when codex-auto-review is not independently configured as a route, while ordinary requests and the default strategy remain unchanged.
- Updated dependencies [[`6dbb50d`](https://github.com/aio-proxy/aio-proxy/commit/6dbb50deb8a3f7540802e67484056c5bfcfecd54)]:
  - @aio-proxy/types@0.34.0
  - @aio-proxy/plugin-sdk@0.34.0

## 0.33.4

### Patch Changes

- [#430](https://github.com/aio-proxy/aio-proxy/pull/430) [`3279743`](https://github.com/aio-proxy/aio-proxy/commit/3279743ec7c8447decba5df6c8836405071261e1) Thanks @baranwang - Guardian evaluation now runs on the OpenAI Responses provider selected for that request, not only on a ChatGPT transport. A direct allow or deny does not charge the selected provider; evaluation cost stays on the configured evaluation provider.
- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.33.4
  - @aio-proxy/types@0.33.4

## 0.33.3

### Patch Changes

- [#428](https://github.com/aio-proxy/aio-proxy/pull/428) [`cd5971b`](https://github.com/aio-proxy/aio-proxy/commit/cd5971b2ab87856457a9291a245d74d0e5049739) Thanks @baranwang - Guardian approval now keeps requests eligible when their transcript contains paired custom tool calls, instead of falling back before evaluation.
- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.33.3
  - @aio-proxy/types@0.33.3

## 0.33.2

### Patch Changes

- [#426](https://github.com/aio-proxy/aio-proxy/pull/426) [`7a104ac`](https://github.com/aio-proxy/aio-proxy/commit/7a104ac9de628d0d39fb830a710c8ad8366ac93a) Thanks @baranwang - Guardian approval now accepts the current Codex review transcript, including prior review rounds, assistant replies, and the assessment note inside the final approval envelope.
- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.33.2
  - @aio-proxy/types@0.33.2

## 0.33.1

### Patch Changes

- [#424](https://github.com/aio-proxy/aio-proxy/pull/424) [`20b7733`](https://github.com/aio-proxy/aio-proxy/commit/20b7733ce0b7a6276e82bbfc582bb25923aac37a) Thanks @baranwang - Guardian approval now follows the Guardian agent marker on any ChatGPT model, instead of requiring the request to be routed as codex-auto-review.
- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.33.1
  - @aio-proxy/types@0.33.1

## 0.33.0

### Minor Changes

- [#422](https://github.com/aio-proxy/aio-proxy/pull/422) [`24a1468`](https://github.com/aio-proxy/aio-proxy/commit/24a14688083a14639af225a0d8d908373cf8f568) Thanks @baranwang - ChatGPT OAuth now offers optional Guardian approval strategies that evaluate with a selected System One Provider and model. The default keeps Codex behavior, and supported System One decisions can be final or send denials to the original model for review; unavailable evaluations fall back safely.

### Patch Changes

- Updated dependencies [[`de76673`](https://github.com/aio-proxy/aio-proxy/commit/de76673fe07ae3be9f3d7e3a84d1bd541ca07479), [`24a1468`](https://github.com/aio-proxy/aio-proxy/commit/24a14688083a14639af225a0d8d908373cf8f568)]:
  - @aio-proxy/plugin-sdk@0.33.0
  - @aio-proxy/types@0.33.0

## 0.32.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.32.0
  - @aio-proxy/types@0.32.0

## 0.31.0

### Minor Changes

- [#410](https://github.com/aio-proxy/aio-proxy/pull/410) [`f0b3105`](https://github.com/aio-proxy/aio-proxy/commit/f0b3105e4dc74a674303c89e1d2eb2e106b7b12b) Thanks @baranwang - Configure ChatGPT's User-Agent once on the Plugins page for all ChatGPT providers, without signing in again. The default follows the latest stable Codex version through cached, proxy-aware npm and GitHub lookups, with a fallback when both fail. Plugin options support simple Handlebars variables such as `{{latest_codex_rs_version}}`, and plugin form fields can declare default values. Previously saved provider-level User-Agent values are ignored.

### Patch Changes

- Updated dependencies [[`f0b3105`](https://github.com/aio-proxy/aio-proxy/commit/f0b3105e4dc74a674303c89e1d2eb2e106b7b12b)]:
  - @aio-proxy/plugin-sdk@0.31.0
  - @aio-proxy/types@0.31.0

## 0.30.0

### Minor Changes

- [#407](https://github.com/aio-proxy/aio-proxy/pull/407) [`fc9ee8c`](https://github.com/aio-proxy/aio-proxy/commit/fc9ee8c2d31bcdc58bc5709b3d0e2a451b2004f2) Thanks @baranwang - ChatGPT accounts can set a fixed user agent and optionally keep the inbound user agent when a model or image request comes from a Codex client. The fixed value is also used for realtime requests. Accounts that leave both unset keep the previous fixed user agent.

### Patch Changes

- Updated dependencies [[`69867fc`](https://github.com/aio-proxy/aio-proxy/commit/69867fc1cf275d3f72f4ebea41a0ad8b4f398493)]:
  - @aio-proxy/types@0.30.0
  - @aio-proxy/plugin-sdk@0.30.0

## 0.29.0

### Minor Changes

- [#399](https://github.com/aio-proxy/aio-proxy/pull/399) [`571c394`](https://github.com/aio-proxy/aio-proxy/commit/571c3944b9345196468a241212618def08955d9d) Thanks @baranwang - Trace timelines now use stable start ordering, standard HTTP and GenAI semantics, redacted upstream URLs, and accurate provider, failover, TTFT, and usage attribution. OAuth runtimes can explicitly declare their GenAI provider identity; raw transports can declare upstream URL templates, while converted calls omit templates unless authoritative transport metadata is available.

### Patch Changes

- Updated dependencies [[`571c394`](https://github.com/aio-proxy/aio-proxy/commit/571c3944b9345196468a241212618def08955d9d)]:
  - @aio-proxy/plugin-sdk@0.29.0
  - @aio-proxy/types@0.29.0

## 0.28.0

### Patch Changes

- Updated dependencies [[`2841175`](https://github.com/aio-proxy/aio-proxy/commit/2841175f2d07089d13beaa629857227cbcd9d0d4), [`25f9ec0`](https://github.com/aio-proxy/aio-proxy/commit/25f9ec0be50b28f8f5cc75f20a250e8b0bbc8ed7), [`21d30e3`](https://github.com/aio-proxy/aio-proxy/commit/21d30e321b902e2fba11801b23ce87aad6207334)]:
  - @aio-proxy/types@0.28.0
  - @aio-proxy/plugin-sdk@0.28.0

## 0.27.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.27.1
  - @aio-proxy/types@0.27.1

## 0.27.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.27.0
  - @aio-proxy/types@0.27.0

## 0.26.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.26.0
  - @aio-proxy/types@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.25.0
  - @aio-proxy/types@0.25.0

## 0.24.0

### Patch Changes

- [#370](https://github.com/aio-proxy/aio-proxy/pull/370) [`9de6d0e`](https://github.com/aio-proxy/aio-proxy/commit/9de6d0ec7fde99c9de87f993d3c1fb8f890690fe) Thanks @YePiXpert - Fix OpenAI ChatGPT model tests and Responses requests failing because the Codex backend rejects max_output_tokens. The ChatGPT plugin now omits this unsupported output limit.
- Updated dependencies [[`1cb5c9f`](https://github.com/aio-proxy/aio-proxy/commit/1cb5c9f3fc91c5e48ef673eb7be0b9971942386e), [`d50feb0`](https://github.com/aio-proxy/aio-proxy/commit/d50feb0764829686811aaff59b8134e47b493ea4)]:
  - @aio-proxy/plugin-sdk@0.24.0
  - @aio-proxy/types@0.24.0

## 0.23.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.23.2
  - @aio-proxy/types@0.23.2

## 0.23.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.23.1
  - @aio-proxy/types@0.23.1

## 0.23.0

### Patch Changes

- Updated dependencies [[`6fd1738`](https://github.com/aio-proxy/aio-proxy/commit/6fd173878a3574113571b2cf8499e679f83e1b96)]:
  - @aio-proxy/types@0.23.0
  - @aio-proxy/plugin-sdk@0.23.0

## 0.22.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.22.1
  - @aio-proxy/types@0.22.1

## 0.22.0

### Patch Changes

- Updated dependencies [[`c98e10c`](https://github.com/aio-proxy/aio-proxy/commit/c98e10c1decd66972d10561b3e0fdaa5aae84da0), [`2d05095`](https://github.com/aio-proxy/aio-proxy/commit/2d0509557bbb35a14046ab0a5dcc0cc5e9563b4f), [`834f9b3`](https://github.com/aio-proxy/aio-proxy/commit/834f9b359f29b229e3930a0b435200d805361789)]:
  - @aio-proxy/types@0.22.0
  - @aio-proxy/plugin-sdk@0.22.0

## 0.21.0

### Minor Changes

- [#341](https://github.com/aio-proxy/aio-proxy/pull/341) [`9b1547a`](https://github.com/aio-proxy/aio-proxy/commit/9b1547a263492ba9753fea3eb4761ad434d302f8) Thanks @baranwang - ChatGPT OAuth providers now expose `gpt-image-2.5-sunburst` and `gpt-image-2.5-flare` on `/v1/images/generations` and `/v1/images/edits`. Blank `model` still defaults to `gpt-image-2`.

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.21.0
  - @aio-proxy/types@0.21.0

## 0.20.5

### Patch Changes

- Updated dependencies [[`7ca4736`](https://github.com/aio-proxy/aio-proxy/commit/7ca473664bff145f4f27570c2d4a36bd7179c854)]:
  - @aio-proxy/types@0.20.5
  - @aio-proxy/plugin-sdk@0.20.5

## 0.20.4

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.20.4
  - @aio-proxy/types@0.20.4

## 0.20.3

### Patch Changes

- Updated dependencies [[`6eca232`](https://github.com/aio-proxy/aio-proxy/commit/6eca2326aec9908634e4975448485b9972ea0ee8)]:
  - @aio-proxy/types@0.20.3
  - @aio-proxy/plugin-sdk@0.20.3

## 0.20.2

### Patch Changes

- [#316](https://github.com/aio-proxy/aio-proxy/pull/316) [`3b4c12e`](https://github.com/aio-proxy/aio-proxy/commit/3b4c12e0e3f5b502cacf4c22aa9a88188608c3da) Thanks @baranwang - The plugin SDK now exports shared abortableSleep and dedupeQuotaItemIds helpers, preserving OAuth cancellation reasons and provider-specific quota IDs. Removed unused UI and internal wrappers, plus the unused AioModelMessage and AioStreamPart schemas and associated types from @aio-proxy/types.
- Updated dependencies [[`3b4c12e`](https://github.com/aio-proxy/aio-proxy/commit/3b4c12e0e3f5b502cacf4c22aa9a88188608c3da)]:
  - @aio-proxy/types@0.20.2
  - @aio-proxy/plugin-sdk@0.20.2

## 0.20.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.20.1
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

- Updated dependencies [[`13a6c91`](https://github.com/aio-proxy/aio-proxy/commit/13a6c9153739049dab5443dd3ac7d570f7e80690), [`692795c`](https://github.com/aio-proxy/aio-proxy/commit/692795c49f26e93e93af79cb611043a1e82c307a), [`681b039`](https://github.com/aio-proxy/aio-proxy/commit/681b039164281d7ab28c09ce1a61aae064caa6a0), [`8b02edd`](https://github.com/aio-proxy/aio-proxy/commit/8b02edd711a54102661c41199a60f10396f7dce3)]:
  - @aio-proxy/plugin-sdk@0.20.0
  - @aio-proxy/types@0.20.0

## 0.19.2

### Patch Changes

- [#286](https://github.com/aio-proxy/aio-proxy/pull/286) [`981e765`](https://github.com/aio-proxy/aio-proxy/commit/981e765965a881af845aff413db711f779ff2ffb) Thanks @baranwang - Drop reasoning item ids the ChatGPT Codex backend never persisted.

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

- [#277](https://github.com/aio-proxy/aio-proxy/pull/277) [`e2d8a23`](https://github.com/aio-proxy/aio-proxy/commit/e2d8a2381cb6c9f32dac2c26d2dd476934d2a71c) Thanks @baranwang - Surface the newest ChatGPT (Codex) models again. The pinned `codex-tui` client version was stale, and the upstream model catalog gates each model on its `minimal_client_version`, so the `gpt-5.6` family and `gpt-6-astra` were silently missing from ChatGPT OAuth Providers.
- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.18.1
  - @aio-proxy/types@0.18.1

## 0.18.0

### Minor Changes

- [#274](https://github.com/aio-proxy/aio-proxy/pull/274) [`1cf2838`](https://github.com/aio-proxy/aio-proxy/commit/1cf2838bb8cec1ed8e3354646b1b39d2695d3664) Thanks @baranwang - Redeem ChatGPT rate-limit reset credits from the Dashboard.

### Patch Changes

- Updated dependencies [[`9608e07`](https://github.com/aio-proxy/aio-proxy/commit/9608e070b5faf585cf591fa007e190e7493362c3), [`1cf2838`](https://github.com/aio-proxy/aio-proxy/commit/1cf2838bb8cec1ed8e3354646b1b39d2695d3664)]:
  - @aio-proxy/types@0.18.0
  - @aio-proxy/plugin-sdk@0.18.0

## 0.17.0

### Minor Changes

- [#259](https://github.com/aio-proxy/aio-proxy/pull/259) [`44a978e`](https://github.com/aio-proxy/aio-proxy/commit/44a978eb2a58a1e36c9c5cd3fd933f082995580b) Thanks @baranwang - ChatGPT OAuth providers now discover models from the signed-in account's own Codex endpoint instead of a published `models.json` snapshot, so the exposed list matches what the account can actually call.

- [#260](https://github.com/aio-proxy/aio-proxy/pull/260) [`b7d9520`](https://github.com/aio-proxy/aio-proxy/commit/b7d9520cdc280d1b6785c53d4d079b5db2d5311f) Thanks @baranwang - Refresh an OAuth Provider's credential on demand from the dashboard Provider card menu.

### Patch Changes

- Updated dependencies [[`b7d9520`](https://github.com/aio-proxy/aio-proxy/commit/b7d9520cdc280d1b6785c53d4d079b5db2d5311f), [`2c6da7a`](https://github.com/aio-proxy/aio-proxy/commit/2c6da7a8ccd7246bcc81daf83001e046ce376e16), [`6d02c87`](https://github.com/aio-proxy/aio-proxy/commit/6d02c876980ee55963fd0db6298adffe23bc42a2), [`8150738`](https://github.com/aio-proxy/aio-proxy/commit/815073848e78ed7195f7f6d97077f3b495d103bd)]:
  - @aio-proxy/plugin-sdk@0.17.0
  - @aio-proxy/types@0.17.0

## 0.16.0

### Minor Changes

- [#249](https://github.com/aio-proxy/aio-proxy/pull/249) [`e5e18af`](https://github.com/aio-proxy/aio-proxy/commit/e5e18af5f48f54c9dcc8e823fbcda137a97ad4b5) Thanks @baranwang - openai-chatgpt: report ChatGPT OAuth quota in the dashboard

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

- [#230](https://github.com/aio-proxy/aio-proxy/pull/230) [`e674d9a`](https://github.com/aio-proxy/aio-proxy/commit/e674d9a225d36d03fb388c223a6559beff6adb4d) Thanks @baranwang - oauth: show normalized account emails for connected OAuth providers
- Updated dependencies [[`70756e3`](https://github.com/aio-proxy/aio-proxy/commit/70756e3fe1bd63be4871bd2dc9901b159db47de6)]:
  - @aio-proxy/types@0.12.1
  - @aio-proxy/plugin-sdk@0.12.1

## 0.12.0

### Minor Changes

- [#226](https://github.com/aio-proxy/aio-proxy/pull/226) [`9c16d0b`](https://github.com/aio-proxy/aio-proxy/commit/9c16d0b56a954563a296e5363869d5bae12ffda2) Thanks @baranwang - Configure model metadata once per exposed model at `router.models.<slug>.metadata`, including `extend`, with per-Provider `cost` and `limit` overrides under `router.models.<slug>.providers.<id>`.

### Patch Changes

- [#228](https://github.com/aio-proxy/aio-proxy/pull/228) [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca) Thanks @baranwang - Upgrade Zod to 4.5 and compile inbound protocol request schemas with `z.compile()` (except OpenAI Responses, whose unknown-item transform logs). Upgrade es-toolkit to 1.52. Use `isPlainObject` for JSON and other plain data. Structural plugin/SDK contracts that may be class instances use `isRecord` from the published `@aio-proxy/shared` leaf package. Replace spread-Set arrays with `uniq` in packages that already depend on es-toolkit.
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

- [#212](https://github.com/aio-proxy/aio-proxy/pull/212) [`64718ae`](https://github.com/aio-proxy/aio-proxy/commit/64718aea31a3a26ef691443246163713278b5e2b) Thanks @baranwang - openai: add Completions and Responses compact ports `POST /v1/completions` and `POST /v1/responses/compact` now use the existing language-generation pipeline.

- [#214](https://github.com/aio-proxy/aio-proxy/pull/214) [`84901fd`](https://github.com/aio-proxy/aio-proxy/commit/84901fd5fd54ad95418ef74bb578f5b210e30612) Thanks @baranwang - Add inbound OpenAI Embeddings and Gemini embed/batch embed through same-protocol raw, embedding convert, and fallback.

### Patch Changes

- Updated dependencies [[`4ce6cee`](https://github.com/aio-proxy/aio-proxy/commit/4ce6cee2412a13cc18d250af52335f456ad1db13), [`64718ae`](https://github.com/aio-proxy/aio-proxy/commit/64718aea31a3a26ef691443246163713278b5e2b), [`b6e65cd`](https://github.com/aio-proxy/aio-proxy/commit/b6e65cddeaab8ce356f1d5f7c0f0f7e98a401608), [`84901fd`](https://github.com/aio-proxy/aio-proxy/commit/84901fd5fd54ad95418ef74bb578f5b210e30612)]:
  - @aio-proxy/types@0.11.0
  - @aio-proxy/plugin-sdk@0.11.0

## 0.10.0

### Minor Changes

- [#203](https://github.com/aio-proxy/aio-proxy/pull/203) [`076c67b`](https://github.com/aio-proxy/aio-proxy/commit/076c67ba698c4cd7a3756ef370adc7a62a530402) Thanks @baranwang - Add `aio-proxy provider import [path]` to copy supported CPA OAuth auth files into aio-proxy accounts. OAuth plugins can declare typed CPA credential importers through the plugin SDK, and the built-in ChatGPT, Google Antigravity, Kimi Code, and xAI Grok plugins now provide them.

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

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks @baranwang - Plugins move display identity into descriptor metadata (`displayName` / `accountLabel`; remove legacy `label` and OAuth capability icons). Add Cursor account OAuth/provider support. Normalize OpenAI Responses errors to `response.failed` for Codex.

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
