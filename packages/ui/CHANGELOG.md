# @aio-proxy/ui

## 0.39.1

No changes in this release.

## 0.39.0

No changes in this release.

## 0.38.0

No changes in this release.

## 0.37.0

No changes in this release.

## 0.36.1

No changes in this release.

## 0.36.0

### Patch Changes

- [#457](https://github.com/aio-proxy/aio-proxy/pull/457) [`98aa84c`](https://github.com/aio-proxy/aio-proxy/commit/98aa84c42b513080f18edf43d7bc4ac8dbb924c5) Thanks @baranwang - The dashboard now waits out a brief server restart instead of showing "Dashboard unavailable" until reloaded. On the Routing page, token limits and prices follow the dashboard language (`128K`, `$2.00`) instead of the system one, traffic charts name Providers instead of showing their IDs, API Providers no longer list their protocol, and an empty traffic chart gets a proper empty state. Mixed CJK and Latin text is now auto-spaced.

## 0.35.1

No changes in this release.

## 0.35.0

No changes in this release.

## 0.34.0

### Patch Changes

- [#437](https://github.com/aio-proxy/aio-proxy/pull/437) [`5dea413`](https://github.com/aio-proxy/aio-proxy/commit/5dea4139c4567284858ae04c8636dd961e47af72) Thanks @baranwang - Agent authorization is completed on a single screen: the footer always offers stacked approve and deny buttons, disabled until the code entry is complete. Completing the code resolves it automatically — the request appears as a panel above the entry, a failed resolve shows an alert, and a code carried in a URL is simply pre-filled into the same flow. Approving or denying shows the final outcome, and expired, used, or already decided codes are reported with a toast.

## 0.33.4

No changes in this release.

## 0.33.3

No changes in this release.

## 0.33.2

No changes in this release.

## 0.33.1

No changes in this release.

## 0.33.0

No changes in this release.

## 0.32.0

No changes in this release.

## 0.31.0

No changes in this release.

## 0.30.0

No changes in this release.

## 0.29.0

No changes in this release.

## 0.28.0

### Minor Changes

- [#382](https://github.com/aio-proxy/aio-proxy/pull/382) [`25f9ec0`](https://github.com/aio-proxy/aio-proxy/commit/25f9ec0be50b28f8f5cc75f20a250e8b0bbc8ed7) Thanks @baranwang - 调用链列表页进入时不再自动轮询，工具栏新增「实时」开关，时间范围选择器从筛选抽屉移到工具栏常驻。表格上方新增按时间分桶的成功/失败堆叠柱状图：图例显示区间总数并直接充当状态筛选，点击柱体把时间范围收窄到该桶，折叠状态记在本地。表格的「状态」列移到 HTTP 之后。

## 0.27.1

No changes in this release.

## 0.27.0

No changes in this release.

## 0.26.0

No changes in this release.

## 0.25.0

No changes in this release.

## 0.24.0

No changes in this release.

## 0.23.2

No changes in this release.

## 0.23.1

No changes in this release.

## 0.23.0

No changes in this release.

## 0.22.1

No changes in this release.

## 0.22.0

No changes in this release.

## 0.21.0

No changes in this release.

## 0.20.5

No changes in this release.

## 0.20.4

No changes in this release.

## 0.20.3

No changes in this release.

## 0.20.2

### Patch Changes

- [#316](https://github.com/aio-proxy/aio-proxy/pull/316) [`3b4c12e`](https://github.com/aio-proxy/aio-proxy/commit/3b4c12e0e3f5b502cacf4c22aa9a88188608c3da) Thanks @baranwang - The plugin SDK now exports shared abortableSleep and dedupeQuotaItemIds helpers, preserving OAuth cancellation reasons and provider-specific quota IDs. Removed unused UI and internal wrappers, plus the unused AioModelMessage and AioStreamPart schemas and associated types from @aio-proxy/types.

## 0.20.1

No changes in this release.

## 0.20.0

No changes in this release.

## 0.19.2

### Patch Changes

- [#293](https://github.com/aio-proxy/aio-proxy/pull/293) [`cf45f02`](https://github.com/aio-proxy/aio-proxy/commit/cf45f0222aa85754e64f19dee184228769c97ddd) Thanks @baranwang - Render the AIO Proxy wordmark from vector geometry instead of a webfont The dashboard logo drew "Proxy" with an SVG `<text>` element styled `font-heading font-semibold`.

## 0.19.1

No changes in this release.

## 0.19.0

### Patch Changes

- [#276](https://github.com/aio-proxy/aio-proxy/pull/276) [`2e76766`](https://github.com/aio-proxy/aio-proxy/commit/2e7676669a60d42af8d545e8d1614a295fabfae6) Thanks @baranwang - Make a quota reset redemption legible while it happens.

## 0.18.1

## 0.18.0

## 0.17.0

### Patch Changes

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`9b80f0c`](https://github.com/aio-proxy/aio-proxy/commit/9b80f0cbb813a709a42638915224d81f1e16241e) Thanks @baranwang - Build the Settings About rows from the shadcn `Item` primitive so the repository and documentation rows are clickable end to end instead of only through their chevron.

- [#267](https://github.com/aio-proxy/aio-proxy/pull/267) [`cef9deb`](https://github.com/aio-proxy/aio-proxy/commit/cef9deb1441d7c22cf64b412fb6a311bac1f761a) Thanks @baranwang - Render the dashboard's default-size switches as Safari's native `<input type="checkbox" switch>` when the browser supports it, falling back to the Base UI implementation everywhere else.

## 0.16.0

## 0.15.0

## 0.14.0

## 0.13.0

### Minor Changes

- [#239](https://github.com/aio-proxy/aio-proxy/pull/239) [`b1f5bff`](https://github.com/aio-proxy/aio-proxy/commit/b1f5bff2f2e92abfd54b90fb32b29b4b145e8c1d) Thanks @baranwang - Redesign the dashboard Provider list as a card grid and surface OAuth remaining quota.

### Patch Changes

- [#239](https://github.com/aio-proxy/aio-proxy/pull/239) [`07413a1`](https://github.com/aio-proxy/aio-proxy/commit/07413a116385e94e20e2c722ecdb32c0b97d52b6) Thanks @baranwang - Restore the accessible names on the combobox clear and chip remove buttons

  A `shadcn add combobox --overwrite` had discarded the hand-applied patch, leaving both icon-only
  buttons announced as an unnamed "button" and forwarding the localized labels to the DOM as dead
  attributes. The same overwrite re-hid the chevron trigger whenever a value was set, which left a
  pointer user on a filled field with no visible control that reveals the curated list.

- [#242](https://github.com/aio-proxy/aio-proxy/pull/242) [`672e0db`](https://github.com/aio-proxy/aio-proxy/commit/672e0dbb4eb0d81b965164b05d7a83dc9db23cda) Thanks @baranwang - Replace the Dashboard `cn` helper's `clsx` and `tailwind-merge` implementation with the `cn` package.

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

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`c5b04c1`](https://github.com/aio-proxy/aio-proxy/commit/c5b04c183b0a9669f518bcb18f38019e96d3a8ca) Thanks @baranwang - Redesign the provider editor into a single page shared by api, ai-sdk, and oauth providers: five fixed sections, a persistent exposure/validation rail, an in-place two-stage OAuth authorization flow, inline alias editing, a routing weight slider, and a visual model-metadata tab.

## 0.8.0

## 0.7.0

### Minor Changes

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks @baranwang - Dashboard control plane: overview/diagnostics/activity APIs, redesigned traces, rolling 52-week Token heatmap, range-scoped diagnostics and KPI deltas, Provider table + OAuth config, and authenticated Settings/Plugins management.

## 0.6.4

## 0.6.3

## 0.6.2

## 0.6.1

### Patch Changes

- [#138](https://github.com/aio-proxy/aio-proxy/pull/138) [`0ac7bd1`](https://github.com/aio-proxy/aio-proxy/commit/0ac7bd11bdf3334aee3bb46576f4b61e2ac24ee7) Thanks @baranwang - Add the Rspress documentation site and its shared UI foundation.
