# Trace Detail Summary Refinement

## Goal

Make the Trace detail page easier to scan by removing duplicate technical fields and presenting request outcomes in user-facing language without changing the TraceStore or Dashboard API contracts.

## Scope

- Add a back action from Trace detail to the Trace list.
- Show one Session field instead of separate Session and resolution-source fields.
- Show one Model field instead of separate requested and final model fields.
- Combine HTTP status, error type, and error code into one result-detail field.
- Combine Span error type and error code into the same result-detail presentation.
- Display successful completed traces and spans as successful instead of exposing OpenTelemetry `UNSET` as the user-facing status.

## Chosen Approach

Keep the persisted OpenTelemetry status and existing DTO fields unchanged. Normalize them only at the Dashboard presentation layer.

This preserves correct OpenTelemetry semantics, existing filters, and API compatibility while limiting the change to the components that own the display behavior.

## Detail Page Behavior

### Navigation

Pass `/traces` to the existing `PageContainer` back navigation API in loading, error, and loaded states. No new navigation component is needed.

### Session

The Session row displays the Session ID as the clickable value. Its tooltip identifies the Session source, such as `openai-prompt-cache` or `generated`.

Clicking the Session ID continues to navigate to page one of the Trace list with both the exact Session source and Session ID filters. The separate `sessionResolvedBy` row is removed because it duplicates the source in current session resolutions.

### Model

The summary contains one Model row whose primary value is `requestedModelId`, falling back to `finalModelId` only when the requested model is unavailable.

When `finalModelId` is defined and differs from `requestedModelId`, the model value gains a tooltip that labels `finalModelId` as the upstream model. No tooltip is shown when both values match. The final Provider row remains unchanged.

### Result Details

The summary contains one Result details row assembled from the available values in this order:

1. HTTP status
2. Error type
3. Error code

Missing values are omitted. Present values use one compact line such as `HTTP 503 · upstream_error · provider_unavailable`. If all three values are absent, the existing not-available value is shown. The overall request status remains a separate Badge.

The selected Span panel uses the same Result details label and formatting for its available error type and error code. Span status remains a separate Badge, and Span-specific attributes, events, and links are unchanged.

### User-Facing Status

`TraceStatus` derives one operational label with this precedence:

1. `endedAt === null` → Running
2. `terminationReason` is present → Failure, Cancelled, or Interrupted
3. `otelStatusCode === ERROR` → Error
4. completed `OK` or `UNSET` → Success

This mapping applies consistently to Trace list rows, the Trace summary, and Span displays. Raw OTel values remain available to API consumers and filters.

## Data Flow

No server or database changes are required. Existing `DashboardTraceSummary` and `DashboardTraceSpan` fields flow through unchanged. The Dashboard combines and labels them at render time.

## Accessibility and Internationalization

- The existing icon back link keeps its localized accessible label.
- Tooltip triggers remain keyboard focusable through the shared Base UI Tooltip component.
- New labels and tooltip copy are added to both English and Simplified Chinese message catalogs.
- Status meaning is communicated by text as well as Badge styling.

## Testing

Extend the existing Trace detail page behavior tests using TDD:

- the back link targets `/traces` in page states;
- Session ID is the visible action and Session source appears in its tooltip;
- the redundant resolution-source row is absent;
- one Model value is shown and the upstream-model tooltip appears only for mismatches;
- HTTP status and error metadata render in one summary row;
- Span error type and error code render in one result-details row;
- a completed trace with OTel `UNSET` renders as Success;
- existing Session-filter navigation remains intact.

Run the focused Dashboard tests first, then `bun run preflight` before completion.

## Non-Goals

- Changing OpenTelemetry status persistence.
- Removing raw OTel status filters.
- Changing TraceStore, Dashboard API DTOs, or database migrations.
- Redesigning the Span waterfall or usage summary.
