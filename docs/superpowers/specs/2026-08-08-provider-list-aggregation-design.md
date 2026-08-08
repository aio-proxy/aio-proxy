# Provider list aggregation

## Scope

Adjust the dashboard Provider list presentation only. Keep existing OAuth grouping, sorting, pagination, focus behavior, edit links, switches, and action menus unchanged.

## Table layout

- Add an unlabeled first column.
- Show an expand/collapse chevron in that column only for grouped OAuth rows; leave it empty for concrete Provider rows.
- Replace the separate Protocol column with the existing Type column. API Providers render their type and protocol together (`API · <protocol>`); AI SDK Providers continue to show their package identity, and OAuth rows show `OAuth`.

## Group interaction

- Render an OAuth aggregate as normal table cells rather than one spanning cell.
- Clicking any non-control part of an aggregate row toggles its accounts. The first-column chevron remains a keyboard-accessible button and shares the same state.
- Expanded rows continue to render the existing concrete Provider controls unchanged.

## Verification

Update the Provider table tests to assert the combined type/protocol value, the aggregate marker column, and both row-click expansion and collapse.
