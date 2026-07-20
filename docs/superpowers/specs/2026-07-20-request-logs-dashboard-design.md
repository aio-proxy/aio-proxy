# Request Logs Dashboard Interaction Design

## Goal

Make the request logs page faster to scan and operate by reducing the filter area, removing misleading table controls, and preserving the exact filters needed for troubleshooting.

This supports the dashboard's “Quiet Control Tower” direction: operations stay dense without becoming crowded, and progressive disclosure keeps exact troubleshooting controls available without making them the page's visual focus.

## Decisions

- Use one compact toolbar for the common filters: time range, requested model ID, outcome, and inbound protocol.
- Put request ID, final Provider ID, final model ID, and final status code in a non-modal “More filters” popover.
- Keep auto-refresh and manual refresh in the toolbar. Auto-refresh remains available only on the first page.
- Show the active advanced-filter count on the “More filters” trigger and provide a clear-all action.
- Remove the current-page search field, column visibility control, and client-side table sorting.
- Keep the existing API result order, server pagination, row selection, and detail view.

The removal of sorting, page filtering, and column visibility is a deliberate exception to the dashboard's default table capabilities. Request logs are server-paginated, so client-side controls would affect only the loaded page and misrepresent the full result set.

## Interaction

Changing any filter updates route search state and returns pagination to page 1. Common filters are immediately available; advanced filters open on demand without navigating away or blocking the table. Clearing advanced filters removes only those advanced values.

Manual refresh preserves the current query. Auto-refresh continues using the existing five-second interval while page 1 is active. The refresh control must expose an accessible label even when rendered as an icon.

Table headers are plain labels. They do not look clickable and do not reorder only the current server page. A row remains keyboard-focusable and opens request details with click, Enter, or Space.

## Layout and Responsive Behavior

The toolbar uses the existing shadcn `base-luma` and Base UI controls, 36px control height, semantic color tokens, and the dashboard's 4px spacing scale. It avoids a separate oversized card and wraps controls only when the available width requires it. Signal teal remains reserved for actions and focus; the toolbar adds no decorative color, shadow, or motion.

On narrow screens, common controls wrap into a readable stack. The advanced-filter popover uses the shared elevated Popover treatment and a single-column layout constrained to the viewport. The table keeps horizontal scrolling for its fixed operational columns.

## Component Changes

- `LogsFilters` owns the compact toolbar, advanced-filter popover, reset behavior, and refresh controls.
- `LogsTable` renders the table and server pagination only. It no longer owns current-page filtering, sorting, or column visibility state.
- Existing `LogsSearch`, query options, pagination, and detail selection contracts remain unchanged.
- No new shared abstraction or dependency is introduced.

## States and Accessibility

Existing loading, error, empty, and request-detail behavior remains intact. Every form control retains a visible translated label or an accessible translated name. Focus behavior comes from the existing shadcn/Base UI primitives, and the popover must be keyboard operable. The advanced-filter count uses text as well as the shared Badge treatment so color is never the only signal.

## Verification

- Add one behavior-level interaction test covering an advanced filter: open “More filters,” change an exact filter, and verify the emitted search resets to page 1 while preserving the other criteria.
- Run i18n compilation if message keys change.
- Run the dashboard checks and affected tests, followed by the repository preflight when feasible.
- Visually verify desktop and narrow layouts, keyboard access, popover positioning, refresh state, and horizontal table scrolling.
