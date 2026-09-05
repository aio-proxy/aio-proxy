# @aio-proxy/ui

## 0.19.2

No changes in this release.

## 0.19.1

No changes in this release.

## 0.19.0

### Patch Changes

- [#276](https://github.com/aio-proxy/aio-proxy/pull/276) [`2e76766`](https://github.com/aio-proxy/aio-proxy/commit/2e7676669a60d42af8d545e8d1614a295fabfae6) Thanks [@baranwang](https://github.com/baranwang)! - Make a quota reset redemption legible while it happens. The redeem button lives inside the quota popup, so its confirmation is now inline — next to the count being spent, instead of behind a second stacked frame that covered the reading the decision is made from. While the redemption is in flight the button is replaced in place by a spinner, so the wait is visible rather than looking like a dead click, and the confirmation cannot be re-offered against a count that is already being spent. Redeeming the last available credit keeps that spinner until the request settles, instead of removing it the moment the refreshed count reaches zero mid-request. The prompt no longer names the Provider the popup header already identifies, and it is announced to whichever button is focused. Focus follows the redemption instead of dropping to the page: onto the spinner for the wait, and back onto the redeem button — or onto the popup, when the last credit leaves no button to return to — whether the redemption completes or is cancelled.

  A redemption can no longer be spent twice. Closing the quota popup and reopening it before the request settled used to present the confirmation again over the stale count, and confirming spent a second credit; the wait is now read from the pending redemption itself, which outlives the popup. An open confirmation is also retracted when a refresh finds the inventory emptied elsewhere, rather than offering a credit that no longer exists.

  Toasts now render above dialogs and sheets instead of being dimmed and blurred by their backdrop, so the confirmation a modal action gives is actually legible. A successful redemption also sets off a burst of confetti from the button that was pressed, because a corner toast behind a modal was too easy to miss for the one irreversible action in the popup. It is skipped for anyone whose system asks for reduced motion.

## 0.18.1

## 0.18.0

## 0.17.0

### Patch Changes

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`9b80f0c`](https://github.com/aio-proxy/aio-proxy/commit/9b80f0cbb813a709a42638915224d81f1e16241e) Thanks [@baranwang](https://github.com/baranwang)! - Build the Settings About rows from the shadcn `Item` primitive so the repository and documentation rows are clickable end to end instead of only through their chevron.

- [#267](https://github.com/aio-proxy/aio-proxy/pull/267) [`cef9deb`](https://github.com/aio-proxy/aio-proxy/commit/cef9deb1441d7c22cf64b412fb6a311bac1f761a) Thanks [@baranwang](https://github.com/baranwang)! - Render the dashboard's default-size switches as Safari's native `<input type="checkbox" switch>` when the browser supports it, falling back to the Base UI implementation everywhere else.

## 0.16.0

## 0.15.0

## 0.14.0

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

- [#239](https://github.com/aio-proxy/aio-proxy/pull/239) [`07413a1`](https://github.com/aio-proxy/aio-proxy/commit/07413a116385e94e20e2c722ecdb32c0b97d52b6) Thanks [@baranwang](https://github.com/baranwang)! - Restore the accessible names on the combobox clear and chip remove buttons

  A `shadcn add combobox --overwrite` had discarded the hand-applied patch, leaving both icon-only
  buttons announced as an unnamed "button" and forwarding the localized labels to the DOM as dead
  attributes. The same overwrite re-hid the chevron trigger whenever a value was set, which left a
  pointer user on a filled field with no visible control that reveals the curated list.

- [#242](https://github.com/aio-proxy/aio-proxy/pull/242) [`672e0db`](https://github.com/aio-proxy/aio-proxy/commit/672e0dbb4eb0d81b965164b05d7a83dc9db23cda) Thanks [@baranwang](https://github.com/baranwang)! - Replace the Dashboard `cn` helper's `clsx` and `tailwind-merge` implementation with the `cn` package.

## 0.12.3

## 0.12.2

## 0.12.1

## 0.12.0

## 0.11.2

## 0.11.1

## 0.11.0

## 0.10.0

## 0.9.1

## 0.9.0

### Minor Changes

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`c5b04c1`](https://github.com/aio-proxy/aio-proxy/commit/c5b04c183b0a9669f518bcb18f38019e96d3a8ca) Thanks [@baranwang](https://github.com/baranwang)! - Redesign the provider editor into a single page shared by api, ai-sdk, and oauth providers: five fixed sections, a persistent exposure/validation rail, an in-place two-stage OAuth authorization flow, inline alias editing, a routing weight slider, and a visual model-metadata tab. OAuth providers gain a `models` whitelist that filters the discovered catalog (empty or absent exposes everything); ai-sdk providers with an OpenAI-shaped `options.baseURL` can list their catalog; oauth providers can run draft model tests; `models: []` no longer invalidates alias-only providers. The provider edit endpoint now returns the stored credentials so the editor can prefill them, replacing the previous redaction sentinels; `GET /dashboard/api/config` and `aio-proxy config` still mask secrets.

## 0.8.0

## 0.7.0

### Minor Changes

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Dashboard control plane: overview/diagnostics/activity APIs, redesigned traces, rolling 52-week Token heatmap, range-scoped diagnostics and KPI deltas, Provider table + OAuth config, and authenticated Settings/Plugins management.

## 0.6.4

## 0.6.3

## 0.6.2

## 0.6.1

### Patch Changes

- [#138](https://github.com/aio-proxy/aio-proxy/pull/138) [`0ac7bd1`](https://github.com/aio-proxy/aio-proxy/commit/0ac7bd11bdf3334aee3bb46576f4b61e2ac24ee7) Thanks [@baranwang](https://github.com/baranwang)! - Add the Rspress documentation site and its shared UI foundation.
