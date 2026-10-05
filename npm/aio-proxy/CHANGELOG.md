# aio-proxy

## 0.39.1

### Patch Changes

- [#489](https://github.com/aio-proxy/aio-proxy/pull/489) [`ec485f0`](https://github.com/aio-proxy/aio-proxy/commit/ec485f035dfea998bed00c2852bb74bfb730d6b5) Thanks @baranwang - Codex no longer fails to start with "model_catalog_json ... must contain at least one model" when model metadata is briefly unavailable. An empty model catalog is never written, and one written by an earlier version is no longer kept: the last non-empty catalog is kept, or, with none, Codex uses its built-in catalog. The server logs a `codex.catalog_sync_failed` warning with code `empty_catalog` while the catalog stays empty.

- [#491](https://github.com/aio-proxy/aio-proxy/pull/491) [`d5218bf`](https://github.com/aio-proxy/aio-proxy/commit/d5218bfaf68e0af8d9b97cc09ac90b3ebe2f8593) Thanks @baranwang - Allow large image histories and compressed recovery requests with a configurable 256 MiB request limit, including ChatGPT and Provider body transforms. Bound body logs independently to 64 MiB per hop and direction while preserving full forwarding, request diagnostics, and privacy protections.

- [#487](https://github.com/aio-proxy/aio-proxy/pull/487) [`7ba11b2`](https://github.com/aio-proxy/aio-proxy/commit/7ba11b2ef78af331754be0e94bda7bc19de19312) Thanks @baranwang - Align desktop usage trend colors with the Dashboard: higher-usage series appear first in lighter colors, while lower-usage series use darker colors. Hide zero-valued entries in Dashboard model trend hover tooltips.

## 0.39.0

### Minor Changes

- [#477](https://github.com/aio-proxy/aio-proxy/pull/477) [`94024af`](https://github.com/aio-proxy/aio-proxy/commit/94024af667f4b691cef234a3f305d6561c5a9192) Thanks @baranwang - `aiop agent configure claude-code` points Claude Code at aio-proxy by merging `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` into the global `~/.claude/settings.json`, leaving every other setting in place. Without proxy API keys it writes a placeholder token so Claude Code stops using its claude.ai login; with keys you choose one, in the terminal or on the Dashboard's Agents page. `agent list` shows the integration, and `agent remove claude-code` restores only those two keys.

- [#486](https://github.com/aio-proxy/aio-proxy/pull/486) [`a59559d`](https://github.com/aio-proxy/aio-proxy/commit/a59559db8ba07d62f1f2b8dab50a77b5fba272b8) Thanks @baranwang - ChatGPT and GitHub Copilot Providers can use the sign-in Codex or Copilot already keeps on this machine instead of a browser login; aio-proxy keeps Codex signed in when it refreshes, and removing the Provider never signs the tool out.

- [#483](https://github.com/aio-proxy/aio-proxy/pull/483) [`4a26f10`](https://github.com/aio-proxy/aio-proxy/commit/4a26f10bde2ee22dccd0312c484327bc92bf1578) Thanks @baranwang - A Kimi Code, Muse Code, ChatGPT, or Cursor subscription whose quota window is known to be exhausted is now skipped for the models that window covers until it resets, instead of being attempted and failing on every request. Quota that is unknown or older than 10 minutes never skips a Provider. When every candidate is exhausted or cooling down, the client gets a 429 with `Retry-After` set to the earliest reset, and the request trace lists the skipped Providers and why.

- [#483](https://github.com/aio-proxy/aio-proxy/pull/483) [`13ff41d`](https://github.com/aio-proxy/aio-proxy/commit/13ff41dba0d21ef4ec79589e0598d1973fb72f64) Thanks @baranwang - New opt-in `router.selection: quota-reset` (also a switch on the Dashboard Routing page): within each Provider priority tier, the subscription whose quota allowance expires soonest is tried first instead of the weighted draw, so allowance is not left to lapse on one subscription while another is drained. Session affinity still takes precedence, Providers without quota data follow in their weighted order, and the routing list and model details show measured traffic shares without deviation warnings. Nothing changes while the setting stays `weighted`.

- [#484](https://github.com/aio-proxy/aio-proxy/pull/484) [`b2e7941`](https://github.com/aio-proxy/aio-proxy/commit/b2e7941313846cea0c6e179f64c73cc137565e13) Thanks @baranwang - API and discoverable AI SDK Providers can set `syncModels: true` to follow upstream model lists without editing the config: models refresh every hour or on demand in the Dashboard, upstream outages and empty responses keep the last good list, and `excludedModels` hides exact model IDs while aliases can still target them. The Dashboard supports switching between manual and synced models, hiding models, and viewing the last refreshed time; hand-written `models` lists work as before.

### Patch Changes

- [#479](https://github.com/aio-proxy/aio-proxy/pull/479) [`1c501d4`](https://github.com/aio-proxy/aio-proxy/commit/1c501d4dfe3e5a84f1c170891b02c8cd460b5608) Thanks @baranwang - The dashboard protocol pickers now offer OpenAI Images, Audio, and Videos endpoints, so media providers can be configured and their traces filtered without editing the config file. Protocols are also labelled by their official API name (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, Gemini generateContent, Gemini Interactions) instead of the ambiguous "Gemini" and "OpenAI Compatible".

- [#482](https://github.com/aio-proxy/aio-proxy/pull/482) [`a4d8780`](https://github.com/aio-proxy/aio-proxy/commit/a4d8780eeb767e00a56c151f657f888021ab69f5) Thanks @baranwang - Guardian System One approvals now evaluate the supplied review policy, including custom rules, without falling back just because its wording or formatting changed. Requests without review instructions, incompatible requests, unusable results, and failed evaluations retain the original-model fallback with diagnostic reason codes.

- [#478](https://github.com/aio-proxy/aio-proxy/pull/478) [`dd47aa2`](https://github.com/aio-proxy/aio-proxy/commit/dd47aa2333b53934df5b65deec9d72894c629bfa) Thanks @baranwang - The dashboard no longer offers Repair for a Codex or Grok Build integration whose managed fields you edited. Setup deliberately does not overwrite your edits, so Repair always failed with "Something went wrong". The card now tells you to remove the integration (your edits are kept) and configure it again, and setup that hits edited fields reports exactly that instead of an unknown error.

## 0.38.0

### Minor Changes

- [#467](https://github.com/aio-proxy/aio-proxy/pull/467) [`e6b2bfd`](https://github.com/aio-proxy/aio-proxy/commit/e6b2bfd0303784a19c23fa504a35a070987ebb30) Thanks @baranwang - The macOS app's menu offers Install aiop command when your shell cannot find `aiop` and the app is in `/Applications`. After the system password prompt it adds `aiop` to `/usr/local/bin`, plus `aio-proxy` when your shell has none, both pointing at the CLI inside the app so they keep working across app updates. A command already installed there by something else is never replaced.

### Patch Changes

- [#466](https://github.com/aio-proxy/aio-proxy/pull/466) [`4e3078f`](https://github.com/aio-proxy/aio-proxy/commit/4e3078fcc014f81825e2bf144336d2f920e8f6a6) Thanks @baranwang - Fix Dashboard installation and updates for Pi, OMP, and OpenCode in standalone and desktop builds.

- [#468](https://github.com/aio-proxy/aio-proxy/pull/468) [`24d77d0`](https://github.com/aio-proxy/aio-proxy/commit/24d77d05fd4e27bfa918a568d904e71ce3593f3b) Thanks @baranwang - Preserve transport timings, retry failure reasons, and response attribution for each upstream HTTP send. Trace details now show send counts and indices, so retries with multiple responses no longer appear to be missing timing data.

## 0.37.0

### Minor Changes

- [#423](https://github.com/aio-proxy/aio-proxy/pull/423) [`7f408f2`](https://github.com/aio-proxy/aio-proxy/commit/7f408f2fa1c54d644c5bfe11a649c89567e502b9) Thanks @baranwang - The CLI has a new look. Help groups commands by purpose, `provider list` and `plugin list` print aligned tables, `agent list` and `provider list --filter <id>` print every field as a labeled block, and `doctor` is a checklist. Status uses one set of symbols (● ▲ ✗ ○) everywhere, with Dashboard teal for headings. Output stays plain when redirected or when `NO_COLOR` is set, and `--json` output is unchanged.

## 0.36.1

### Patch Changes

- [#460](https://github.com/aio-proxy/aio-proxy/pull/460) [`e6be2c0`](https://github.com/aio-proxy/aio-proxy/commit/e6be2c02c7aab3cfa9f3d0fea30b14a944145c19) Thanks @baranwang - The macOS app could not start the proxy after the CLI was removed with `brew uninstall`: the CLI's login service stayed behind, pointing at the deleted binary, and Start only relaunched it. The app now recognises such a leftover service and offers Take over, which moves it to the app on your click and keeps the existing config. A stopped proxy's panel now centres on the button that starts it, and no longer offers Open Dashboard while nothing is running.

## 0.36.0

### Minor Changes

- [#456](https://github.com/aio-proxy/aio-proxy/pull/456) [`6a7d9c8`](https://github.com/aio-proxy/aio-proxy/commit/6a7d9c89c8c8d4b90efa45a0d903f24b0ec1eb77) Thanks @baranwang - New macOS menu-bar app for Apple Silicon (macOS 13 or later). It runs aio-proxy as a login service without a separate Bun or CLI install. Its panel shows proxy status, usage over 24 hours, 7 days or 30 days by model and by Provider, quota with a pace projection, and a 12-month activity heatmap; start, stop, restart and reload live in the icon's right-click menu. A service installed with the CLI is only changed when you click. Download `aio-proxy-<version>-arm64.dmg` from the release; later updates arrive in the app.

- [#456](https://github.com/aio-proxy/aio-proxy/pull/456) [`dcb1ebd`](https://github.com/aio-proxy/aio-proxy/commit/dcb1ebd82b6fddd964c3083c83ff3c2d57c275be) Thanks @baranwang - `aio-proxy service start` now starts a loaded-but-stopped launchd service, `service restart` waits for the old job to unload, and a service whose binary was removed no longer respawns in a loop. A stopping proxy exits within 3 seconds. Groundwork for the macOS desktop app: a private `desktop-token` file in the proxy home, a local summary endpoint and a discovery command. An app-managed install never self-upgrades (the Dashboard hides "Update now" there), and `aio-proxy upgrade` never restarts an app-owned service.

- [#459](https://github.com/aio-proxy/aio-proxy/pull/459) [`4869672`](https://github.com/aio-proxy/aio-proxy/commit/4869672879e888f4d07fa9efe385d588dbd0e80b) Thanks @baranwang - Codex setup now saves a full local model catalog and refreshes it as models change, preserving complete task guidance and official instructions. HTTP model discovery uses compact guidance for third-party models to reduce response size. Restart Codex CLI or Desktop after local catalog updates; removing the integration restores the previous personal catalog configuration.

### Patch Changes

- [#457](https://github.com/aio-proxy/aio-proxy/pull/457) [`98aa84c`](https://github.com/aio-proxy/aio-proxy/commit/98aa84c42b513080f18edf43d7bc4ac8dbb924c5) Thanks @baranwang - The dashboard now waits out a brief server restart instead of showing "Dashboard unavailable" until reloaded. On the Routing page, token limits and prices follow the dashboard language (`128K`, `$2.00`) instead of the system one, traffic charts name Providers instead of showing their IDs, API Providers no longer list their protocol, and an empty traffic chart gets a proper empty state. Mixed CJK and Latin text is now auto-spaced.

## 0.35.1

### Patch Changes

- [#451](https://github.com/aio-proxy/aio-proxy/pull/451) [`ab6524f`](https://github.com/aio-proxy/aio-proxy/commit/ab6524f69e2c48b2cd3039407916e07d43fd24f9) Thanks [@baranwang](https://github.com/baranwang)! - The dashboard Plugins page now shows Plugins as cards with search and All / Enabled / Failed / Built-in filters. A banner calls out Plugins that failed to load and jumps straight to them, and Add Plugin opens a compact dialog instead of a drawer.

## 0.35.0

### Minor Changes

- [#440](https://github.com/aio-proxy/aio-proxy/pull/440) [`76e2bc6`](https://github.com/aio-proxy/aio-proxy/commit/76e2bc6a2405ab48dca41ffcfbcc22189602d349) Thanks @baranwang - Routing groups models by vendor and shows each model's failover tiers (T1, T2, …) with every Provider's share, drift, and why one is left out. A model's page shows its route, traffic, and model info and pricing, which follow an automatically matched reference model unless overridden. Providers' default routing uses the same tiers with typed weights: 0 parks a Provider, and moving it between tiers keeps its weight, bringing a parked one back at 1.

### Patch Changes

- [#448](https://github.com/aio-proxy/aio-proxy/pull/448) [`c867d58`](https://github.com/aio-proxy/aio-proxy/commit/c867d58f4c660b4f9882447faba42bb38501b533) Thanks @baranwang - Keep Codex model catalog entries forward-compatible by inheriting the first remote model as the synthesis template, and configure Codex with its explicit model catalog URL and API-key discovery feature.

- [#440](https://github.com/aio-proxy/aio-proxy/pull/440) [`5a02aa1`](https://github.com/aio-proxy/aio-proxy/commit/5a02aa1360cc391ed99421e461bed5a558b40840) Thanks @baranwang - The Agents installations table no longer has a Columns menu for hiding columns; every column is always shown.

- [#445](https://github.com/aio-proxy/aio-proxy/pull/445) [`de8be7f`](https://github.com/aio-proxy/aio-proxy/commit/de8be7fedb0aa8f5359db8ab14a6fcb12abf1139) Thanks @olivewind - Managed services now retain Agent executable search paths, so the dashboard detects locally installed Agents after restarts. Codex also recognizes the CLI bundled with current ChatGPT desktop builds.

- [#440](https://github.com/aio-proxy/aio-proxy/pull/440) [`0250a99`](https://github.com/aio-proxy/aio-proxy/commit/0250a99f2f5b98d40ec54a76560b21268eaa3008) Thanks @baranwang - API and AI SDK Providers now show a plain API or package icon across the dashboard. API Providers no longer show protocol logos that looked like the upstream vendor, and AI SDK Providers no longer show the first letter of their name. Protocols and packages are still listed next to the name.

## 0.34.0

### Minor Changes

- [#442](https://github.com/aio-proxy/aio-proxy/pull/442) [`6dbb50d`](https://github.com/aio-proxy/aio-proxy/commit/6dbb50deb8a3f7540802e67484056c5bfcfecd54) Thanks @baranwang - The dashboard has a new Agents page listing OpenCode, Pi, oh-my-pi, Codex, and Grok Build with their local status and authorizations. When the dashboard is opened on the machine running aio-proxy, each Agent can be configured, updated, repaired, or removed with one click, Codex through a setup form, and the device approval happens on the same page. Remote browsers and containers see read-only state and a link to each Agent's setup guide.

### Patch Changes

- [#437](https://github.com/aio-proxy/aio-proxy/pull/437) [`5dea413`](https://github.com/aio-proxy/aio-proxy/commit/5dea4139c4567284858ae04c8636dd961e47af72) Thanks @baranwang - Agent authorization is completed on a single screen: the footer always offers stacked approve and deny buttons, disabled until the code entry is complete. Completing the code resolves it automatically — the request appears as a panel above the entry, a failed resolve shows an alert, and a code carried in a URL is simply pre-filled into the same flow. Approving or denying shows the final outcome, and expired, used, or already decided codes are reported with a toast.

- [#443](https://github.com/aio-proxy/aio-proxy/pull/443) [`b2fb4a4`](https://github.com/aio-proxy/aio-proxy/commit/b2fb4a4c6fb246ee56502063ed410be19aad4f44) Thanks @baranwang - Optional Guardian System One strategies now work for eligible approval requests even when codex-auto-review is not independently configured as a route, while ordinary requests and the default strategy remain unchanged.

- [#438](https://github.com/aio-proxy/aio-proxy/pull/438) [`f72415a`](https://github.com/aio-proxy/aio-proxy/commit/f72415a1252cb887989c3cfffd77fc0dc99a49c6) Thanks @baranwang - Pi and OMP list the aio-proxy extension as aio-proxy. They previously showed an internal entry path.

## 0.33.4

### Patch Changes

- [#431](https://github.com/aio-proxy/aio-proxy/pull/431) [`a223275`](https://github.com/aio-proxy/aio-proxy/commit/a22327585b8574fa08f7b40cc154a982a4999909) Thanks @baranwang - Google Antigravity upstream failures now pass a short diagnostic through to the client. A request rejected because the account region is unsupported reports that reason instead of a generic request failure. Responses that carry anything besides the diagnostic stay masked.

- [#433](https://github.com/aio-proxy/aio-proxy/pull/433) [`aab9a9a`](https://github.com/aio-proxy/aio-proxy/commit/aab9a9aabf02664dc973e1afdb1c9daab911be65) Thanks @baranwang - `aiop agent configure codex` finds the Codex CLI shipped inside the ChatGPT app when `codex` is not on `PATH`. A missing CLI is reported directly instead of as an unexpected internal error.

- [#430](https://github.com/aio-proxy/aio-proxy/pull/430) [`3279743`](https://github.com/aio-proxy/aio-proxy/commit/3279743ec7c8447decba5df6c8836405071261e1) Thanks @baranwang - Guardian evaluation now runs on the OpenAI Responses provider selected for that request, not only on a ChatGPT transport. A direct allow or deny does not charge the selected provider; evaluation cost stays on the configured evaluation provider.

## 0.33.3

### Patch Changes

- [#428](https://github.com/aio-proxy/aio-proxy/pull/428) [`cd5971b`](https://github.com/aio-proxy/aio-proxy/commit/cd5971b2ab87856457a9291a245d74d0e5049739) Thanks @baranwang - Guardian approval now keeps requests eligible when their transcript contains paired custom tool calls, instead of falling back before evaluation.

## 0.33.2

### Patch Changes

- [#426](https://github.com/aio-proxy/aio-proxy/pull/426) [`7a104ac`](https://github.com/aio-proxy/aio-proxy/commit/7a104ac9de628d0d39fb830a710c8ad8366ac93a) Thanks @baranwang - Guardian approval now accepts the current Codex review transcript, including prior review rounds, assistant replies, and the assessment note inside the final approval envelope.

## 0.33.1

### Patch Changes

- [#424](https://github.com/aio-proxy/aio-proxy/pull/424) [`20b7733`](https://github.com/aio-proxy/aio-proxy/commit/20b7733ce0b7a6276e82bbfc582bb25923aac37a) Thanks @baranwang - Guardian approval now follows the Guardian agent marker on any ChatGPT model, instead of requiring the request to be routed as codex-auto-review.

## 0.33.0

### Minor Changes

- [#422](https://github.com/aio-proxy/aio-proxy/pull/422) [`de76673`](https://github.com/aio-proxy/aio-proxy/commit/de76673fe07ae3be9f3d7e3a84d1bd541ca07479) Thanks @baranwang - Plugin Provider fields can declare the protocols they accept. Guardian now asks for a TypeSafe System One Provider, and the model control lists that Provider's routed models instead of accepting any ID.

- [#422](https://github.com/aio-proxy/aio-proxy/pull/422) [`24a1468`](https://github.com/aio-proxy/aio-proxy/commit/24a14688083a14639af225a0d8d908373cf8f568) Thanks @baranwang - ChatGPT OAuth now offers optional Guardian approval strategies that evaluate with a selected System One Provider and model. The default keeps Codex behavior, and supported System One decisions can be final or send denials to the original model for review; unavailable evaluations fall back safely.

### Patch Changes

- [#420](https://github.com/aio-proxy/aio-proxy/pull/420) [`a85a7e0`](https://github.com/aio-proxy/aio-proxy/commit/a85a7e02e1c89f7311cd11cb961ec2f1db9885d1) Thanks @baranwang - Match OAuth service names in the trace list to the table body text, so they no longer appear heavier than the surrounding columns.

## 0.32.0

### Minor Changes

- [#416](https://github.com/aio-proxy/aio-proxy/pull/416) [`80983cd`](https://github.com/aio-proxy/aio-proxy/commit/80983cdb7dcf9368388c5d9cc9b86ceea3b6322f) Thanks @baranwang - The documentation site publishes stable English and Chinese pages for all supported public API operations, with resource navigation and read-only examples. It covers text, embeddings, media, evaluation, and realtime endpoints, including multipart uploads, binary responses, and WebSocket handshakes, with provider compatibility limits made explicit.

### Patch Changes

- [#419](https://github.com/aio-proxy/aio-proxy/pull/419) [`af0b53f`](https://github.com/aio-proxy/aio-proxy/commit/af0b53fe8acabc74a15818dbce1847ed3510554a) Thanks @baranwang - Keep routed `codex-auto-review` in the Codex model list while leaving it hidden. Automatic review can resolve it, but it stays out of the model picker and is omitted when no enabled Provider exposes it.

- [#413](https://github.com/aio-proxy/aio-proxy/pull/413) [`e77a7ac`](https://github.com/aio-proxy/aio-proxy/commit/e77a7ac7ce18c0b57fd1cf40aa606373213557c5) Thanks @baranwang - Restore Provider success rate, token throughput, and latency statistics for the updated trace format. Restore overview cache hit rate accounting for requests with nested inference spans.

- [#417](https://github.com/aio-proxy/aio-proxy/pull/417) [`2a7f9c0`](https://github.com/aio-proxy/aio-proxy/commit/2a7f9c0bdd5f2a8528659fd2b5d41914ea9d5d8c) Thanks @baranwang - Show OAuth service names alongside account labels in the trace list, so requests using the same email can be distinguished by their upstream provider.

## 0.31.0

### Minor Changes

- [#410](https://github.com/aio-proxy/aio-proxy/pull/410) [`f0b3105`](https://github.com/aio-proxy/aio-proxy/commit/f0b3105e4dc74a674303c89e1d2eb2e106b7b12b) Thanks @baranwang - Configure ChatGPT's User-Agent once on the Plugins page for all ChatGPT providers, without signing in again. The default follows the latest stable Codex version through cached, proxy-aware npm and GitHub lookups, with a fallback when both fail. Plugin options support simple Handlebars variables such as `{{latest_codex_rs_version}}`, and plugin form fields can declare default values. Previously saved provider-level User-Agent values are ignored.

### Patch Changes

- [#408](https://github.com/aio-proxy/aio-proxy/pull/408) [`24209ab`](https://github.com/aio-proxy/aio-proxy/commit/24209ab085ab5155cb37055383b77e5ef11e9c9a) Thanks @baranwang - Human prompts and the named result views now share one terminal style. `--json`, shell completion, version, and auth protocol output are unchanged.

- [#411](https://github.com/aio-proxy/aio-proxy/pull/411) [`38b4c2d`](https://github.com/aio-proxy/aio-proxy/commit/38b4c2d47697aee41c12f5b6ab4fc28cd1d2d8b0) Thanks @baranwang - The OpenTelemetry destination form is now translated. Header rows can be removed, and only the first header or API key row shows field labels.

- [#409](https://github.com/aio-proxy/aio-proxy/pull/409) [`fd01333`](https://github.com/aio-proxy/aio-proxy/commit/fd01333243b264180db8480a1220909b39af72ae) Thanks @baranwang - The trace list and the trace detail header show a Provider by its configured name, or account label, with the Provider ID on hover. They no longer draw the provider mark next to that name.

## 0.30.0

### Minor Changes

- [#407](https://github.com/aio-proxy/aio-proxy/pull/407) [`fc9ee8c`](https://github.com/aio-proxy/aio-proxy/commit/fc9ee8c2d31bcdc58bc5709b3d0e2a451b2004f2) Thanks @baranwang - ChatGPT accounts can set a fixed user agent and optionally keep the inbound user agent when a model or image request comes from a Codex client. The fixed value is also used for realtime requests. Accounts that leave both unset keep the previous fixed user agent.

- [#404](https://github.com/aio-proxy/aio-proxy/pull/404) [`69867fc`](https://github.com/aio-proxy/aio-proxy/commit/69867fc1cf275d3f72f4ebea41a0ad8b4f398493) Thanks @baranwang - Settings can send the traces aio-proxy already records to OTLP endpoints. Add a destination URL, choose JSON or protobuf, and set headers. Export stays on when a destination fails, and the local traces page is unchanged.

### Patch Changes

- [#406](https://github.com/aio-proxy/aio-proxy/pull/406) [`23faacb`](https://github.com/aio-proxy/aio-proxy/commit/23faacb68ea76edfc0f379e602f16023ad749b46) Thanks @baranwang - Codex configuration always lets you choose which session history sources to migrate, including when only one source is available. While history is scanned, the prompt shows a loading indicator. When API key authentication is off, the note that no key is needed is shown as a status line instead of an error.

- [#402](https://github.com/aio-proxy/aio-proxy/pull/402) [`739e846`](https://github.com/aio-proxy/aio-proxy/commit/739e8465e605c866bcfaaedb1ba05ef1a81db8d4) Thanks @baranwang - Trace detail is titled with the request's root operation, such as `POST /v1/responses`. Failed spans in the timeline no longer show an alert icon next to the name.

- [#402](https://github.com/aio-proxy/aio-proxy/pull/402) [`e9e80c0`](https://github.com/aio-proxy/aio-proxy/commit/e9e80c0cd7224886d1e04a0c98f0547803cd0ccf) Thanks @baranwang - Trace list and trace detail show a Provider the same way the providers page does: its configured name, or account label, with the Provider ID on hover. The list column is labeled Provider. An ID missing from the catalog, or a catalog that failed to load, stays as the Provider ID.

## 0.29.0

### Minor Changes

- [#399](https://github.com/aio-proxy/aio-proxy/pull/399) [`571c394`](https://github.com/aio-proxy/aio-proxy/commit/571c3944b9345196468a241212618def08955d9d) Thanks @baranwang - Trace timelines now use stable start ordering, standard HTTP and GenAI semantics, redacted upstream URLs, and accurate provider, failover, TTFT, and usage attribution. OAuth runtimes can explicitly declare their GenAI provider identity; raw transports can declare upstream URL templates, while converted calls omit templates unless authoritative transport metadata is available.

### Patch Changes

- [#401](https://github.com/aio-proxy/aio-proxy/pull/401) [`6337347`](https://github.com/aio-proxy/aio-proxy/commit/6337347634da1a8eb0763e14406b050c32e8f5bc) Thanks @baranwang - Grok quota treats an omitted usage figure as 0% used, so an unused window stays fully available instead of disappearing. Banked usage-limit resets can be redeemed from the quota dialog.

## 0.28.0

### Minor Changes

- [#382](https://github.com/aio-proxy/aio-proxy/pull/382) [`c81d4af`](https://github.com/aio-proxy/aio-proxy/commit/c81d4afed84aca4a891180187f5f43b8fcc4e60c) Thanks @baranwang - 调用链详情页现在展示完整的 span 树：解析、会话、路由各成一条；每次请求有一层逻辑操作 span 覆盖路由与全部失败转移，其下每个 provider 尝试各成一条推理 span（厂商、模型、token），再往下是请求准备与每一次上游 HTTP 发送，同一 provider 的退避重试逐次成行。
  瀑布图按父子结构排序，首字时延画成刻度；尝试的首字时延从尝试开始计，失败的尝试也记录，一次尝试观测到多个响应时说明无法归因的原因。
  token 用量与模型不再挂在根 span 上；客户端主动取消不再标成错误。

- [#382](https://github.com/aio-proxy/aio-proxy/pull/382) [`2841175`](https://github.com/aio-proxy/aio-proxy/commit/2841175f2d07089d13beaa629857227cbcd9d0d4) Thanks @baranwang - 调用链详情改为整页三个标签页。「详情」是带时间刻度的瀑布图和选中 span 的状态、耗时、Token 与可筛选属性；同模型同操作的成功样本够了，结束后才给延迟分位。计 token 调用链也能按请求模型筛选。属性加筛选时按这条调用链当天。
  「请求」「响应」按跳列出站和每次上游发送。抓包需 debug 日志，按启动时的配置读（热重载改 level/目录要等重启）；未开启、过期或缺天会说明原因。还在跑时详情会刷新，结束后再抓一次完整日志，跨零点才写完的正文也会扫到。视频请求和响应都不落正文。无正文的 GET/HEAD 记空终态，打开时不再误扫下一天。OAuth 的 `code`、`jwt` / `X-JWT` 会打码；相对 Location（`?token=`、`../jobs`）保持原路径写法。
  失败跳显示失败，清理未读正文不会把成功跳画成取消。客户端取消只留下异常类型时，那一跳仍是取消。取消的调用链不进成功/失败柱和延迟分位。未映射的上游异常也会留下推理层的尝试次数。

- [#382](https://github.com/aio-proxy/aio-proxy/pull/382) [`25f9ec0`](https://github.com/aio-proxy/aio-proxy/commit/25f9ec0be50b28f8f5cc75f20a250e8b0bbc8ed7) Thanks @baranwang - 调用链列表页进入时不再自动轮询，工具栏新增「实时」开关，时间范围选择器从筛选抽屉移到工具栏常驻。表格上方新增按时间分桶的成功/失败堆叠柱状图：图例显示区间总数并直接充当状态筛选，点击柱体把时间范围收窄到该桶，折叠状态记在本地。表格的「状态」列移到 HTTP 之后。

- [#394](https://github.com/aio-proxy/aio-proxy/pull/394) [`21d30e3`](https://github.com/aio-proxy/aio-proxy/commit/21d30e321b902e2fba11801b23ce87aad6207334) Thanks @baranwang - Evaluate with TypeSafe System One. `POST /v1/systemone` routes System One requests like any other model request, with priority and weight failover and System One-shaped errors. Every answered evaluation records usage, so this traffic now bills. The dashboard offers the new `typesafe-systemone` protocol for providers and traces, and reports newer bundled AI SDK provider versions.

### Patch Changes

- [#394](https://github.com/aio-proxy/aio-proxy/pull/394) [`9b016b3`](https://github.com/aio-proxy/aio-proxy/commit/9b016b37234aec0607d92a84362dd0ee8ab10a15) Thanks @baranwang - Fix image, audio, video, and embedding requests ignoring provider weight when the client sends a session header. That header pinned the capability to whichever provider answered first, so a backup that served a single failover kept the traffic instead of returning it to the recovered primary. These capabilities now spread across providers by weight as intended.

- [#382](https://github.com/aio-proxy/aio-proxy/pull/382) [`54e1619`](https://github.com/aio-proxy/aio-proxy/commit/54e161907a466d958695320e71c80f9c7a2e770c) Thanks @baranwang - 请求日志此前会把自定义认证头和带签名的 URL、Location、Link 明文落盘。现在这些凭据会打码。

## 0.27.1

### Patch Changes

- [#395](https://github.com/aio-proxy/aio-proxy/pull/395) [`46d63d1`](https://github.com/aio-proxy/aio-proxy/commit/46d63d187f1e91165f6a29a63dbe960826e128e9) Thanks @baranwang - Route Pi-family gpt-, claude-, and gemini- models through their native Responses, Anthropic, and Gemini APIs while preserving OpenAI Completions as the fallback. GPT sessions now forward stable cache and affinity identifiers to aio-proxy. Pi and OMP display the provider as AIO Proxy.

## 0.27.0

### Minor Changes

- [#390](https://github.com/aio-proxy/aio-proxy/pull/390) [`37ac185`](https://github.com/aio-proxy/aio-proxy/commit/37ac185ab77e4f4d4b59e541f7f4399217a0f801) Thanks @baranwang - The Dashboard login now persists in the browser, so opening a new tab or restarting the browser no longer asks for the password again. The login renews itself while you keep using the Dashboard, so visiting at least once every 6 days keeps you signed in, and an unused login expires after seven days. Logging out in one tab logs out every other tab, and changing `server.password` still invalidates the login on every device immediately.

- [#383](https://github.com/aio-proxy/aio-proxy/pull/383) [`bafe0fa`](https://github.com/aio-proxy/aio-proxy/commit/bafe0fa2277d32ff502cf03f0cdb7e96c7970c30) Thanks @baranwang - Quota details put this window's used API-equivalent spend on the reset row. Hover it for the exact used amount and an estimated period total from used versus remaining quota. That estimate is local API equivalent, not a vendor balance.

### Patch Changes

- [#386](https://github.com/aio-proxy/aio-proxy/pull/386) [`6273746`](https://github.com/aio-proxy/aio-proxy/commit/62737462d25a35c9d6051a7dd3ad510fb0125cc5) Thanks @foriLLL - Chat Completions streaming now shapes tool-call chunks the way OpenAI does: the first chunk carries the call id and function name, every chunk after it carries only the argument delta. Clients that concatenate the fields they receive no longer end up with duplicated JSON, a repeated call id or tool name, or broken tool calls such as a bash `command` of `{`.

- [#384](https://github.com/aio-proxy/aio-proxy/pull/384) [`da17aef`](https://github.com/aio-proxy/aio-proxy/commit/da17aefae1728ebe418a8d8c30c42714568ffbb0) Thanks @baranwang - Fix Codex history migration so existing JSONL threads keep working after `aiop agent configure codex`. Desktop sessions stored as paginated history, including those still labeled `newapi`, are rewritten to the managed provider instead of being skipped.

## 0.26.0

### Minor Changes

- [#380](https://github.com/aio-proxy/aio-proxy/pull/380) [`3b81cd0`](https://github.com/aio-proxy/aio-proxy/commit/3b81cd0bf7b7746f539652f21efac70ee5e4720e) Thanks @baranwang, @YePiXpert - Quota details show this instance's API-equivalent spend for each OAuth window. It is not the vendor balance.

### Patch Changes

- [#377](https://github.com/aio-proxy/aio-proxy/pull/377) [`7e02db8`](https://github.com/aio-proxy/aio-proxy/commit/7e02db80b0be294c5a02b2e7b7d2350d666868c5) Thanks @baranwang - Settings → About now shows only one version action at a time. When a newer release is available, the row keeps "Update now" and hides "Check for updates". After a failed or unavailable install, both stay so the user can recheck or retry.

- [#378](https://github.com/aio-proxy/aio-proxy/pull/378) [`67e63dd`](https://github.com/aio-proxy/aio-proxy/commit/67e63dde4e3b60b0cae31cbf37f1d70d1aac02e9) Thanks @baranwang - Fixed Cursor multimodal follow-up requests failing after an inline image moved into conversation history, including pending tool resumes, without dropping Cursor-owned conversation turns.

- [#381](https://github.com/aio-proxy/aio-proxy/pull/381) [`a9b3558`](https://github.com/aio-proxy/aio-proxy/commit/a9b355800d01932b1f9e27c63f6f6765bc489125) Thanks @baranwang - Codex Desktop tool results that arrive without a `call_id` are rewritten to a user note on the OpenAI Responses raw path. Outputs that still have a `call_id` are left for stored previous-response state.

## 0.25.0

### Minor Changes

- [#372](https://github.com/aio-proxy/aio-proxy/pull/372) [`c0e2cab`](https://github.com/aio-proxy/aio-proxy/commit/c0e2cab47228253c7d8e5e042bcff9397c369430) Thanks @baranwang - Add a built-in OpenCode Go plugin. Paste an OpenCode API key from opencode.ai/auth to use the Go subscription catalog, with per-model Chat Completions, Responses, and Anthropic Messages routing.

### Patch Changes

- [#375](https://github.com/aio-proxy/aio-proxy/pull/375) [`d94e381`](https://github.com/aio-proxy/aio-proxy/commit/d94e38184a5e10f11f0cefd113e9919a5e094cff) Thanks @foriLLL - Record OpenAI Responses and Chat Completions `cache_write_tokens` on traces. Dashboard cache write previously showed N/A even when the upstream usage object included that field.

- [#376](https://github.com/aio-proxy/aio-proxy/pull/376) [`c1487e5`](https://github.com/aio-proxy/aio-proxy/commit/c1487e50de8f6b6edde853228d9c8b29e399611b) Thanks @foriLLL - Preserve prompt-cache and reasoning token counts when converting a model
  stream into OpenAI Responses. Cross-protocol Responses usage previously
  reported those fields as 0 even when the upstream model returned them.

## 0.24.0

### Minor Changes

- [#370](https://github.com/aio-proxy/aio-proxy/pull/370) [`1cb5c9f`](https://github.com/aio-proxy/aio-proxy/commit/1cb5c9f3fc91c5e48ef673eb7be0b9971942386e) Thanks @YePiXpert - Discover Grok OAuth image and video models instead of filtering them from the account catalog. Support image generation/editing and video creation, polling, and content retrieval with the same account. Plugins can optionally declare a video catalog without exposing video-only models as chat models.

- [#370](https://github.com/aio-proxy/aio-proxy/pull/370) [`d50feb0`](https://github.com/aio-proxy/aio-proxy/commit/d50feb0764829686811aaff59b8134e47b493ea4) Thanks @YePiXpert - Add authenticated SOCKS5 outbound proxies and optional primary/backup proxy fallback, disabled by default. Only providers set to inherit use the global policy; independent provider primary/backup settings and direct connections override it. Fallback switches only before a request is sent and never bypasses the proxies.

### Patch Changes

- [#370](https://github.com/aio-proxy/aio-proxy/pull/370) [`9de6d0e`](https://github.com/aio-proxy/aio-proxy/commit/9de6d0ec7fde99c9de87f993d3c1fb8f890690fe) Thanks @YePiXpert - Fix OpenAI ChatGPT model tests and Responses requests failing because the Codex backend rejects max_output_tokens. The ChatGPT plugin now omits this unsupported output limit.

- [#370](https://github.com/aio-proxy/aio-proxy/pull/370) [`9de6d0e`](https://github.com/aio-proxy/aio-proxy/commit/9de6d0ec7fde99c9de87f993d3c1fb8f890690fe) Thanks @YePiXpert - Show image, embedding, and audio models alongside language models in the OAuth Provider editor, including after refreshing the catalog. Hidden models remain available to re-enable.

## 0.23.2

### Patch Changes

- [#360](https://github.com/aio-proxy/aio-proxy/pull/360) [`6e54855`](https://github.com/aio-proxy/aio-proxy/commit/6e548551c2fe9f94816ede2fd8a4ea3b9882672c) Thanks @baranwang - Fixed `aio-proxy upgrade --version` on prerelease versions. The post-install check dropped the prerelease suffix when reading the new binary's version, so it compared `0.23.1` against the requested `0.23.1-canary.…`, judged the install a failure, and rolled the working binary back.

- [#366](https://github.com/aio-proxy/aio-proxy/pull/366) [`3bf7004`](https://github.com/aio-proxy/aio-proxy/commit/3bf7004feb80ae77ac64030d0255a601e1488a2c) Thanks @YePiXpert - Image generation and editing requests with an omitted or blank model now default to `gpt-image-2.5-sunburst`. Explicit model selections keep their existing routing. API Providers must expose the new default model, or clients must explicitly request a model their Provider supports.

- [#365](https://github.com/aio-proxy/aio-proxy/pull/365) [`f4d4ed1`](https://github.com/aio-proxy/aio-proxy/commit/f4d4ed10166dfa1379e31b19938f64e64488e97a) Thanks @YePiXpert - Preserve the full upstream URL when creating or editing single-protocol API endpoints in the Dashboard. Gateways such as Command Code now retain their required path prefixes after saving; existing legacy single-protocol configurations retain their original URL behavior.

## 0.23.1

### Patch Changes

- [#362](https://github.com/aio-proxy/aio-proxy/pull/362) [`1658708`](https://github.com/aio-proxy/aio-proxy/commit/1658708238094422610bcae1f05bbebd08186d97) Thanks @baranwang - Fix manual OAuth callback submission in the Dashboard without navigating the editor page.

## 0.23.0

### Minor Changes

- [#357](https://github.com/aio-proxy/aio-proxy/pull/357) [`6fd1738`](https://github.com/aio-proxy/aio-proxy/commit/6fd173878a3574113571b2cf8499e679f83e1b96) Thanks @baranwang - Add `server.requireApiKey` to turn caller key enforcement off without deleting the configured keys, with a matching switch in Settings; when it is off on a non-loopback bind the proxy logs a warning. Settings now shows the configured caller keys as they are authored — including `{{env.NAME}}` templates — instead of `****`, so a key can be read back, edited, and copied rather than only replaced.

## 0.22.1

### Patch Changes

- [#355](https://github.com/aio-proxy/aio-proxy/pull/355) [`6484bef`](https://github.com/aio-proxy/aio-proxy/commit/6484bef7a020406a4ced6ea40dc027167d88cbf9) Thanks @olivewind - Fix the settings page crashing when adding an API key through an HTTP connection to a remote host.

## 0.22.0

### Minor Changes

- [#351](https://github.com/aio-proxy/aio-proxy/pull/351) [`c98e10c`](https://github.com/aio-proxy/aio-proxy/commit/c98e10c1decd66972d10561b3e0fdaa5aae84da0) Thanks @baranwang - Add interactive Codex setup with a customizable Provider ID and a choice to keep ChatGPT login via an existing proxy API key or use command authentication. Command authentication uses AIO Proxy device authorization and reuses a still-valid helper token. Setup preserves model settings and can migrate legacy history; removal respects user edits, revokes command credentials, and blocks when the config cannot be restored.

- [#344](https://github.com/aio-proxy/aio-proxy/pull/344) [`2d05095`](https://github.com/aio-proxy/aio-proxy/commit/2d0509557bbb35a14046ab0a5dcc0cc5e9563b4f) Thanks @baranwang - Add Grok Build integration with native AIO Proxy login, automatic credential refresh, installation revocation, and safe configuration removal.

- [#339](https://github.com/aio-proxy/aio-proxy/pull/339) [`834f9b3`](https://github.com/aio-proxy/aio-proxy/commit/834f9b359f29b229e3930a0b435200d805361789) Thanks @baranwang - Add official OpenAI Videos ports: create, retrieve, content, delete, remix, edits, and extensions.

### Patch Changes

- [#347](https://github.com/aio-proxy/aio-proxy/pull/347) [`00a17a3`](https://github.com/aio-proxy/aio-proxy/commit/00a17a399d7bebb58cc929b77923935f3be8927a) Thanks @olivewind - Automatically install and start a missing per-user background service when running service start or restart on macOS and Linux. If automatic setup fails, show the underlying error and manual recovery commands.

- [#354](https://github.com/aio-proxy/aio-proxy/pull/354) [`4c57408`](https://github.com/aio-proxy/aio-proxy/commit/4c574088a806967bab32485a7dc0e4d72affe899) Thanks @baranwang - Record TTFT for OpenAI Responses streams that deliver the first text or reasoning in `response.output_item.done` instead of incremental `*.delta` events. A completed item is only a fallback when no `*.delta` was seen, so normal done-after-delta streams do not invent a content gap. Reasoning items count generated `content` as well as `summary`. Tool-only and empty items still omit TTFT.

## 0.21.0

### Minor Changes

- [#341](https://github.com/aio-proxy/aio-proxy/pull/341) [`9b1547a`](https://github.com/aio-proxy/aio-proxy/commit/9b1547a263492ba9753fea3eb4761ad434d302f8) Thanks @baranwang - ChatGPT OAuth providers now expose `gpt-image-2.5-sunburst` and `gpt-image-2.5-flare` on `/v1/images/generations` and `/v1/images/edits`. Blank `model` still defaults to `gpt-image-2`.

### Patch Changes

- [#343](https://github.com/aio-proxy/aio-proxy/pull/343) [`52b07ce`](https://github.com/aio-proxy/aio-proxy/commit/52b07ce1deba1c2e23ececd5c9689994d359b1dc) Thanks @baranwang - Updating from the dashboard now always restarts the service after a successful install. The install
  step first asked over HTTP whether a daemon was running, even though it was running inside that very
  daemon, so a busy server, a slow answer, or a `server.host` that is not locally reachable made it
  conclude there was nothing to restart. The new version was installed and then never started, with no
  error to explain why.

## 0.20.5

### Patch Changes

- [#337](https://github.com/aio-proxy/aio-proxy/pull/337) [`7ca4736`](https://github.com/aio-proxy/aio-proxy/commit/7ca473664bff145f4f27570c2d4a36bd7179c854) Thanks @baranwang - Reasoning effort now clamps to what the chosen provider actually supports, read from the provider's
  own catalog first and models.dev only as a fallback, so a `max` request reaches a provider that
  supports `max` instead of arriving as `high`. Google Antigravity's variants, including its split
  Low/Medium/High Gemini wires, clamp down instead of failing the request, and an alias asked for more
  effort than its highest variant declares routes to that variant instead of the alias base.

- [#336](https://github.com/aio-proxy/aio-proxy/pull/336) [`9817de6`](https://github.com/aio-proxy/aio-proxy/commit/9817de664952238e234e000d81daccb8a0b39d8c) Thanks @baranwang - Update status is now reported by toast instead of wrapped text inside the sidebar card and the About row. The "Update now" button no longer sits permanently disabled next to "Check for updates" — it appears only when a newer release is available, an install is running, a restart is pending, or an install failed. The restart notice stays until dismissed.

- [#335](https://github.com/aio-proxy/aio-proxy/pull/335) [`f4f4d7d`](https://github.com/aio-proxy/aio-proxy/commit/f4f4d7d76d07d0b6ceafba73df5fc6f4f4a8d870) Thanks @baranwang - OAuth provider model aliases now use a switch for "inherit plugin aliases" instead of a checkbox, matching other boolean settings on the provider editor.

## 0.20.4

### Patch Changes

- [#333](https://github.com/aio-proxy/aio-proxy/pull/333) [`3ae608c`](https://github.com/aio-proxy/aio-proxy/commit/3ae608cd6a24999dcf92f31a7e8269cdb04d4e03) Thanks @baranwang - Republish platform downloads to restore GitHub Release assets and Homebrew updates.

## 0.20.3

### Patch Changes

- [#322](https://github.com/aio-proxy/aio-proxy/pull/322) [`5180e6e`](https://github.com/aio-proxy/aio-proxy/commit/5180e6ee4a4252067524bef3625cdb5ef677b857) Thanks @baranwang - Publish all four platform tarballs and SHA256 checksums as GitHub Release assets so Homebrew updates no longer wait for npm tarball availability.

- [#323](https://github.com/aio-proxy/aio-proxy/pull/323) [`6eca232`](https://github.com/aio-proxy/aio-proxy/commit/6eca2326aec9908634e4975448485b9972ea0ee8) Thanks @baranwang - The overview homepage stacks model trend as bars, shows Provider health as a table without filter or column controls, and ranks models by cost or Token.

- [#324](https://github.com/aio-proxy/aio-proxy/pull/324) [`7877705`](https://github.com/aio-proxy/aio-proxy/commit/7877705e72bacd55ef197117e71b683888026789) Thanks @baranwang - Cursor now returns explicit failures for unsupported native tools and completes rejected tool execution streams so the upstream turn can continue. Bounded protocol diagnostics help investigate remaining stalls.

- [#321](https://github.com/aio-proxy/aio-proxy/pull/321) [`8e5ee08`](https://github.com/aio-proxy/aio-proxy/commit/8e5ee083ad9ac96fb70b8394d93501342c8ca905) Thanks @baranwang - Prevent duplicate desktop upgrade notifications when multiple instances use different data directories. Only a successfully sent notification suppresses repeat reminders for the same OS user when shared storage is available; failed delivery can be retried by another instance, and notifications still work if that storage cannot be written.

## 0.20.2

### Patch Changes

- [#315](https://github.com/aio-proxy/aio-proxy/pull/315) [`adb01e8`](https://github.com/aio-proxy/aio-proxy/commit/adb01e84078ccad4ec34f0fd13ef10a79f10f604) Thanks @baranwang - The About card now uses the same row spacing as the other settings groups. Check for updates is hidden as soon as an update starts. After a successful install, aio-proxy restarts itself and the dashboard reloads instead of asking you to restart by hand.

- [#317](https://github.com/aio-proxy/aio-proxy/pull/317) [`06be481`](https://github.com/aio-proxy/aio-proxy/commit/06be481bd9e14795561b498dd855c8432e243289) Thanks @baranwang - Fix Cursor OAuth requests hanging on interaction or stream completion, losing tool arguments or sibling calls, and repeating tools because resumed context omitted their calls and results. Stalled runs now terminate with clearer diagnostics.

- [#316](https://github.com/aio-proxy/aio-proxy/pull/316) [`3b4c12e`](https://github.com/aio-proxy/aio-proxy/commit/3b4c12e0e3f5b502cacf4c22aa9a88188608c3da) Thanks @baranwang - The plugin SDK now exports shared abortableSleep and dedupeQuotaItemIds helpers, preserving OAuth cancellation reasons and provider-specific quota IDs. Removed unused UI and internal wrappers, plus the unused AioModelMessage and AioStreamPart schemas and associated types from @aio-proxy/types.

## 0.20.1

### Patch Changes

- [#311](https://github.com/aio-proxy/aio-proxy/pull/311) [`1018663`](https://github.com/aio-proxy/aio-proxy/commit/1018663bbc459485c25a995a2bfb81454738b3f1) Thanks @baranwang - Rename the built-in Claude Pro/Max plugin to `@aio-proxy/plugin-claude-code`

- [#314](https://github.com/aio-proxy/aio-proxy/pull/314) [`3c31f50`](https://github.com/aio-proxy/aio-proxy/commit/3c31f505c862b18a314e19cfac580d7a935d0d07) Thanks @baranwang - Muse Code quota bars now show the even-burn mark. The plugin read the window length from the
  upstream response but never passed it on, so the dashboard knew when each window resets without
  knowing how long it runs and had nothing to pace against.

- [#312](https://github.com/aio-proxy/aio-proxy/pull/312) [`757c270`](https://github.com/aio-proxy/aio-proxy/commit/757c270f88a6a13e5bab6cf56ab6aad3f1a03280) Thanks @baranwang - The pace mark on a subscription quota bar now explains itself on hover instead of relying on a
  browser tooltip, and its outline is thicker so the mark stays legible where it sits on top of the
  filled part of the bar.

## 0.20.0

### Minor Changes

- [#298](https://github.com/aio-proxy/aio-proxy/pull/298) [`13a6c91`](https://github.com/aio-proxy/aio-proxy/commit/13a6c9153739049dab5443dd3ac7d570f7e80690) Thanks @baranwang - Serve the Codex Live / Realtime endpoint family as signaling passthrough.

- [#300](https://github.com/aio-proxy/aio-proxy/pull/300) [`692795c`](https://github.com/aio-proxy/aio-proxy/commit/692795c49f26e93e93af79cb611043a1e82c307a) Thanks @baranwang - A running process checks npm `latest` on start, every 24 hours, and when the Dashboard mounts. It persists the result, prompts once per new version (Dashboard sidebar, CLI stderr banner, OS notification), and installs only after Update now or `aio-proxy upgrade`. Leftover `server.autoUpdate` in an existing config is ignored.

- [#305](https://github.com/aio-proxy/aio-proxy/pull/305) [`d036485`](https://github.com/aio-proxy/aio-proxy/commit/d0364851282aaf6aaa56c6dc6bfa515d7e0c3209) Thanks @baranwang - Add a built-in Muse Code OAuth plugin that logs in with a Meta device code, mints a Model API key, and routes Meta models through the OpenAI Responses API.

- [#303](https://github.com/aio-proxy/aio-proxy/pull/303) [`84b206c`](https://github.com/aio-proxy/aio-proxy/commit/84b206c1d2f296748d2b86cedf0ef97c2b65d8e2) Thanks @baranwang - Add a built-in OpenRouter OAuth plugin that signs in with PKCE, mints a durable user-controlled API key, discovers models, and reads remaining key credits. Loopback parse now requires callback `state` only when the opened authorize URL sent `state`, so OpenRouter (no state echo) can finish without weakening ChatGPT or Antigravity CSRF.

- [#301](https://github.com/aio-proxy/aio-proxy/pull/301) [`681b039`](https://github.com/aio-proxy/aio-proxy/commit/681b039164281d7ab28c09ce1a61aae064caa6a0) Thanks @baranwang - Add the OpenAI Audio inbound protocol.

- [#308](https://github.com/aio-proxy/aio-proxy/pull/308) [`8b02edd`](https://github.com/aio-proxy/aio-proxy/commit/8b02edd711a54102661c41199a60f10396f7dce3) Thanks @baranwang - Subscription quota bars now mark where an even burn would have left the allowance by now, turning
  red when the window is being spent faster than that and drawing nothing while it tracks even. The
  marker appears wherever the provider reports how long the window lasts, which the bundled OAuth
  plugins now do; plugins can opt in through the new optional `OAuthQuotaItem.windowMinutes`. The
  reading is also spoken by the bar's accessible value text.

- [#302](https://github.com/aio-proxy/aio-proxy/pull/302) [`b3b181a`](https://github.com/aio-proxy/aio-proxy/commit/b3b181aebd9a8c36de14dc05076c137e96a49332) Thanks @baranwang - anthropic-claude: add Claude Pro/Max subscription OAuth login, model discovery, and Anthropic runtime

### Patch Changes

- [#309](https://github.com/aio-proxy/aio-proxy/pull/309) [`1340b97`](https://github.com/aio-proxy/aio-proxy/commit/1340b97cfa5d277a886bbda43ebb4abdbc7fffc6) Thanks @baranwang - Fix Cursor OAuth account labels to use the account email after sign-in or credential refresh even when the access token omits it. If the account lookup is unavailable, keep the existing label without failing authentication.

## 0.19.2

### Patch Changes

- [#297](https://github.com/aio-proxy/aio-proxy/pull/297) [`ec132d7`](https://github.com/aio-proxy/aio-proxy/commit/ec132d7347491f28ea21445f76bc697a4535b76c) Thanks @baranwang - cli: accept `aio-proxy update` as an alias of `aio-proxy upgrade`, including the same flags and shell completion.

- [#296](https://github.com/aio-proxy/aio-proxy/pull/296) [`ad353c0`](https://github.com/aio-proxy/aio-proxy/commit/ad353c005a6458aa30861fb2ed2e183231a20b6f) Thanks @baranwang - docs: publish the curl installer at https://aioproxy.dev/install.sh; it installs the prebuilt binary from the published `@aio-proxy/cli-<os>-<arch>` npm package — the same artifact `aio-proxy upgrade` and the Homebrew tap use — and refuses musl-based Linux, which has no published build, instead of installing a glibc binary that cannot start

- [#287](https://github.com/aio-proxy/aio-proxy/pull/287) [`83c67f1`](https://github.com/aio-proxy/aio-proxy/commit/83c67f1cf670752e14ebf66bc95ab0799923b48e) Thanks @baranwang - Hide non-text models from the Codex model picker The Codex client catalog (`/v1/models?client_version=...`) listed every routable model, including image and video generators such as `gpt-image-2` and the `grok-imagine-*` family.

- [#296](https://github.com/aio-proxy/aio-proxy/pull/296) [`46087fb`](https://github.com/aio-proxy/aio-proxy/commit/46087fb5ab1d28295e9912d8873e2ef574963c2a) Thanks @baranwang - dashboard: point the Settings documentation link at https://aioproxy.dev

- [#290](https://github.com/aio-proxy/aio-proxy/pull/290) [`4e3f656`](https://github.com/aio-proxy/aio-proxy/commit/4e3f656e4df4d53a171b42ac783e3108ff1468f0) Thanks @baranwang - Keep `reasoning.summary` on Grok CLI `/v1/responses` requests

  cli-chat-proxy now accepts `reasoning.summary`. The xAI plugin still strips
  `previous_response_id` (Zero Data Retention 404) and the other Codex Desktop
  fields that HTTP `/v1/responses` rejects, but it no longer deletes `summary`.

- [#292](https://github.com/aio-proxy/aio-proxy/pull/292) [`4f4e324`](https://github.com/aio-proxy/aio-proxy/commit/4f4e324c4625a1d4582d4292b7b9e3e96cbdabb6) Thanks @baranwang - On the OAuth provider editor, put Connection above Identity and fill a blank display name from the account label after a successful login.

- [#291](https://github.com/aio-proxy/aio-proxy/pull/291) [`f71a576`](https://github.com/aio-proxy/aio-proxy/commit/f71a5760db5852f2c340e089c3858ae81da7053c) Thanks @baranwang - Accept OpenAI Responses requests whose tool calls and outputs lost their pairing Context compaction can truncate a conversation between a `function_call` and its `function_call_output`, leaving one side without the other.

- [#291](https://github.com/aio-proxy/aio-proxy/pull/291) [`4f3154e`](https://github.com/aio-proxy/aio-proxy/commit/4f3154e79a3f2bf1d5d23081e8dd099cc7841ecd) Thanks @baranwang - Recover from tool-pairing 400s on the raw passthrough path When the inbound protocol matches the provider's, an OpenAI Responses request is forwarded byte-for-byte and the model path's conversion never runs.

- [#289](https://github.com/aio-proxy/aio-proxy/pull/289) [`dd0e007`](https://github.com/aio-proxy/aio-proxy/commit/dd0e007bcf4832ebeb1b54862fb0cbfc1dfda76a) Thanks @baranwang - Serve the config JSON Schema from `@aio-proxy/types` instead of duplicating it in the launcher package.

- [#293](https://github.com/aio-proxy/aio-proxy/pull/293) [`cf45f02`](https://github.com/aio-proxy/aio-proxy/commit/cf45f0222aa85754e64f19dee184228769c97ddd) Thanks @baranwang - Render the AIO Proxy wordmark from vector geometry instead of a webfont The dashboard logo drew "Proxy" with an SVG `<text>` element styled `font-heading font-semibold`.

- [#286](https://github.com/aio-proxy/aio-proxy/pull/286) [`981e765`](https://github.com/aio-proxy/aio-proxy/commit/981e765965a881af845aff413db711f779ff2ffb) Thanks @baranwang - Drop reasoning item ids the ChatGPT Codex backend never persisted.

## 0.19.1

### Patch Changes

- [#284](https://github.com/aio-proxy/aio-proxy/pull/284) [`80f8b9d`](https://github.com/aio-proxy/aio-proxy/commit/80f8b9d10eef15214fc3f55342ccf097fc00b6ef) Thanks @baranwang - Refresh dependencies across the workspace, including `eventsource-parser` 4 for SSE parsing, `hono` 4.13.7 for the proxy and Dashboard routes, and `jose` 6.2.12 for token handling. Behavior is unchanged.

## 0.19.0

### Minor Changes

- [#282](https://github.com/aio-proxy/aio-proxy/pull/282) [`d3bec51`](https://github.com/aio-proxy/aio-proxy/commit/d3bec51577cb5e4fbb057b459acbf76acea3b828) Thanks @baranwang - Make the Provider editor's catalog button actually re-fetch an OAuth Provider's model list. It only ever re-read the persisted catalog, so until the plugin's TTL expired — six hours for ChatGPT — the button silently redrew the same rows. It now forces a rediscovery upstream, waits for the new catalog to be readable, and reports failures instead of looking like a success. Disabled OAuth Providers can be refreshed this way too; they are still never rediscovered on a timer.

### Patch Changes

- [#279](https://github.com/aio-proxy/aio-proxy/pull/279) [`e3f6ff2`](https://github.com/aio-proxy/aio-proxy/commit/e3f6ff2c5365b0ae2921a17b3f6b187c6a766c8f) Thanks @baranwang - Build and ship on Bun 1.4.2, which fixes a musl/Alpine GC crash affecting the Docker image.

- [#276](https://github.com/aio-proxy/aio-proxy/pull/276) [`2e76766`](https://github.com/aio-proxy/aio-proxy/commit/2e7676669a60d42af8d545e8d1614a295fabfae6) Thanks @baranwang - Make a quota reset redemption legible while it happens.

## 0.18.1

### Patch Changes

- [#277](https://github.com/aio-proxy/aio-proxy/pull/277) [`e2d8a23`](https://github.com/aio-proxy/aio-proxy/commit/e2d8a2381cb6c9f32dac2c26d2dd476934d2a71c) Thanks @baranwang - Surface the newest ChatGPT (Codex) models again. The pinned `codex-tui` client version was stale, and the upstream model catalog gates each model on its `minimal_client_version`, so the `gpt-5.6` family and `gpt-6-astra` were silently missing from ChatGPT OAuth Providers.

## 0.18.0

### Minor Changes

- [#274](https://github.com/aio-proxy/aio-proxy/pull/274) [`1cf2838`](https://github.com/aio-proxy/aio-proxy/commit/1cf2838bb8cec1ed8e3354646b1b39d2695d3664) Thanks @baranwang - Redeem ChatGPT rate-limit reset credits from the Dashboard.

### Patch Changes

- [#273](https://github.com/aio-proxy/aio-proxy/pull/273) [`9608e07`](https://github.com/aio-proxy/aio-proxy/commit/9608e070b5faf585cf591fa007e190e7493362c3) Thanks @baranwang - Keep dragged tier headers visible while Provider and model routing tier contents smoothly collapse and expand.

- [#273](https://github.com/aio-proxy/aio-proxy/pull/273) [`9608e07`](https://github.com/aio-proxy/aio-proxy/commit/9608e070b5faf585cf591fa007e190e7493362c3) Thanks @baranwang - Show default routing tiers and same-tier weight percentages in an inset layer beneath each Provider card, including the tier number when there is only one tier.

- [#274](https://github.com/aio-proxy/aio-proxy/pull/274) [`1cf2838`](https://github.com/aio-proxy/aio-proxy/commit/1cf2838bb8cec1ed8e3354646b1b39d2695d3664) Thanks @baranwang - plugin-sdk: document and enforce the OAuth quota reset contract — report `resetCredits` only alongside a `reset` implementation, and treat every `reset` call as a new intentional redemption rather than a retry of the last one.

## 0.17.0

### Minor Changes

- [#259](https://github.com/aio-proxy/aio-proxy/pull/259) [`44a978e`](https://github.com/aio-proxy/aio-proxy/commit/44a978eb2a58a1e36c9c5cd3fd933f082995580b) Thanks @baranwang - ChatGPT OAuth providers now discover models from the signed-in account's own Codex endpoint instead of a published `models.json` snapshot, so the exposed list matches what the account can actually call.

- [#263](https://github.com/aio-proxy/aio-proxy/pull/263) [`1d688b5`](https://github.com/aio-proxy/aio-proxy/commit/1d688b5090fdbb004435f7e41042464e24885936) Thanks @baranwang - cursor: report Cursor OAuth quota in the dashboard The Cursor OAuth adapter now reads `cursor.com/api/usage-summary`, so its Provider card shows the quota ring: plan usage, the Auto and named-model lanes, the on-demand budget when the account has a cap, and the Cursor subscription tier, all resetting at the billing-cycle end.

- [#262](https://github.com/aio-proxy/aio-proxy/pull/262) [`d4b7388`](https://github.com/aio-proxy/aio-proxy/commit/d4b738816eaa2ad2f32f125cc7238db2e84b85da) Thanks @baranwang - github-copilot: report Copilot OAuth quota in the dashboard

  The GitHub Copilot OAuth adapter now reads `copilot_internal/user`, so its Provider card shows the quota ring: the premium-request and chat allowances, any other window the account reports, the monthly reset date, and the Copilot plan. Seats with an unlimited or token-billed entitlement report no metered window rather than a misleading full bar.

- [#265](https://github.com/aio-proxy/aio-proxy/pull/265) [`d371ddc`](https://github.com/aio-proxy/aio-proxy/commit/d371ddcdeaaeb93931739f68f26432f2408ad1cd) Thanks @baranwang - google-antigravity: report account quota on the Provider card. The plugin now reads Antigravity's grouped five-hour and weekly limits, along with the subscription tier, so the dashboard renders a quota ring for Antigravity accounts.

- [#260](https://github.com/aio-proxy/aio-proxy/pull/260) [`b7d9520`](https://github.com/aio-proxy/aio-proxy/commit/b7d9520cdc280d1b6785c53d4d079b5db2d5311f) Thanks @baranwang - Refresh an OAuth Provider's credential on demand from the dashboard Provider card menu.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`fd1c284`](https://github.com/aio-proxy/aio-proxy/commit/fd1c28430f0678bc22a558677feeff3146f7eba6) Thanks @baranwang - Add an About section to the Settings page with the running version, the source repository, and the documentation site, plus a button that checks npm for a newer published release. Move the appearance and language card to the top of the page, and mark the API key label field as optional.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`2c6da7a`](https://github.com/aio-proxy/aio-proxy/commit/2c6da7a8ccd7246bcc81daf83001e046ce376e16) Thanks @baranwang - Add, relabel, and remove API keys from Settings, including a one-click generator for a fresh random key. Stored keys stay masked and are never sent back to the browser, and authored `{{env.NAME}}` key templates survive a write unchanged. Key writes carry the revision of the key list they were made against, so a write is rejected with `409 stale_api_keys` when the config changed underneath instead of silently rewriting a different key.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`6d02c87`](https://github.com/aio-proxy/aio-proxy/commit/6d02c876980ee55963fd0db6298adffe23bc42a2) Thanks @baranwang - Set and clear the Dashboard password from Settings. The password is stored only as an Argon2id hash, and changing it signs out every existing session.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`4c93909`](https://github.com/aio-proxy/aio-proxy/commit/4c939090f89ac0799768ab356e74310c91940b7a) Thanks @baranwang - Move appearance and language into Settings as an "Appearance & language" card and drop the sidebar dropdowns, so every preference has one entry point.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`7ecb445`](https://github.com/aio-proxy/aio-proxy/commit/7ecb4452f35b3b1fafa8215d2710e134b60425e7) Thanks @baranwang - Add a "Reload config" action to Settings that re-reads the config file on demand and surfaces the failing reload stage. Host, port, and log level still require a restart.

### Patch Changes

- [#269](https://github.com/aio-proxy/aio-proxy/pull/269) [`0934b54`](https://github.com/aio-proxy/aio-proxy/commit/0934b54a8e8dfb1c9c03ceff1f521b7c82ff600f) Thanks @baranwang - Accept OpenAI Responses tool outputs that carry no `call_id`.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`d3eb521`](https://github.com/aio-proxy/aio-proxy/commit/d3eb5215724009b43705a515ca17666097d578f8) Thanks @baranwang - Raise a `SyntaxError` when a config file parses to a non-object root, so a Settings write against `[]` or `null` answers `config_rejected` instead of failing with an unhandled server error.

- [#268](https://github.com/aio-proxy/aio-proxy/pull/268) [`c2acd49`](https://github.com/aio-proxy/aio-proxy/commit/c2acd49f937aa833b8cf7f5937d45cd2a227cd70) Thanks @baranwang - Retry OpenAI Responses raw requests when the upstream rejects an unverifiable reasoning blob with `code: null` and only the message `The encrypted content for item rs_… could not be verified. Reason: Encrypted content could not be decrypted or parsed.`. That variant previously reached the client unchanged because the retry only matched `code: "invalid_encrypted_content"`. A `Signature expired` rejection still commits, since replaying the same body cannot fix it.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`17a68c2`](https://github.com/aio-proxy/aio-proxy/commit/17a68c228a961afa04a61ed46cb84808b2e33830) Thanks @baranwang - Attach the loopback OAuth-error rejection handler before the callback request so the test no longer fails intermittently on an unhandled rejection.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`b0e6181`](https://github.com/aio-proxy/aio-proxy/commit/b0e6181122aa8424d90f9533b9deef7f57bb6810) Thanks @baranwang - Derive the recovery-fence action-phase test's sleep from its deadline so a slow acquisition no longer makes it fail on the timeout path it is not testing.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`9b80f0c`](https://github.com/aio-proxy/aio-proxy/commit/9b80f0cbb813a709a42638915224d81f1e16241e) Thanks @baranwang - Build the Settings About rows from the shadcn `Item` primitive so the repository and documentation rows are clickable end to end instead of only through their chevron.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`962e433`](https://github.com/aio-proxy/aio-proxy/commit/962e433bc648cb44604ed98423ecec3c17a6b721) Thanks @baranwang - Store a new API key exactly as entered instead of trimming it, including a key made up entirely of whitespace, and author every submitted key even when a retained row already holds that credential.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`2621cb3`](https://github.com/aio-proxy/aio-proxy/commit/2621cb3221abdc8a7d98cbde7eb54e6b35feef37) Thanks @baranwang - Keep an unsaved API key when another writer's change forces a settings refetch, so a rejected save no longer discards the only copy of a generated key. Localize every config reload failure stage instead of interpolating the server's internal stage identifier into the translated message.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`31b4339`](https://github.com/aio-proxy/aio-proxy/commit/31b4339d6b59ca72c0a3b5b33bcd2c339e631f1a) Thanks @baranwang - Report an API key row that has a label but no key instead of silently dropping it, so saving no longer succeeds without persisting the key.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`fe76256`](https://github.com/aio-proxy/aio-proxy/commit/fe762564e204fb81535ed99fc82dfbff72c63e0d) Thanks @baranwang - Keep the Settings page usable when an external edit leaves the config file unparseable: the read view falls back to the keys the proxy is still enforcing instead of failing, and a write attempted against the broken file is refused with a clear error rather than a 500.

- [#267](https://github.com/aio-proxy/aio-proxy/pull/267) [`cef9deb`](https://github.com/aio-proxy/aio-proxy/commit/cef9deb1441d7c22cf64b412fb6a311bac1f761a) Thanks @baranwang - Render the dashboard's default-size switches as Safari's native `<input type="checkbox" switch>` when the browser supports it, falling back to the Base UI implementation everywhere else.

- [#272](https://github.com/aio-proxy/aio-proxy/pull/272) [`5c7f017`](https://github.com/aio-proxy/aio-proxy/commit/5c7f01716a840a8f02850b08bcd3ad7cf254f740) Thanks @baranwang - Show Trace fast-mode indicators for GPT-5.6 Sol ultrafast requests.

- [#271](https://github.com/aio-proxy/aio-proxy/pull/271) [`8150738`](https://github.com/aio-proxy/aio-proxy/commit/815073848e78ed7195f7f6d97077f3b495d103bd) Thanks @baranwang - dashboard: manage Provider and per-model priority tiers with one drag editor that moves whole tiers, creates tiers at drop slots, and adjusts traffic shares without an add-tier button

## 0.16.0

### Minor Changes

- [#253](https://github.com/aio-proxy/aio-proxy/pull/253) [`a12c9ca`](https://github.com/aio-proxy/aio-proxy/commit/a12c9cabb7481d188786bf22ac5a718b4bf7cca9) Thanks @baranwang - google-antigravity: match oh-my-pi hub fingerprints, daily-to-sandbox failover, native request envelopes, onboard polling, and Gemini first-call skip signatures

- [#249](https://github.com/aio-proxy/aio-proxy/pull/249) [`e5e18af`](https://github.com/aio-proxy/aio-proxy/commit/e5e18af5f48f54c9dcc8e823fbcda137a97ad4b5) Thanks @baranwang - openai-chatgpt: report ChatGPT OAuth quota in the dashboard

  The ChatGPT (Codex) OAuth adapter now reads `wham/usage`, so its Provider card shows the quota ring: the 5-hour and weekly windows, any model-specific limits the account reports (Codex Spark and the like), the subscription plan, and the available rate-limit reset credits.

### Patch Changes

- [#252](https://github.com/aio-proxy/aio-proxy/pull/252) [`142cc1b`](https://github.com/aio-proxy/aio-proxy/commit/142cc1b419b0109585a53f020343d0eb72b6673f) Thanks @wqsworks - core: terminate converted OpenAI Responses stream failures with `response.failed` and normalize cumulative OpenAI-compatible tool argument snapshots.

- [#250](https://github.com/aio-proxy/aio-proxy/pull/250) [`3e3c4bd`](https://github.com/aio-proxy/aio-proxy/commit/3e3c4bdc6acaabe970849961b79a649b1f37a6d5) Thanks @baranwang - Raw OpenAI Responses requests that fail with `invalid_encrypted_content` before any output are now retried once on the same provider. Plaintext encrypted slots become plain text, and opaque reasoning blobs are dropped when that is all that remains, so the client no longer sees a stream that disconnects before completion.

## 0.15.0

### Minor Changes

- [#244](https://github.com/aio-proxy/aio-proxy/pull/244) [`44a3b38`](https://github.com/aio-proxy/aio-proxy/commit/44a3b383bda177c8ee0124e53325cb8c63e1752d) Thanks @baranwang - cli: add `aiop` as a short command for `aio-proxy`

- [#243](https://github.com/aio-proxy/aio-proxy/pull/243) [`1daece3`](https://github.com/aio-proxy/aio-proxy/commit/1daece3dd2dad3ddfe86c12784ef379e99424c91) Thanks @baranwang - OAuth providers now hide models with `excludedModels` instead of a `models` whitelist. Leftover `models` keys are ignored and no longer restrict exposure — newly discovered catalog ids stay visible unless hidden. Plugin default aliases inherit at runtime and are no longer written into the config file.

## 0.14.0

### Minor Changes

- [#245](https://github.com/aio-proxy/aio-proxy/pull/245) [`3408993`](https://github.com/aio-proxy/aio-proxy/commit/340899373f0244e6dd240459d6e02d187998961f) Thanks @olivewind - Let AI SDK provider packages be installed from a configurable npm registry in the dashboard, and load model catalogs from packages that expose an optional `listModels` method.

## 0.13.0

### Minor Changes

- [#239](https://github.com/aio-proxy/aio-proxy/pull/239) [`b1f5bff`](https://github.com/aio-proxy/aio-proxy/commit/b1f5bff2f2e92abfd54b90fb32b29b4b145e8c1d) Thanks @baranwang - Redesign the dashboard Provider list as a card grid and surface OAuth remaining quota.

### Patch Changes

- [#239](https://github.com/aio-proxy/aio-proxy/pull/239) [`07413a1`](https://github.com/aio-proxy/aio-proxy/commit/07413a116385e94e20e2c722ecdb32c0b97d52b6) Thanks @baranwang - Restore the accessible names on the combobox clear and chip remove buttons

  A `shadcn add combobox --overwrite` had discarded the hand-applied patch, leaving both icon-only
  buttons announced as an unnamed "button" and forwarding the localized labels to the DOM as dead
  attributes. The same overwrite re-hid the chevron trigger whenever a value was set, which left a
  pointer user on a filled field with no visible control that reveals the curated list.

- [#238](https://github.com/aio-proxy/aio-proxy/pull/238) [`99755b5`](https://github.com/aio-proxy/aio-proxy/commit/99755b58b7492f9da4161ac429325dd319ba48f8) Thanks @baranwang - core: preserve stable session affinity across supported language protocols and native Gemini Interactions continuations.

- [#242](https://github.com/aio-proxy/aio-proxy/pull/242) [`672e0db`](https://github.com/aio-proxy/aio-proxy/commit/672e0dbb4eb0d81b965164b05d7a83dc9db23cda) Thanks @baranwang - Replace the Dashboard `cn` helper's `clsx` and `tailwind-merge` implementation with the `cn` package.

- [#241](https://github.com/aio-proxy/aio-proxy/pull/241) [`1299208`](https://github.com/aio-proxy/aio-proxy/commit/129920850794518d0089762bb015eeac12e4de71) Thanks @baranwang - Fix Dashboard OAuth authorization windows. Device-code providers now navigate the window opened on the
  authorize click instead of leaving a blank tab that only loaded after switching back to the dashboard,
  and the authorization panel no longer opens a second window on top of it — providers that authorize by
  URL, such as Cursor, opened two authorization pages.

## 0.12.3

### Patch Changes

- [#235](https://github.com/aio-proxy/aio-proxy/pull/235) [`aeec254`](https://github.com/aio-proxy/aio-proxy/commit/aeec254e53904ecf656d055ea9f45029f5bb68a8) Thanks @baranwang - Group dashboard model cost and usage by the requested model alias instead of the upstream model a route resolved to.

- [#237](https://github.com/aio-proxy/aio-proxy/pull/237) [`e735323`](https://github.com/aio-proxy/aio-proxy/commit/e7353232a59b83235f88948a72f94fa5e6219e87) Thanks @baranwang - Route image generation for models whose image output is only declared by models.dev. A provider that lists an image model in `models` (or reaches it through an alias) no longer needs a hand-written `router.models` metadata entry to avoid a 501 `not_implemented`.

- [#237](https://github.com/aio-proxy/aio-proxy/pull/237) [`c8dd136`](https://github.com/aio-proxy/aio-proxy/commit/c8dd1369bc9b08570bb74c77befca449272abfb0) Thanks @baranwang - Stop an unbounded snapshot-rebuild loop when the models.dev catalog cache expires. The cold-catalog warm now refreshes the provider catalog the staleness check actually reads, instead of a per-model cache that could already be warm — which previously left the check false forever and requeued a rebuild on every pass.

## 0.12.2

### Patch Changes

- [#233](https://github.com/aio-proxy/aio-proxy/pull/233) [`ccf42a4`](https://github.com/aio-proxy/aio-proxy/commit/ccf42a4555539dd311a0cc36eefd41e75afdd9ac) Thanks @baranwang - Emit completed output-item events for streamed OpenAI Responses reasoning and assistant messages so clients can finalize cross-protocol responses.

## 0.12.1

### Patch Changes

- [#230](https://github.com/aio-proxy/aio-proxy/pull/230) [`e674d9a`](https://github.com/aio-proxy/aio-proxy/commit/e674d9a225d36d03fb388c223a6559beff6adb4d) Thanks @baranwang - oauth: show normalized account emails for connected OAuth providers

- [#231](https://github.com/aio-proxy/aio-proxy/pull/231) [`70756e3`](https://github.com/aio-proxy/aio-proxy/commit/70756e3fe1bd63be4871bd2dc9901b159db47de6) Thanks @baranwang - dashboard: grade traces latency like new-api and show the lightning icon for fast/priority requests

  Chat Completions `service_tier` now maps onto the speed routing axis (`priority`/`fast` → fast, `flex` → flex), matching Responses.

## 0.12.0

### Minor Changes

- [#226](https://github.com/aio-proxy/aio-proxy/pull/226) [`9c16d0b`](https://github.com/aio-proxy/aio-proxy/commit/9c16d0b56a954563a296e5363869d5bae12ffda2) Thanks @baranwang - Configure model metadata once per exposed model at `router.models.<slug>.metadata`, including `extend`, with per-Provider `cost` and `limit` overrides under `router.models.<slug>.providers.<id>`.

### Patch Changes

- [#228](https://github.com/aio-proxy/aio-proxy/pull/228) [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca) Thanks @baranwang - Upgrade Zod to 4.5 and compile inbound protocol request schemas with `z.compile()` (except OpenAI Responses, whose unknown-item transform logs). Upgrade es-toolkit to 1.52. Use `isPlainObject` for JSON and other plain data. Structural plugin/SDK contracts that may be class instances use `isRecord` from the published `@aio-proxy/shared` leaf package. Replace spread-Set arrays with `uniq` in packages that already depend on es-toolkit.

## 0.11.2

### Patch Changes

- [#224](https://github.com/aio-proxy/aio-proxy/pull/224) [`2bb3f13`](https://github.com/aio-proxy/aio-proxy/commit/2bb3f13f1be3707125777d080878850ef52bb865) Thanks @baranwang - Fix the routing share slider thumb so it follows the updated weight.

## 0.11.1

### Patch Changes

- [#220](https://github.com/aio-proxy/aio-proxy/pull/220) [`0635583`](https://github.com/aio-proxy/aio-proxy/commit/0635583d2067b41c1a27170d4330c6d7a3e53773) Thanks @baranwang - Preserve Codex function-tool schemas on xAI Grok OAuth requests by resolving local references and explicit object unions, while isolating only tools whose schemas cannot be converted safely.

## 0.11.0

### Minor Changes

- [#215](https://github.com/aio-proxy/aio-proxy/pull/215) [`4ce6cee`](https://github.com/aio-proxy/aio-proxy/commit/4ce6cee2412a13cc18d250af52335f456ad1db13) Thanks @baranwang - Add Gemini Interactions as an inbound protocol at `POST /v1beta/interactions`.

- [#212](https://github.com/aio-proxy/aio-proxy/pull/212) [`64718ae`](https://github.com/aio-proxy/aio-proxy/commit/64718aea31a3a26ef691443246163713278b5e2b) Thanks @baranwang - openai: add Completions and Responses compact ports `POST /v1/completions` and `POST /v1/responses/compact` now use the existing language-generation pipeline.

- [#213](https://github.com/aio-proxy/aio-proxy/pull/213) [`b6e65cd`](https://github.com/aio-proxy/aio-proxy/commit/b6e65cddeaab8ce356f1d5f7c0f0f7e98a401608) Thanks @baranwang - Add OpenAI Images inbound (`POST /v1/images/generations` and `POST /v1/images/edits`) with same-protocol raw passthrough and `imageModel` convert.

- [#214](https://github.com/aio-proxy/aio-proxy/pull/214) [`84901fd`](https://github.com/aio-proxy/aio-proxy/commit/84901fd5fd54ad95418ef74bb578f5b210e30612) Thanks @baranwang - Add inbound OpenAI Embeddings and Gemini embed/batch embed through same-protocol raw, embedding convert, and fallback.

### Patch Changes

- [#217](https://github.com/aio-proxy/aio-proxy/pull/217) [`e0c9ea0`](https://github.com/aio-proxy/aio-proxy/commit/e0c9ea0b6c8cea6329cf2eeefc2dc4ee2675d44c) Thanks @baranwang - Continue OpenAI Responses model fallback across completed hosted-search history and fall back xAI Grok OAuth custom grammar declarations to ordinary function tools with reversible client wire restoration.

## 0.10.0

### Minor Changes

- [#203](https://github.com/aio-proxy/aio-proxy/pull/203) [`076c67b`](https://github.com/aio-proxy/aio-proxy/commit/076c67ba698c4cd7a3756ef370adc7a62a530402) Thanks @baranwang - Add `aio-proxy provider import [path]` to copy supported CPA OAuth auth files into aio-proxy accounts. OAuth plugins can declare typed CPA credential importers through the plugin SDK, and the built-in ChatGPT, Google Antigravity, Kimi Code, and xAI Grok plugins now provide them.

- [#202](https://github.com/aio-proxy/aio-proxy/pull/202) [`6880a93`](https://github.com/aio-proxy/aio-proxy/commit/6880a93b087b81aaade64a95a6bd14fe7db4c8f1) Thanks @baranwang - dashboard: edit model routing in a drawer by dragging priority tiers and traffic weights

### Patch Changes

- [#200](https://github.com/aio-proxy/aio-proxy/pull/200) [`47257a0`](https://github.com/aio-proxy/aio-proxy/commit/47257a0ce6cde53c542f3886edffe28802c07325) Thanks @baranwang - Docker: install Alpine libgcc/libstdc++ so the compiled musl CLI can start

- [#202](https://github.com/aio-proxy/aio-proxy/pull/202) [`6880a93`](https://github.com/aio-proxy/aio-proxy/commit/6880a93b087b81aaade64a95a6bd14fe7db4c8f1) Thanks @baranwang - dashboard: show OAuth account labels on model routing Providers

## 0.9.1

### Patch Changes

- [#199](https://github.com/aio-proxy/aio-proxy/pull/199) [`2e19250`](https://github.com/aio-proxy/aio-proxy/commit/2e192507075833219fff1bec8379f4144b383c84) Thanks @baranwang - Return upstream model errors before committing a streaming response when AI SDK startup emits a start event first.

- [#198](https://github.com/aio-proxy/aio-proxy/pull/198) [`af389a5`](https://github.com/aio-proxy/aio-proxy/commit/af389a50b57f123c71965cd337185cb8185629e1) Thanks @baranwang - Serve dashboard public files such as `/dashboard/favicon.svg` from the built assets instead of the SPA fallback.

- [#199](https://github.com/aio-proxy/aio-proxy/pull/199) [`fcef8e5`](https://github.com/aio-proxy/aio-proxy/commit/fcef8e5af578aee26df0db1b2ebb30bd6e50d3a0) Thanks @baranwang - Keep OpenAI Responses reasoning summaries with preceding tool calls so cross-protocol tool results remain adjacent.

- [#195](https://github.com/aio-proxy/aio-proxy/pull/195) [`1a1c519`](https://github.com/aio-proxy/aio-proxy/commit/1a1c519422c9be44a770646539803c929b5b9e43) Thanks @baranwang - Change the default local log retention from 14 days to 3 days.

- [#197](https://github.com/aio-proxy/aio-proxy/pull/197) [`c9fe40d`](https://github.com/aio-proxy/aio-proxy/commit/c9fe40dfb7b1ad7fbadb94f4c9ce64ced43dc294) Thanks @baranwang - Compile OpenAI Responses custom tools to Grok-compatible function tools for xAI OAuth providers while preserving custom tool responses for clients.

## 0.9.0

### Minor Changes

- [#189](https://github.com/aio-proxy/aio-proxy/pull/189) [`87126aa`](https://github.com/aio-proxy/aio-proxy/commit/87126aadb95151258c8d1a4e52e0f3e854ee0e54) Thanks @baranwang - Generate Antigravity default aliases from live model discovery and insert newly seen logical ids on refresh.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9) Thanks @baranwang - The dashboard API connection editor can now select multiple protocols and give each one its own address. Saving writes the existing `endpoints` config instead of dropping it.

- [#187](https://github.com/aio-proxy/aio-proxy/pull/187) [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b) Thanks @baranwang - Add managed OpenCode, Pi, and oh-my-pi Agent integrations.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`c5b04c1`](https://github.com/aio-proxy/aio-proxy/commit/c5b04c183b0a9669f518bcb18f38019e96d3a8ca) Thanks @baranwang - Redesign the provider editor into a single page shared by api, ai-sdk, and oauth providers: five fixed sections, a persistent exposure/validation rail, an in-place two-stage OAuth authorization flow, inline alias editing, a routing weight slider, and a visual model-metadata tab.

- [#190](https://github.com/aio-proxy/aio-proxy/pull/190) [`f2d1122`](https://github.com/aio-proxy/aio-proxy/commit/f2d1122b6a946a302902070b288c9093d091808b) Thanks @baranwang - Add model-level Provider priority and weighted routing, stable-session candidate ordering, routing-v2 diagnostics, and a Dashboard Routing workspace. Provider weight now controls same-priority traffic instead of fixed global order; existing configurations should follow the documented migration table.

### Patch Changes

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`f8947e7`](https://github.com/aio-proxy/aio-proxy/commit/f8947e78bc3ec3c7ccfa04e6c82606d7fa7989d9) Thanks @baranwang - Author provider aliases as inline rows in the Models section instead of through a staged drawer.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`3f0e371`](https://github.com/aio-proxy/aio-proxy/commit/3f0e3719028e1a506b2dffd81982c2def32d1db8) Thanks @baranwang - Fix the provider editor silently corrupting alias variants that match on thinking or speed, and let the Dashboard author those conditions instead of only effort names.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`6560946`](https://github.com/aio-proxy/aio-proxy/commit/65609463e6ede5798787c54614d716f2120e8148) Thanks @baranwang - Align the provider editor's conditional variant rows with the prototype.

- [#182](https://github.com/aio-proxy/aio-proxy/pull/182) [`bf6e779`](https://github.com/aio-proxy/aio-proxy/commit/bf6e779aad3d64f0edb4cdb4662f1063f1c6b279) Thanks @baranwang - Replace the dashboard JSON editor's Monaco runtime with CodeMirror 6 while keeping schema validation, completion, and hover on vscode-json-languageservice.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`ed5f7b7`](https://github.com/aio-proxy/aio-proxy/commit/ed5f7b78654738c9ca75178e2a060d3be628782b) Thanks @baranwang - Reject dashboard and admin requests carrying a foreign `Host` header while no dashboard password is
  set. A malicious page could previously rebind its own hostname to `127.0.0.1` and read every
  unauthenticated dashboard endpoint — including the provider editor's real API keys, headers and proxy
  credentials — because the loopback check trusts the browser's connection and the CSRF check ran only
  on writes.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9) Thanks @baranwang - The provider editor now loads an unsaved model catalog with HTTP QUERY, and leftover kind-switch fields no longer block that request.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`f25104e`](https://github.com/aio-proxy/aio-proxy/commit/f25104ea345daeb6f4ec07f5db8fe505e6ca5da6) Thanks @baranwang - Serve the provider editor its per-model `metadata.extend` unresolved. The edit view read the
  runtime config, where `extend` has already been merged into a flat copy of the model's models.dev
  entry, so opening a provider and saving it froze that copy into the config file and cut the model
  loose from the catalog it was tracking.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b71e13c`](https://github.com/aio-proxy/aio-proxy/commit/b71e13c8c991d3482a5446fdbd980ffc37a73ae1) Thanks @baranwang - Align the model metadata drawer with the editor demo. Visual-tab labels are prose
  again (reasoning, context window, cache read, and so on) instead of config key
  paths, and the JSON tab names a schema field when the draft is an object Zod
  rejects instead of claiming it is not JSON. A failed models.dev slug catalog
  response now surfaces as an error with Retry, rather than an empty catalog.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`2797531`](https://github.com/aio-proxy/aio-proxy/commit/2797531548755924713f880e6ef0cbcb00923bf5) Thanks @baranwang - types: list a provider's own model ids before its aliases. The derived route list that feeds `/v1/models`,
  each provider's `clientModels`, and the provider editor's exposure preview put alias names first, so a
  provider that renames one model pushed that alias above the models the user actually typed into the
  whitelist. Direct ids now come first and aliases follow, in configuration order. Which models a provider
  exposes is unchanged — only the order of the listing.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`21883d3`](https://github.com/aio-proxy/aio-proxy/commit/21883d33ab3ceb0081e123aaa985f42b4622f33d) Thanks @baranwang - Clear up the wording around testing a provider in the Dashboard's provider editor.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`ebaeb73`](https://github.com/aio-proxy/aio-proxy/commit/ebaeb73a04968dcb97a435a4037394a08e831a00) Thanks @baranwang - Give Dashboard OAuth loopback a styled completion page with a close button, and lock the plugin account form as soon as authorization starts.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`1dcaf2d`](https://github.com/aio-proxy/aio-proxy/commit/1dcaf2d27278874035494b320690b43dfc5334fa) Thanks @baranwang - Show an OAuth provider's models as enabled when its whitelist is empty. An empty whitelist exposes the
  whole discovered catalog at runtime, but the editor rendered every model unchecked — and the first
  click then saved a one-model whitelist, silently disabling everything else.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`237d9cd`](https://github.com/aio-proxy/aio-proxy/commit/237d9cd4f6810b6695a0624b61d7805991507e1e) Thanks @baranwang - An OAuth provider's `models` whitelist is now read and validated from the config file, where it was previously ignored.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`30113ac`](https://github.com/aio-proxy/aio-proxy/commit/30113ac44315a690a30360121fe196f1104a69be) Thanks @baranwang - Stop OAuth reauthorize from writing the provider while alias names still collide. The editor already blocked Save; reauthorize went through `save()` without that check, so last-wins serialization could drop a colliding row from the config.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b0cdf26`](https://github.com/aio-proxy/aio-proxy/commit/b0cdf2696d3b8125d4d7c5a4df239a45bbe0dcc1) Thanks @baranwang - Keep per-model metadata edits when saving an OAuth provider also re-authorizes it. The editor saves
  credentials and model metadata in one action; if the credential half required re-authorization, the
  login path rebuilt the provider entry from a patch that had no metadata field, so the metadata half
  of the save was silently discarded.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`237d9cd`](https://github.com/aio-proxy/aio-proxy/commit/237d9cd4f6810b6695a0624b61d7805991507e1e) Thanks @baranwang - Harden the OAuth provider update contract so a partial patch cannot delete a provider's display name, aliases, or model whitelist.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`cd6c5a3`](https://github.com/aio-proxy/aio-proxy/commit/cd6c5a3dd352ea22198d99345a6da3272510caca) Thanks @baranwang - Keep per-model metadata when an OAuth provider is re-authorized. Every re-login rebuilt the provider
  entry from a fixed field list that omitted `metadata`, so re-authorizing from the Dashboard or running
  `provider login` again deleted all per-model overrides — including `extend`, which is how a model
  tracks its models.dev source.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`798e1e2`](https://github.com/aio-proxy/aio-proxy/commit/798e1e2c230dd925f6a2df1741b52ee75c955852) Thanks @baranwang - Fold the provider editor's advanced fields into collapsed accordions. The closed bars show the current proxy mode, header count, and rewrite-rule count, and the copy now says "request rewrites" throughout.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`cff1a38`](https://github.com/aio-proxy/aio-proxy/commit/cff1a38dda0e9c6e3c0be008580f8144f62ea725) Thanks @baranwang - Fix what the provider editor tells you about its own identity and connection.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`35dacf3`](https://github.com/aio-proxy/aio-proxy/commit/35dacf3cfbd006598e0f1f7a4082f1f2399971c6) Thanks @baranwang - Stop the provider editor offering a save it will reject, and rebuild its footer and section strip to match the rest of the page.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`3cb3b81`](https://github.com/aio-proxy/aio-proxy/commit/3cb3b8135f109c0eb6ee9fab138e83ee32136ae0) Thanks @baranwang - Tighten the provider editor's extra request headers into a single compact row and put the proxy address on its own field. Copy now says "additional request headers" and "use a specific proxy".

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`165d4c1`](https://github.com/aio-proxy/aio-proxy/commit/165d4c1ef27a9519ff6a76387c1740643c038db1) Thanks @baranwang - Make the provider editor's section jump links usable from a keyboard.
  Clicking a section in the nav strip or a link in the save footer now moves keyboard focus into that
  section, not just the viewport — previously focus stayed behind, so the next Tab continued from the
  strip or from Cancel/Save rather than from the section the user asked for. The nav strip is announced as
  the form's section list instead of claiming to be "Edit Provider" even while creating one.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`e3ff7aa`](https://github.com/aio-proxy/aio-proxy/commit/e3ff7aa430a1a0d4429aa93e34f7e77836063c83) Thanks @baranwang - Align the provider editor's models section with the prototype.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`d50d78d`](https://github.com/aio-proxy/aio-proxy/commit/d50d78d7dcdac086fb529dfbafca425ce2281e62) Thanks @baranwang - Fix three provider-editor model regressions.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`c73de2d`](https://github.com/aio-proxy/aio-proxy/commit/c73de2d1bd7c849a239d8e6a3fe139f7b6be4da6) Thanks @baranwang - Align the provider editor's right rail with the prototype. The model-test controls
  disappear when nothing is testable instead of leaving a disabled full-width button,
  the visible "Model to test" label becomes an accessible name only, and a pending
  test keeps the same button copy with a spinner instead of swapping in a second
  string. The exposure panel title is "Model list", its empty state says which names
  will appear, and a disabled provider folds that reason into the same sentence.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`02c0a8b`](https://github.com/aio-proxy/aio-proxy/commit/02c0a8bc9b53175e72e2cc432275a04f8fb934dc) Thanks @baranwang - Four provider-editor follow-ups.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`a3cf9b5`](https://github.com/aio-proxy/aio-proxy/commit/a3cf9b55e0377cd8df102acf3fd9463ff5899207) Thanks @baranwang - A display name that is only whitespace now clears the key on an OAuth provider instead of being written into the config file.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`6fb3a79`](https://github.com/aio-proxy/aio-proxy/commit/6fb3a799f2abd3ee6f4fd11b01a7040be226257f) Thanks @baranwang - Fix four provider editor defects found by a re-survey against the design prototype.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`ef90e90`](https://github.com/aio-proxy/aio-proxy/commit/ef90e90173a91816649d5c76053caf776b30e5dc) Thanks @baranwang - Make the provider editor's section dots agree with its Save button, and fix the section hints. A section
  missing a required field is red, one waiting on an authorization round trip is amber, a finished one stays
  primary — and any section that is not finished blocks Save. Hint counts also read "1 model" rather than
  "1 models", and an OAuth provider whose empty whitelist exposes its whole upstream catalog now says so
  instead of "0 models".

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`ecb6e0c`](https://github.com/aio-proxy/aio-proxy/commit/ecb6e0c74220388cc4dd51445e994b0cef0865a5) Thanks @baranwang - Let the provider Routing section type any weight or priority. Clearing a field means absent, which the
  router treats as weight `1` and priority `0`. The editor shows an empty box for an absent value so it
  is distinguishable from an authored `0`.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b1bcb8d`](https://github.com/aio-proxy/aio-proxy/commit/b1bcb8dc140edff15f9534a8058dd038a2ee5717) Thanks @baranwang - Stop the Dashboard provider editor from deleting a hand-written `endpoints` list.

- [#191](https://github.com/aio-proxy/aio-proxy/pull/191) [`5be2d7c`](https://github.com/aio-proxy/aio-proxy/commit/5be2d7c0c1f2e9d844b33ce17b3fcefc78afd62e) Thanks @baranwang - Raw provider `422` responses now fall through to the next live candidate. Other `4xx` statuses still return immediately.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`4c33182`](https://github.com/aio-proxy/aio-proxy/commit/4c33182e52533af7b613df3e67c82a3cba09cdb0) Thanks @baranwang - Fit each request transform action on one line and stop leaving a blank space where a remove action would show a value.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`ea6b1c9`](https://github.com/aio-proxy/aio-proxy/commit/ea6b1c98ca4c9a9ba35b39de91df4b1b25165135) Thanks @baranwang - Make request transform rules shorter to scan and stop showing the condition builder to rules that do not have a condition.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`0a93cfd`](https://github.com/aio-proxy/aio-proxy/commit/0a93cfd509c919280fcfea53528e1a706edd36d5) Thanks @baranwang - Make the request-transform value editor easier to read and fill in.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`e86cff1`](https://github.com/aio-proxy/aio-proxy/commit/e86cff1401ae66805faee73f5fa990a5249d52fb) Thanks @baranwang - Reduce the provider editor's Routing section to priority and weight number inputs. The attempt-order
  preview is gone, as is the provider-level enabled switch; a provider is enabled or disabled from the
  providers list. Creating an API or AI SDK provider now writes an explicit weight of `1` and priority
  of `0`, matching the router defaults.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`c22a6ec`](https://github.com/aio-proxy/aio-proxy/commit/c22a6ec1e96f9b6e1b014f8601609565bef6ca23) Thanks @baranwang - Fix a Dashboard defect in the request transform stage editor. Nested expression arguments all rendered the
  same accessible name — an outer and an inner argument were both just "Field" — leaving screen reader users
  with no way to tell which control they were on. Each argument control is now named by its argument path
  ("Argument 1 → Field", "Argument 2 → Argument 1 → Field"), following the path the expression editor already
  tracks internally.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`bf7a1cc`](https://github.com/aio-proxy/aio-proxy/commit/bf7a1cce861313f8294822bb78e2d573c658c250) Thanks @baranwang - The provider editor's Model aliases block now offers a Sync plugin aliases button for OAuth providers whose plugin ships default aliases.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`f75367e`](https://github.com/aio-proxy/aio-proxy/commit/f75367ebf14dfd6a47c86c19f0851f27065c6876) Thanks @baranwang - Align the request-transform condition builder and value editor with the demo: computed values show a live expression preview, the expression tree gets its indent, argument markers and connector lines, and condition groups and rows get their own cards instead of a fixed 768px block.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`476b0a8`](https://github.com/aio-proxy/aio-proxy/commit/476b0a8133f3c2a46e710e682006bf8074170bb5) Thanks @baranwang - Align the request-transform editor shell with the demo: one dotted path
  input, usable structure buttons on an invalid rule, and JSON-mode copy
  for unsupported or non-array drafts.

  Empty path values no longer encode as a whole-body replacement. Existing
  `$set: { 'request.body': … }` configs stay byte-identical and open in the
  JSON tab.

- [#188](https://github.com/aio-proxy/aio-proxy/pull/188) [`4bddead`](https://github.com/aio-proxy/aio-proxy/commit/4bddead355c37861e89dd57cf2a6a3514d4b35dc) Thanks @baranwang - core: pin the bundled Bun runtime to 1.4.0 and restore streamed request bodies through HTTP proxies. Bun 1.4.0 ships the `fetch` + `proxy` `ReadableStream` body fix, so `createProxyFetch` no longer buffers the request. Plugin runtime compatibility is now Bun `>=1.4.0`. Compiled macOS binaries are ad-hoc re-signed after `bun build --compile` so they launch on macOS 27. Release runs on macOS so that signature is applied when the CLI is actually published.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`60996d3`](https://github.com/aio-proxy/aio-proxy/commit/60996d3f0927636a3531c01fce35ba30015973a7) Thanks @baranwang - Plugin default aliases now respect a provider's `models` whitelist, so a background catalog refresh can no longer insert an alias target outside it and drop the whole provider out of routing.

- [#184](https://github.com/aio-proxy/aio-proxy/pull/184) [`9b6f0a3`](https://github.com/aio-proxy/aio-proxy/commit/9b6f0a3f26d6bb22fc20298dc203825dca818309) Thanks @baranwang - Cursor first-login now writes family aliases from AvailableModels, so clients can request names like `claude-sonnet-4-6` / `grok-4.6` and match thinking, effort, and speed onto the live wire slug.

- [#192](https://github.com/aio-proxy/aio-proxy/pull/192) [`29a90c2`](https://github.com/aio-proxy/aio-proxy/commit/29a90c24c45d4e00ada1960ca4cfd492344f6535) Thanks @baranwang - Grok OAuth now sends current Grok CLI identity headers and strips Codex Desktop Responses fields that `cli-chat-proxy.grok.com` rejects or hangs on.

## 0.8.0

### Minor Changes

- [#179](https://github.com/aio-proxy/aio-proxy/pull/179) [`667d232`](https://github.com/aio-proxy/aio-proxy/commit/667d2322171b9e41ebdb6ae727701ef7b3866203) Thanks @baranwang - core: select alias targets from effort, thinking, and speed dimensions. A Gemini 1D variant key `off`/`OFF` no longer matches `thinkingLevel: "OFF"`; replace it with `{ "when": { "thinking": false }, "model": "…" }` (or drop the row and use the alias `model`) — shipped Antigravity defaults are unaffected.

- [#177](https://github.com/aio-proxy/aio-proxy/pull/177) [`3975995`](https://github.com/aio-proxy/aio-proxy/commit/3975995850c0bd7c8282d25387bd56c2f9b3c705) Thanks @baranwang - API providers can declare multi-protocol `endpoints` (per-protocol or shared AI SDK-style base URLs). Raw passthrough now matches any natively supported protocol, Anthropic endpoints accept `auth: "bearer"`, and cross-protocol conversion keeps targeting the primary endpoint.

- [#176](https://github.com/aio-proxy/aio-proxy/pull/176) [`b5e40ce`](https://github.com/aio-proxy/aio-proxy/commit/b5e40ceaa0d60eb5fee734c63fb92c9794c3ebc9) Thanks @baranwang - Allow authenticated remote model API access with labeled caller API keys.

### Patch Changes

- [#180](https://github.com/aio-proxy/aio-proxy/pull/180) [`4f73aa6`](https://github.com/aio-proxy/aio-proxy/commit/4f73aa69236d458a8ad8c811287fad03d674ad43) Thanks @baranwang - core: accept namespaced custom tools and align replayed Codex custom/function call history to the unique flattened tool name

## 0.7.0

### Minor Changes

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks @baranwang - Accept Anthropic requests that combine disabled thinking with `output_config.effort`. Keep slow models.dev refreshes off the startup path. Resolve model metadata per source (config overrides catalogs). Fix overview day ranges to read `usage_daily` instead of pruned spans.

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks @baranwang - Dashboard control plane: overview/diagnostics/activity APIs, redesigned traces, rolling 52-week Token heatmap, range-scoped diagnostics and KPI deltas, Provider table + OAuth config, and authenticated Settings/Plugins management.

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks @baranwang - Plugins move display identity into descriptor metadata (`displayName` / `accountLabel`; remove legacy `label` and OAuth capability icons). Add Cursor account OAuth/provider support. Normalize OpenAI Responses errors to `response.failed` for Codex.

## 0.6.4

### Patch Changes

- [#160](https://github.com/aio-proxy/aio-proxy/pull/160) [`08a579c`](https://github.com/aio-proxy/aio-proxy/commit/08a579cad9b5192820cd42f2cbb6ba18e0bc9e18) Thanks @baranwang - Accept empty OpenAI Responses function-call arguments when converting requests across protocols.

## 0.6.3

### Patch Changes

- [#157](https://github.com/aio-proxy/aio-proxy/pull/157) [`ba2aeae`](https://github.com/aio-proxy/aio-proxy/commit/ba2aeae4dfae3d932e2a22ac97d816b74d32a5ca) Thanks @baranwang - core: stop rejecting OpenAI Responses `custom_tool_call` history that has no matching custom tool declaration. Codex compaction turns replay prior custom tool calls (e.g. `apply_patch`) while sending `tools: []`, which previously produced a 501 "OpenAI Responses feature is not supported: custom_tool_call". The transform now converts that history like any other tool call.

## 0.6.2

### Patch Changes

- [#155](https://github.com/aio-proxy/aio-proxy/pull/155) [`04ed2df`](https://github.com/aio-proxy/aio-proxy/commit/04ed2dff458272169af2bf04c36cfc09372f6557) Thanks @baranwang - Fix empty Codex model picker for gpt-5.6 aliases.

- [#150](https://github.com/aio-proxy/aio-proxy/pull/150) [`52cb5ce`](https://github.com/aio-proxy/aio-proxy/commit/52cb5cef04cd1532dac2a773ee61b4fefd72d54d) Thanks @baranwang - Allow OpenAI Responses requests with image detail hints to fall back across provider protocols.

## 0.6.1

### Patch Changes

- [#138](https://github.com/aio-proxy/aio-proxy/pull/138) [`0ac7bd1`](https://github.com/aio-proxy/aio-proxy/commit/0ac7bd11bdf3334aee3bb46576f4b61e2ac24ee7) Thanks @baranwang - Add the Rspress documentation site and its shared UI foundation.

- [#143](https://github.com/aio-proxy/aio-proxy/pull/143) [`5ab65bf`](https://github.com/aio-proxy/aio-proxy/commit/5ab65bf7ef8dd5b74e2589df30b6da7342436cb6) Thanks @baranwang - Support OpenAI Responses instructions and hosted web search on cross-protocol model routes.

## 0.6.0

### Minor Changes

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`963e395`](https://github.com/aio-proxy/aio-proxy/commit/963e3951a64644441a36b0ae4c9b93d644444d18) Thanks @baranwang - extend: resolve per-model `metadata.extend` into effective merged metadata — inherit a models.dev catalog entry as a base layer, deep-merged under your explicit fields, so cost accounting and model resolution both see the inherited values.

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`f15d8d3`](https://github.com/aio-proxy/aio-proxy/commit/f15d8d301a2172eff687bd414cc9a05b7cab4085) Thanks @baranwang - feat: per-provider model metadata & cost overrides Providers can now declare a `metadata` map keyed by upstream model id to override client-facing model metadata (name, description, token limits, capabilities) and cost accounting.

- [#136](https://github.com/aio-proxy/aio-proxy/pull/136) [`465fa49`](https://github.com/aio-proxy/aio-proxy/commit/465fa494bc0446e11b68b0922b29ba2c15880c37) Thanks @baranwang - Make `count_tokens` traces distinguish upstream counts from the local estimate Previously a `count_tokens` request answered by the local estimator was only signalled by an `x-aio-proxy-token-count-estimated: true` response header, and candidates that were passed over before their count capability ran (no token count capability, unsupported image input, or a missing provider tool) left no span at all.

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`6963859`](https://github.com/aio-proxy/aio-proxy/commit/6963859bed52fbb6e56060015bf37c97a9f0abfd) Thanks @baranwang - feat: meter image, web-search, and audio usage for per-event and audio fees The proxy now counts generated images and web-search invocations from served responses (OpenAI Responses output items and streamed AI SDK file/tool-call parts) and reads audio token counts from OpenAI-compatible usage.

### Patch Changes

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`abf31a4`](https://github.com/aio-proxy/aio-proxy/commit/abf31a4c2eaa5c6fedf7dd9831f00e54d2fef8ee) Thanks @baranwang - Fix model-metadata projection and billing gaps: - `/v1/models` now reflects per-provider config metadata overrides — capabilities, `limit.output` (max tokens), and modalities — not just the display name and context window.

## 0.5.2

### Patch Changes

- [#133](https://github.com/aio-proxy/aio-proxy/pull/133) [`39d1b19`](https://github.com/aio-proxy/aio-proxy/commit/39d1b1927055fa483c9d09d82b6e5e76100eee95) Thanks @baranwang - Fix Docker release build failure by building `@aio-proxy/i18n` with rslib The `@aio-proxy/i18n` package built its declarations with `tsc -b`, unlike every other referenced workspace package (which use rslib).

## 0.5.1

### Patch Changes

- [#131](https://github.com/aio-proxy/aio-proxy/pull/131) [`1a525e8`](https://github.com/aio-proxy/aio-proxy/commit/1a525e861a0ef77668c3321f75171bb9e2880e9f) Thanks @baranwang - core: fix proxied streaming passthrough dropping the request body.

## 0.5.0

### Minor Changes

- [#125](https://github.com/aio-proxy/aio-proxy/pull/125) [`7856451`](https://github.com/aio-proxy/aio-proxy/commit/7856451f2434912a619e1c72aca44a1ccd1aaf43) Thanks @baranwang - server: return real upstream token counts for `/v1/messages/count_tokens` when a same-protocol raw provider is configured, and replace the `bytes/64` fallback with a character-class-weighted estimator

- [#129](https://github.com/aio-proxy/aio-proxy/pull/129) [`c6ecfc0`](https://github.com/aio-proxy/aio-proxy/commit/c6ecfc0dc81e6cb0f0c5cd7b27b79f32cfb0955c) Thanks @baranwang - normalize and downgrade reasoning effort per upstream model capability Inbound reasoning-effort values are now accepted leniently and clamped to what each candidate upstream model actually advertises, on both the raw-passthrough and AI SDK model-invocation paths.

### Patch Changes

- [#127](https://github.com/aio-proxy/aio-proxy/pull/127) [`d95834a`](https://github.com/aio-proxy/aio-proxy/commit/d95834ad85ea0352f5c389497ea008c687a80d64) Thanks @baranwang - core: upgrade the bundled Bun runtime to the 1.4 line so proxied streaming passthrough no longer drops the request body. Bun 1.3.x silently discarded a `ReadableStream` request body when `fetch` used a proxy, so `api` providers with a `proxy` configured hung until timeout on streaming requests (e.g. `openai-response` passthrough). The compiled binary embeds the build-time Bun runtime, so this is delivered by pinning the build toolchain to Bun 1.4.

## 0.4.0

### Minor Changes

- [#124](https://github.com/aio-proxy/aio-proxy/pull/124) [`2d1d035`](https://github.com/aio-proxy/aio-proxy/commit/2d1d03580db04a8ff957df3b3dd17d0879599282) Thanks @baranwang - i18n: restructure message keys into nested namespaces and add Traditional Chinese (zh-Hant), Japanese (ja), and Korean (ko) locales - Flat `cli_*`/`common_*`/`error_*`/`wizard_*` keys are now nested, dot-layered namespaces (e.g.

### Patch Changes

- [#121](https://github.com/aio-proxy/aio-proxy/pull/121) [`8c1e690`](https://github.com/aio-proxy/aio-proxy/commit/8c1e69073e52a2921101c767b6d020484b59f857) Thanks @baranwang - ci: fix Docker image publish reading the renamed `published-packages` output from changesets/action, so the GHCR image is tagged and pushed again on release

- [#123](https://github.com/aio-proxy/aio-proxy/pull/123) [`d460128`](https://github.com/aio-proxy/aio-proxy/commit/d4601280f29a5322a30b4baa516bc1906d0ea324) Thanks @baranwang - cli: fix the managed service becoming unreachable after `brew upgrade`.

## 0.3.0

### Minor Changes

- [#117](https://github.com/aio-proxy/aio-proxy/pull/117) [`55d3ccd`](https://github.com/aio-proxy/aio-proxy/commit/55d3ccd49cb6819b8a413050a7a668efc9df17c0) Thanks @baranwang - cli: publish a multi-arch (amd64/arm64) Docker image to GHCR on release, and add a Dockerfile and docker-compose example for running aio-proxy in a container

### Patch Changes

- [#120](https://github.com/aio-proxy/aio-proxy/pull/120) [`38960fd`](https://github.com/aio-proxy/aio-proxy/commit/38960fd9fca94d3e38cb5277a5eb928a3962d96a) Thanks @baranwang - core: accept `role: "system"` messages on the Anthropic Messages endpoint (matching the official SDK's `MessageParam` union) and surface Zod validation path detail in 400 responses without leaking request values

- [#116](https://github.com/aio-proxy/aio-proxy/pull/116) [`5a6deb7`](https://github.com/aio-proxy/aio-proxy/commit/5a6deb759ed7c748369db2dee814d2686dcd2e8d) Thanks @baranwang - server: end streamed request traces at the upstream terminal frame instead of socket EOF, so traces no longer stay "running" after the model finished.

## 0.2.1

### Patch Changes

- [#114](https://github.com/aio-proxy/aio-proxy/pull/114) [`23457e3`](https://github.com/aio-proxy/aio-proxy/commit/23457e3c2a4f306460a25aa6252e477f3bbec6ec) Thanks @baranwang - release: verify the end-to-end publish + single `v<version>` tag + GitHub Release flow. No user-facing behavior change.

## 0.2.0

### Minor Changes

- [#109](https://github.com/aio-proxy/aio-proxy/pull/109) [`2fdb662`](https://github.com/aio-proxy/aio-proxy/commit/2fdb662f1449087dac370988e41793760b3c4c53) Thanks @baranwang - cli: add a `dashboard` command that probes the running daemon and opens the web dashboard in the default browser, resolving host/port via the same control-plane logic as `status`/`doctor` (with `--host`/`--port` overrides). Exits nonzero without opening a browser when the daemon is unreachable.

- [#109](https://github.com/aio-proxy/aio-proxy/pull/109) [`2fdb662`](https://github.com/aio-proxy/aio-proxy/commit/2fdb662f1449087dac370988e41793760b3c4c53) Thanks @baranwang - cli: add an `upgrade` command that detects the install method (brew/bun/npm/pnpm/binary) and upgrades `aio-proxy` in place. Package-manager channels re-install a registry-pinned `pkg@version`; the binary channel does an atomic self-replace with `--version` verification, automatic rollback, and backup sweep. Supports `--check`, `--force`, `--restart`, and `--registry`, and hints to restart a running daemon.

### Patch Changes

- [#109](https://github.com/aio-proxy/aio-proxy/pull/109) [`2fdb662`](https://github.com/aio-proxy/aio-proxy/commit/2fdb662f1449087dac370988e41793760b3c4c53) Thanks @baranwang - ingress: tolerate unknown `detail` values on OpenAI Responses `input_image` parts. Clients such as Codex send `detail: "original"`, which previously failed the input-item union and rejected the whole request with `400 Invalid OpenAI Responses request` before any provider routing. Unrecognized values are now coerced to `undefined` (a best-effort hint), matching how downstream code already treats `detail`.
