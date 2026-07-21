# Date-Time Range Picker Refactor Design

## Goal

Rebuild the dashboard's shared date-time range picker around clear ownership boundaries. Preserve its user-visible desktop, mobile, local-time, validation, preset, clear, and custom-trigger behavior while replacing the current component-internal structure and simplifying its public API.

## Scope

- Keep the picker as a dashboard-wide shared component.
- Migrate every repository caller to the revised API.
- Update the existing pull request for the picker; do not create a parallel implementation.
- Preserve the unrelated `bun.lock` modification and never stage it.
- Do not change shared `Calendar`, `Popover`, `Sheet`, `Button`, `Field`, or `Input` primitives.
- Add no dependency and no compound/headless public API.

## Problems in the Current Implementation

The current implementation has four competing responsibilities:

1. `date-time-range-picker.tsx` constructs default and custom triggers, clear behavior, responsive overlays, locale formatting, and panel lifecycle in one component.
2. `date-time-range-picker-panel.tsx` owns form setup, Zod parsing, error partitioning, calendar state, preset state, responsive styling, and all markup.
3. The form draft and a separate `selected` range duplicate the same selection and can drift apart after manual edits.
4. The public API accepts `string | number | Date`, then exposes a second resolved range type containing only `Date`; this pushes normalization complexity through every internal layer.

Responsive differences are also repeated as inline `mobile ? ... : ...` expressions, and validation runs `safeParse` during rendering to reconstruct errors already owned by TanStack Form.

## Public API

The public value and constraints use valid local `Date` objects only:

```ts
export interface DateTimeRange {
  readonly from: Date;
  readonly to: Date;
}

export interface DateTimeRangePreset {
  readonly id: string;
  readonly label: string;
  readonly resolve: (now: Date) => DateTimeRange;
}

export interface DateTimeRangePickerProps {
  readonly value: DateTimeRange | undefined;
  readonly presets?: readonly DateTimeRangePreset[];
  readonly pattern?: string;
  readonly min?: Date;
  readonly max?: Date;
  readonly disabled?: boolean;
  readonly trigger?: React.ReactElement;
  readonly allowClear?: boolean;
  readonly onChange: (value: DateTimeRange | undefined) => void;
}
```

Changes from the current API:

- Collapse `DateTimeRangeValue` and `ResolvedDateTimeRangeValue` into `DateTimeRange`.
- Remove `DateTimeInput` and accept `Date` for `value`, `min`, and `max`.
- Rename string `format` to `pattern` to match date-fns terminology.
- Rename `render` to `trigger`; it accepts the trigger element that Base UI enhances with trigger behavior.
- Keep `allowClear`; it affects only the default trigger. A custom trigger owns any custom clear affordance.

The picker must clone and validate received `Date` objects before internal use so an invalid or externally mutated `Date` does not corrupt draft state.

## Internal Architecture

```text
date-time-range-picker/
├── index.ts
├── date-time-range-picker.tsx
├── date-time-range-picker-panel.tsx
├── use-date-time-range-picker.ts
├── date-time-range.ts
├── date-time-range-picker.types.ts
├── date-time-range-picker.test.tsx
└── date-time-range.test.ts
```

### Public shell

`date-time-range-picker.tsx` owns only:

- open state;
- one locale resolution;
- default or custom trigger rendering;
- default-trigger clear behavior;
- mobile `Sheet` versus desktop `Popover` selection;
- closing after a successful Apply.

It passes normalized props and locale to the panel. The panel remains unmounted while closed, so reopening always initializes from the latest controlled `value`.

### Picker state model

`use-date-time-range-picker.ts` owns the complete editable interaction model:

- a TanStack Form draft with `{ from: string; to: string }`;
- the active preset ID;
- the derived calendar range;
- disabled calendar matchers;
- handlers for manual input, calendar selection, preset selection, and submission.

The form draft is the only editable range state. Calendar selection is parsed from the two draft endpoints instead of stored in a second `selected` state. Manual or calendar edits clear the active preset; choosing a preset updates both draft endpoints and its active ID.

The hook gives TanStack Form the Zod schema directly as both its mount and change validator. Mount validation keeps an initially empty or invalid draft from being submittable. Field UI reads `field.state.meta.errors`, form-level UI reads the form error map, and Apply subscribes to `canSubmit`. The panel does not call `safeParse` or filter Zod issues during render.

### Date-time model

`date-time-range.ts` is React-free and owns:

- cloning and validating dates;
- formatting values into draft strings;
- parsing individual local-time endpoints;
- constructing the Zod range schema;
- start/end-of-day conversion for Calendar selections;
- inclusive seconds and milliseconds when the display pattern omits them;
- daylight-saving overlap handling for the end boundary.

It receives locale, pattern, bounds, and translated messages as inputs. It does not import dashboard UI or resolve the current locale itself.

### Panel

`date-time-range-picker-panel.tsx` calls the state hook and renders the controls. It contains no date parsing, schema construction, issue filtering, or duplicate range state.

Responsive differences live in one local two-mode layout definition. JSX consumes named layout values rather than repeating conditional expressions. The definition covers panel size, section order, grid columns, preset button variant, Calendar sizing, field layout, and action alignment.

The two endpoints render from one typed endpoint descriptor list. This removes duplicated From/To field markup without adding another public abstraction.

## Data Flow

1. The controlled `value` is formatted in the user's current locale and time zone when the panel mounts.
2. Manual input changes only the corresponding draft string.
3. Calendar selection writes local start-of-day to `from` and local end-of-day to `to`.
4. A preset resolves once using a captured `new Date()` and writes its exact endpoints.
5. TanStack Form validates the draft and exposes field/form errors.
6. Apply submits only a valid parsed `DateTimeRange`, calls `onChange`, and closes the overlay.
7. The Logs adapter converts the resulting local `Date` objects to ISO strings only at the URL/query boundary.

## User-Visible Behavior

The refactor must preserve:

- desktop Calendar on the left and vertical presets on the right;
- desktop From/To row and right-aligned Apply footer;
- mobile rounded Sheet, two-column presets, full-width Calendar, stacked fields, and full-width sticky Apply;
- default trigger summary and optional clear button;
- custom trigger support without an automatic clear affordance;
- local user time zone display and parsing;
- `00:00:00.000` start and `23:59:59.999` end for Calendar-selected days;
- min/max blocking and validation;
- closing only after valid Apply;
- keyboard and Base UI trigger semantics inherited from shared primitives.

## Error Handling

- Invalid or incomplete input remains editable.
- Endpoint parse and bound failures appear on the corresponding field.
- Reversed ranges appear as a form-level error.
- Apply is disabled while the form cannot submit.
- Invalid external `Date` values produce empty draft endpoints instead of throwing.
- No callback fires for an invalid draft.

## Caller Migration

The Logs filter and date-range adapters migrate from `ResolvedDateTimeRangeValue` to `DateTimeRange`. Their query contract remains unchanged: dates become ISO strings in `toQueryRange`, and URL strings become `Date` objects in `toPickerRange`.

No log-specific defaults, presets, or URL semantics move into the shared component.

## Tests

### Pure model tests

Protect:

- date cloning and invalid-date rejection;
- formatting and strict local parsing;
- omitted seconds/milliseconds boundary completion;
- DST overlap end-boundary selection;
- start/end order;
- min/max constraints;
- Calendar start/end-of-day conversion.

### Component behavior tests

Protect:

- default and custom triggers;
- clear behavior and its custom-trigger exclusion;
- controlled value summary;
- manual input validation and successful Apply;
- Calendar and preset draft updates;
- overlay close semantics;
- desktop structure and mobile full-width structure.

Tests should assert public behavior and the small set of responsive classes that guard previously observed layout regressions. They should not mirror the internal hook shape or layout configuration object.

## Completion Criteria

- No duplicated selected range state remains.
- Locale is resolved once per picker.
- The panel performs no schema parsing or issue filtering during render.
- Public types expose only `DateTimeRange` and `DateTimeRangePreset`.
- Every repository caller compiles against the revised API.
- Existing picker behavior and responsive browser QA remain correct.
- Focused tests, dashboard unit tests, `bun run check`, dashboard build, and `git diff --check` pass.
