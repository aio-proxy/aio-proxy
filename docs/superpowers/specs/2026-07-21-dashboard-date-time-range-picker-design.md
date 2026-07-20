# Dashboard Date-Time Range Picker Design

## Summary

Create one reusable dashboard date-time range picker modeled on Cloudflare's compact range selector, then use it on the request Logs page. The component combines a single-month range calendar, caller-provided relative presets, editable From/To values, draft-and-apply behavior, and a responsive mobile Sheet.

The component owns presentation, draft state, parsing, and validation. It does not know about TanStack Router, Logs search parameters, polling, or server APIs. Logs remains responsible for its default range, URL representation, rolling preset resolution, and ISO serialization.

## Goals

- Replace the Logs-specific calendar popover with a reusable date-time range picker.
- Preserve the existing default of the user's local current day, from `00:00:00.000` through `23:59:59.999`.
- Support rolling relative presets without freezing them into one historical range.
- Support custom date and time input using a caller-provided format string.
- Interpret every range in the user's current browser time zone.
- Match the existing dashboard design system and remain usable on narrow screens.

## Non-goals

- Do not replace Usage range tabs or extend the Usage API.
- Do not expose time-zone selection or add arbitrary-zone infrastructure.
- Do not enforce the Logs 45-day window on the server.
- Do not change the Logs API or database's inclusive range semantics.
- Do not create a single-date mode.
- Do not add a second calendar, popover, input, or select library.

## Public Component Contract

The shared component accepts range endpoints that JavaScript `Date` can consume and emits normalized `Date` instances.

```ts
type DateTimeInput = string | number | Date;
interface DateTimeRangeValue {
  readonly from: DateTimeInput;
  readonly to: DateTimeInput;
}

interface ResolvedDateTimeRangeValue {
  readonly from: Date;
  readonly to: Date;
}

interface DateTimeRangePreset {
  readonly id: string;
  readonly label: string;
  readonly resolve: (now: Date) => ResolvedDateTimeRangeValue;
}

interface DateTimeRangeChangeContext {
  readonly presetId: string | undefined;
}

interface DateTimeRangePickerProps {
  readonly value: DateTimeRangeValue | undefined;
  readonly presetId?: string;
  readonly presets?: readonly DateTimeRangePreset[];
  readonly format?: string;
  readonly min?: DateTimeInput;
  readonly max?: DateTimeInput;
  readonly allowClear?: boolean;
  readonly disabled?: boolean;
  readonly onChange: (
    value: ResolvedDateTimeRangeValue | undefined,
    context: DateTimeRangeChangeContext,
  ) => void;
}
```

Contract details:

- `value` uses `from/to` to match `react-day-picker`'s range language. Logs maps those names to `startedAfter/completedBefore` at its boundary.
- `format` defaults to `yyyy-MM-dd HH:mm` and controls both editable absolute values and the collapsed absolute summary.
- `presetId` is intentionally separate from `value`. Two dates cannot retain the intent "past hour" after time advances.
- `presets` defaults to an empty list. The shared component does not own product-specific durations or copy.
- `allowClear` defaults to `false`.
- Invalid incoming date values produce an invalid draft state instead of crashing the page. Apply remains disabled until the draft is valid.
- An applied custom range has `value` without `presetId`. An applied relative range has both the currently resolved `value` and `presetId`. An empty/reset state has neither. This keeps the clear control and absolute draft available while preserving the rolling intent separately.

## Applied State and Draft State

The controlled props represent the applied filter. Each time the panel opens, the component creates a fresh draft from them.

- Calendar, preset, and time-field changes affect only the draft.
- Apply normalizes the draft, calls `onChange`, and closes the panel.
- Escape, outside click, and ordinary dismissal close the panel without changing the applied value.
- Reopening starts from the latest controlled props, so abandoned drafts never leak into a later session.
- When `presetId` is active, opening the panel resolves that preset using the current time so the displayed absolute endpoints are current.
- Consumers pass a currently resolved `value` alongside an active `presetId`; Apply returns a fresh resolved value plus the same preset ID. Logs may resolve it again later for polling without mutating the component contract.

The clear control is the sole exception. When `allowClear` is true and `value` is defined, the collapsed trigger shows a trailing clear button. It does not open the panel. Activating it immediately calls:

```ts
onChange(undefined, { presetId: undefined });
```

Consumers decide what `undefined` means. Logs interprets it as a reset to its existing default local day.

## Desktop Interaction

The collapsed control uses the existing Input/Button visual vocabulary:

- Calendar icon at the leading edge.
- Semantic summary in the middle.
- Accessible clear button at the trailing edge when allowed.
- Relative selections display their localized preset label, such as "Past hour".
- Custom selections display the formatted From/To range.

The desktop Popover follows the Cloudflare structure:

1. A single-month range calendar on the left.
2. A vertically scrollable preset list on the right.
3. From and To editable fields below the calendar/preset region.
4. A footer with Apply aligned to the right.

There is no separate Cancel button. Popover dismissal is cancellation.

### Calendar behavior

- The calendar uses range mode and shows one month.
- Selecting a complete date range clears `presetId`.
- The selected start date becomes `00:00:00.000` in the user's current time zone.
- The selected end date becomes `23:59:59.999` in the user's current time zone.
- The panel remains open so users can edit the resulting times.
- Future and historical selection limits come from `min/max`; the component does not hardcode Logs retention policy.

### Preset behavior

- Clicking a preset resolves it against the current time, highlights it, and updates the draft fields/calendar.
- It does not apply or close the panel.
- Editing either endpoint or choosing a calendar date clears the active preset.

### From and To fields

- Both fields use `format` for display and parsing.
- When the format omits seconds, a custom From value starts at second `00.000` and a custom To value ends at second `59.999`.
- The default format therefore retains inclusive minute semantics while a selected full day still ends at `23:59:59.999`.
- Manual edits are interpreted as wall-clock values in the user's current time zone until Apply converts them into absolute `Date` instances.

## User Time-Zone Behavior

The component always uses the browser's current time zone. It has no time-zone prop, selector, URL parameter, or alternate UTC mode.

- Calendar-day boundaries use local `Date` behavior.
- Manual values are parsed as local wall-clock values.
- Applied `Date` instances serialize to UTC ISO strings only at the Logs boundary.
- If the operating-system time zone changes while the dashboard is open, a reload establishes the new user time zone.

Daylight-saving behavior in the user's time zone remains explicit:

- A nonexistent spring-forward wall time is invalid. The field shows an inline error and Apply is disabled.
- For a repeated fall-back wall time, From selects the earlier offset and To selects the later offset so the requested closed range covers the full ambiguous interval.

## Validation

Apply is enabled only when all of the following are true:

- Both endpoints parse according to `format`.
- Both endpoints are valid dates.
- `from <= to` after local-time resolution.
- Both endpoints satisfy `min/max`.
- Neither endpoint falls in a nonexistent local DST interval.

Errors appear beside the relevant field using existing Field error patterns. Range-order errors identify both endpoints. The component never silently swaps endpoints, silently shifts a nonexistent time, or applies a partial range.

## Mobile Interaction

At the dashboard's mobile breakpoint, the same trigger opens the existing Sheet primitive from the bottom instead of trying to fit a desktop Popover into the viewport.

Sheet content is one scrollable column in this order:

1. Single-month calendar.
2. Preset list.
3. From and To fields.

Apply remains in a sticky Sheet footer. Dismissal and Escape discard the draft exactly as on desktop. No separate mobile state model or alternate value contract is introduced.

## Logs Integration

Logs is the only initial consumer. It passes localized presets for:

- 15 minutes
- 1 hour
- 3 hours
- 6 hours
- 12 hours
- 24 hours
- 3 days
- 7 days

Logs also passes its existing policy of no future dates and at most 45 days of custom history. The shared component remains unaware of why those bounds exist.

### URL representation

The Logs route supports two mutually exclusive applied forms:

1. Relative: `preset=<id>`. It omits `startedAfter/completedBefore`.
2. Custom: `startedAfter=<ISO>&completedBefore=<ISO>`. It omits `preset`.

If a malformed URL contains both forms, a valid `preset` wins and canonicalization removes the absolute pair. Unknown presets, invalid dates, or partial absolute ranges fall back to the existing default local current day.

Missing range parameters continue to mean the current local day. Route canonicalization may replace them with the resolved default ISO pair as it does today.

### Query resolution

- Custom ISO ranges are stable and pass through unchanged on every request.
- Relative presets are resolved with the current `now` for every polling request. A past-hour selection made at 11:00 therefore queries 10:05–11:05 when polling at 11:05.
- The existing Logs service still sends only `startedAfter/completedBefore` ISO strings to the server.
- The server and database keep their current inclusive comparisons.
- Clearing calls `onChange(undefined, ...)`; Logs removes the applied range, its existing default logic restores today, and the picker receives that normalized default on the next render.

## Accessibility and Internationalization

- All labels, preset copy, errors, clear-button names, and summaries come from i18n messages.
- The trigger, trailing clear button, calendar controls, presets, and Apply are keyboard reachable.
- The clear button stops trigger activation so clearing never opens the panel.
- Focus enters the panel predictably and returns to the trigger on dismissal.
- Errors are associated with their fields and announced through the existing Field primitives.
- Existing Calendar, Popover, Sheet, Input, Field, and Button components provide the visual and accessibility baseline.

## Testing

### Shared component tests

- Accept `string`, `number`, and `Date` endpoints; emit normalized `Date` endpoints.
- Render and parse the default and a custom `format`.
- Keep changes in draft until Apply.
- Discard drafts on Escape/outside dismissal.
- Resolve, highlight, and apply caller-provided presets.
- Clear immediately only when `allowClear` is enabled.
- Normalize calendar selections to full-day boundaries.
- Clear `presetId` after manual or calendar edits.
- Reject invalid, reversed, partial, out-of-bounds, and nonexistent DST ranges.
- Apply the earlier/later offset rule to repeated local times.
- Cover keyboard names and focus behavior for the trigger and clear control.

### Logs tests

- Preserve the local-current-day default.
- Reset to that default after a clear result.
- Parse, serialize, and canonicalize relative and custom URL forms.
- Give a valid relative preset precedence over conflicting absolute parameters.
- Re-resolve relative presets for each poll using the current time.
- Keep custom ISO ranges fixed across polls.
- Preserve the existing 45-day/future-date UI policy without adding server validation.

### Visual verification

- Verify the desktop Popover at normal and constrained widths.
- Verify the mobile Sheet without horizontal overflow or obscured Apply action.
- Exercise preset, calendar, manual time, clear, cancellation, and Apply flows against the running Logs page.
- Confirm no new browser console errors.

## Implementation Boundaries

- Reuse the existing dashboard primitives and `react-day-picker` wrapper.
- Keep preset definitions in the Logs module so the picker and polling resolver consume the same source of truth.
- Keep URL parsing and API conversion in the Logs module.
- Use native `Date` behavior for the user's current time zone; do not add time-zone infrastructure.
- Add no unrelated Logs, Usage, server, or database changes.

## Acceptance Criteria

- The Logs picker matches the confirmed Cloudflare-style interaction on desktop and mobile.
- Default and calendar-selected ranges use the user's current local day boundaries.
- Relative presets continue rolling across refreshes and polling.
- Custom ranges remain fixed absolute ISO ranges.
- `value` stays a plain `from/to` date-compatible range; rolling preset state remains separate.
- `allowClear` immediately returns `undefined`, and Logs restores its default today behavior.
- Invalid ranges cannot be applied.
- The implementation passes focused tests, repository preflight, and desktop/mobile browser QA.
