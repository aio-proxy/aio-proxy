# Trace List Metrics Design

## Goal

Make the trace list show the same session identity semantics as the detail page and expose useful request timing and token breakdowns without adding a database migration.

## Display

- Session cells show the Session ID as the primary value. Hovering or focusing it shows the session source with the same tooltip copy used by the detail page.
- The provider column is labeled “Provider” / “提供商” and shows only the Provider ID; it does not show the final model.
- The HTTP status table header removes “最终” / “Final” in every locale.
- Token cells show input and output on the first line as `↑ <input> ↓ <output>`. The second line shows cache read and cache write separately. If all four displayed token fields are missing, the entire cell renders `—` instead of individual `N/A` values.
- Duration cells keep total duration on the first line. Streaming requests show TTFT on the second line; non-streaming requests do not render a TTFT line.
- Missing token values and missing TTFT for a streaming request render through the existing missing-value convention as muted `N/A`.

## Data Flow

The request root records whether streaming was requested with the existing `aio_proxy.request.stream` attribute. The selected provider attempt already records TTFT in `aio_proxy.response.ttft_ms`. When the request completes, copy the final attempt value into the root trace attributes. `rowToSummary` projects both as optional `DashboardTraceSummary.stream` and `DashboardTraceSummary.ttftMs`, so list rendering remains a single root-span query.

Streaming requests interrupted before first byte and legacy streaming traces may have no TTFT; those rows show `N/A`. Non-streaming requests omit the TTFT row.

## Scope

- Reuse `TokenCount`, shadcn Tooltip, and existing trace formatting helpers.
- Do not add color tokens, dependencies, database columns, or migrations.
- Preserve unrelated edits already present in `traces-table.tsx` and adjacent files.

## Verification

- Add behavior-level coverage for root-summary TTFT projection and the trace list cell content.
- Update the existing `TokenCount` missing-value expectation from `-` to `N/A`.
- Run affected tests, dashboard checks, i18n compilation, and dashboard build; report environment-blocked commands accurately.
