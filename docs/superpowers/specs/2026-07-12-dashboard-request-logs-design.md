# Dashboard Request Logs Design

## Goal

Add a Dashboard request-log page for auditing terminal proxy requests. The page reuses the request metadata and usage data already retained in SQLite; it does not capture request or response bodies, process output, or credentials.

## Scope

The first release includes:

- a `Logs` item in the Dashboard overview navigation;
- terminal request filters stored in the page URL;
- server-side pagination ordered by newest completion time first;
- a compact table with usage and cost columns;
- a side drawer with complete terminal metadata, usage details, and the ordered provider-attempt chain;
- manual refresh on every page and optional five-second polling on page 1;
- the existing 45-day retention policy and Dashboard access boundary.

The first release excludes:

- aggregate cards, charts, RPM, TPM, or other statistics on the logs page;
- CSV or other exports;
- request bodies, response bodies, streamed content, headers, API keys, or stdout/stderr capture;
- filtering by intermediate attempts stored in `attempts_json`;
- new Dashboard authentication or authorization;
- configurable or permanent retention;
- configurable table columns.

## Reference Behavior

The page borrows the management-table orientation of New API's `/usage-logs/common` route and the URL-backed filters, provider-chain detail, and refresh controls of Claude Code Hub's `/dashboard/logs` route. It deliberately does not copy their statistics, export, virtual scrolling, identity filters, or billing-specific fields.

## Data Model

No new request data is recorded. Each row represents one terminal inbound request from `request_log`; fallback attempts remain an ordered JSON array on that row, and successful usage remains joined by `request_id` from `usage`.

The list and detail response may expose only fields already stored by these tables:

- request: ID, inbound protocol, requested model, outcome, start/completion time, duration;
- final route: provider, model, HTTP status, error code;
- usage: provider/model attribution, input/output/total/cache-read/cache-write/reasoning tokens, estimated USD cost;
- attempts: index, provider, model, provider kind, protocol, outcome, HTTP status, error code, duration.

Missing usage, status, route, token, or cost values remain `null`/absent and render as an em dash. The UI must not infer zero usage or zero cost from missing data.

## Query Contract

Add a typed `GET /dashboard/api/logs` endpoint. Query validation rejects malformed values with the existing Hono validation behavior.

Supported query fields:

| Field              | Semantics                                            |
| ------------------ | ---------------------------------------------------- |
| `page`             | One-based integer, default `1`                       |
| `pageSize`         | Integer `10`, `20`, `50`, or `100`; default `50`     |
| `startedAfter`     | Inclusive ISO-8601 instant applied to `started_at`   |
| `completedBefore`  | Inclusive ISO-8601 instant applied to `completed_at` |
| `requestId`        | Exact request ID match after trimming                |
| `outcome`          | Exact `success`, `failure`, or `cancelled` match     |
| `inboundProtocol`  | Exact protocol match                                 |
| `requestedModelId` | Exact requested-model match                          |
| `finalProviderId`  | Exact final-provider match                           |
| `finalModelId`     | Exact final-model match                              |
| `finalStatusCode`  | Exact integer HTTP status match                      |

The response contains:

```ts
type DashboardRequestLogsResponse = {
  readonly items: readonly DashboardRequestLog[];
  readonly page: number;
  readonly pageSize: 10 | 20 | 50 | 100;
  readonly total: number;
  readonly pageCount: number;
};
```

Rows sort by `completed_at DESC, request_id DESC` so pagination is deterministic when multiple requests complete in the same millisecond. A requested page beyond the final page returns an empty `items` array with the actual `total` and `pageCount`; the client returns to page 1 whenever filters or page size change.

The default UI range is the rolling 24 hours ending when the route first loads. A single shadcn/ui Base date-range picker replaces separate start/end datetime inputs. The picker follows the official `Popover` plus `Calendar` composition with `mode="range"`; shadcn/ui does not define a standard preset footer, so the page does not add custom shortcut buttons.

Selecting a complete calendar range converts the first day to local `00:00:00.000` and the last day to local `23:59:59.999` before storing the corresponding ISO instants in the URL. An incomplete range remains local picker state and does not change the active query. The initial rolling 24-hour range remains exact even though its button label displays the covered calendar dates. The browser URL stores explicit instants so reloads and shared URLs reproduce the same query. Dates older than the 45-day retention boundary are disabled in the picker, while the server remains correct for arbitrary valid instants.

## Storage and Indexes

Keep the existing completion-time and outcome/completion-time indexes. Add only indexes needed by the confirmed terminal filters, with completion time as the trailing sort/range column where useful:

- `(final_provider_id, completed_at)`;
- `(requested_model_id, completed_at)`;
- `(final_model_id, completed_at)`;
- `(inbound_protocol, completed_at)`;
- `(final_status_code, completed_at)`.

`request_id` is already the primary key. Do not index or query inside `attempts_json`. The usage join continues to use its unique `request_id` key.

## Dashboard Page

Create a `/logs` Dashboard route under the overview navigation group. The page uses the existing `PageContainer`, data-table/pagination components, form controls, badges, skeletons, empty states, and Drawer primitives.

The filter area contains:

- one shadcn/ui Base date-range picker with no custom shortcut presets;
- request ID text input;
- outcome, inbound protocol, requested model, final provider, final model, and final status controls;
- reset and manual refresh actions;
- an auto-refresh switch visible on page 1.

Filter controls update URL search parameters and reset `page` to 1. The explicit start and end instants always remain in the URL; empty/default values for other filters are omitted. Invalid URL values fall back to defaults rather than crashing the route.

The desktop table shows:

1. completion time;
2. outcome;
3. inbound protocol;
4. requested model;
5. final provider and model;
6. final status;
7. duration;
8. total tokens;
9. estimated cost.

For total tokens, display the stored `totalTokens` when present; otherwise display `inputTokens + outputTokens` only when both values are present. Do not include cache or reasoning buckets in this fallback total. Estimated cost uses the Dashboard's existing USD formatting conventions.

On narrow screens, retain the same information in a horizontally scrollable table rather than introducing a second mobile-card implementation in the first release.

## Detail Drawer

Clicking a row opens a side drawer without navigation, so the current filters, page, scroll position, and loaded rows remain intact. The drawer contains:

- request ID with a copy action;
- start/completion timestamps, duration, outcome, protocol, requested model, final provider/model, status, and error code;
- all stored usage buckets and estimated cost;
- the ordered attempt chain, showing attempt number, provider, model, provider kind, protocol, outcome, status, error code, and duration.

The list endpoint already returns all data required by the drawer, so the first release does not add a second detail endpoint or fetch on drawer open.

## Refresh Behavior

Page 1 polls every five seconds by default. The user can disable polling with the auto-refresh switch. Pages greater than 1 never poll, and the switch is hidden or disabled there. Manual refresh invalidates the current logs query on every page without changing filters or page number.

Polling refetches page 1 in place. It does not open or close the detail drawer. If the selected row disappears from the current result after a refresh, the already-selected row snapshot remains visible until the drawer closes.

## Error, Loading, and Empty States

- Initial loading renders table skeletons.
- Refetching retains the previous table and shows activity on the refresh control.
- A failed request renders the existing query-error treatment and offers manual retry.
- No matching rows renders an empty state that preserves the filters and offers reset.
- Missing optional row fields render as em dashes, not errors.

## Internationalization and Accessibility

All labels, filter options, empty/error messages, column names, drawer labels, and refresh controls use the existing `@aio-proxy/i18n` message system in every supported locale.

Rows are keyboard-focusable and open the drawer with Enter or Space. The refresh button, auto-refresh switch, copy action, filter controls, and drawer close action have accessible names. Outcome and status are not communicated by color alone.

## Testing

Core database tests cover:

- deterministic newest-first pagination;
- total and page-count calculation;
- each terminal filter and combined filters;
- usage join with missing usage preserved;
- out-of-range pages;
- retention pruning remains unchanged.

Server tests cover:

- valid query parsing and typed response data;
- default pagination;
- invalid page, page size, status, outcome, and timestamp rejection;
- the endpoint remains read-only and follows the current Dashboard access boundary.

Dashboard tests cover:

- URL search parameters map to query inputs and invalid values fall back safely;
- the date-range picker displays the active range, keeps incomplete selections local, commits complete selections as local-day boundaries, and disables dates outside retention;
- changing filters or page size resets the page;
- table fields and missing-value rendering;
- drawer request, usage, and attempt details;
- page-1 polling, the user toggle, history-page pause, and manual refresh;
- loading, empty, and error states;
- keyboard row activation and accessible control labels.

## Acceptance Criteria

The feature is accepted when a user can open Dashboard Logs, query any retained terminal request by the confirmed filters, page deterministically through results, compare token/cost values in the table, inspect fallback attempts in a drawer, and refresh recent traffic without disturbing historical pages. Existing overview metrics, request routing, recording, pruning, and provider configuration behavior must remain unchanged.
