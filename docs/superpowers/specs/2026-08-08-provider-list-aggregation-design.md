# Provider list aggregation

## Scope

Adjust the dashboard Provider list and its existing usage endpoint only. Keep existing OAuth grouping, sorting, pagination, focus behavior, edit links, switches, and action menus unchanged.

## Table layout

- Add an unlabeled first column.
- Show an expand/collapse chevron in that column only for grouped OAuth rows; leave it empty for concrete Provider rows.
- Replace the separate Protocol column with the existing Type column. API Providers render their type and protocol together (`API · <protocol>`); AI SDK Providers continue to show their package identity, and OAuth rows show `OAuth`.
- Add a `24h usage` column with request count, total tokens, and estimated cost as compact stacked values.

## Group interaction

- Render an OAuth aggregate as normal table cells rather than one spanning cell.
- Clicking any non-control part of an aggregate row toggles its accounts. The first-column chevron remains a keyboard-accessible button and shares the same state.
- Expanded rows continue to render the existing concrete Provider controls unchanged.
- An OAuth aggregate row sums each `24h usage` value across all of its accounts.

## Usage data

- Extend the existing dashboard usage endpoint with an optional `maxResults` query parameter that limits retained grouped results. When omitted, all groups are returned; when set to `5`, the current top-five-plus-Other chart behavior remains.
- The Usage page explicitly sends `maxResults=5`. The Provider list sends no limit with its rolling `24h` and `provider` grouping.
- Query requests, tokens, and cost in parallel, then sum each metric across every returned time bucket by Provider ID.
- Refresh with the existing 60-second usage-query interval. Missing Provider data renders as zero.

## Verification

Update core usage-overview tests for both limited and unlimited grouped responses. Update dashboard usage-query tests for the explicit limit. Update the Provider table tests to assert the combined type/protocol value, the aggregate marker column, row-click expansion and collapse, per-Provider usage values, and OAuth usage totals.
