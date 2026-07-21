# Date-Time Range Picker Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared date-time range picker's tangled state and rendering implementation with a Date-only public API, a pure date model, one form-backed interaction hook, and focused shell/panel components.

**Architecture:** `date-time-range.ts` owns React-free local-time parsing, formatting, boundaries, and Zod validation. `use-date-time-range-picker.ts` owns the only editable draft plus preset state, while the panel renders it and the public shell owns locale, trigger, clear, and responsive overlay lifecycle.

**Tech Stack:** React 19, TypeScript, TanStack Form 1.33, Zod, date-fns, react-day-picker, Base UI, Tailwind CSS 4, Rstest, Testing Library, Bun.

## Global Constraints

- Work in `/Volumes/ExternalSSD/workspace/aio-proxy` on `codex/date-time-picker-responsive-layout`; update existing PR #59.
- Preserve the unrelated `bun.lock` modification and never stage it.
- Keep the picker dashboard-wide and migrate every repository caller to the revised API.
- Preserve desktop, mobile, local-time, validation, preset, clear, and custom-trigger behavior.
- Do not modify shared `Calendar`, `Popover`, `Sheet`, `Button`, `Field`, or `Input` primitives.
- Do not add dependencies, a Compound API, a logs-specific wrapper, or new i18n copy.
- Public values and bounds use `Date`; invalid external Dates become empty draft endpoints instead of throwing.
- The user's current local time zone remains the only display and parsing time zone; Logs converts to ISO only at the query boundary.
- Calendar date selection produces local `00:00:00.000` and `23:59:59.999` boundaries and preserves DST overlap behavior.
- Keep every handwritten code file below 300 lines and follow the dashboard one-component-per-TSX-file rule.
- Use TDD for each behavior change and commit each completed task with the Codex co-author footer.

---

## File Map

- Create `packages/dashboard/src/components/date-time-range-picker/date-time-range.ts` — pure Date cloning, draft formatting, local parsing, and schema construction.
- Create `packages/dashboard/src/components/date-time-range-picker/date-time-range.test.ts` — pure model regressions.
- Create `packages/dashboard/src/components/date-time-range-picker/use-date-time-range-picker.ts` — TanStack Form-backed interaction state.
- Modify `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.types.ts` — final public `DateTimeRange` and preset types only.
- Modify `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker-panel.tsx` — layout and control bindings only.
- Modify `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.tsx` — public shell, trigger, clear, and overlay lifecycle.
- Modify `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.test.tsx` — component behavior and responsive regressions.
- Modify `packages/dashboard/src/components/date-time-range-picker/index.ts` — final public exports.
- Modify `packages/dashboard/src/modules/logs/log-date-range/log-date-range.ts` — migrate to `DateTimeRange`.
- Modify `packages/dashboard/src/modules/logs/log-date-range/log-date-range.test.ts` — preserve query-boundary conversion.
- Delete `packages/dashboard/src/components/date-time-range-picker/date-time-range-value.ts` and `date-time-range-value.test.ts` after migration.

### Task 1: Replace the pure date-time model

**Files:**

- Create: `packages/dashboard/src/components/date-time-range-picker/date-time-range.ts`
- Create: `packages/dashboard/src/components/date-time-range-picker/date-time-range.test.ts`
- Modify: `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.types.ts`
- Keep temporarily: `packages/dashboard/src/components/date-time-range-picker/date-time-range-value.ts`

**Interfaces:**

- Produces `DateTimeRange { from: Date; to: Date }` and keeps the legacy range types temporarily so the current shell still compiles.
- Produces `cloneValidDate`, `formatDateTime`, `createDateTimeRangeDraft`, `parseDateTimeEndpoint`, and `createDateTimeRangeDraftSchema` for Task 2.
- `createDateTimeRangeDraftSchema` accepts `{ pattern, locale, min?, max?, messages }` and outputs `DateTimeRange`.

- [ ] **Step 1: Write the new model tests before the implementation**

Create `date-time-range.test.ts` by moving the meaningful old model cases to the new API. The first block must use Date-only inputs and protect cloning/invalid-Date behavior:

```ts
test("clones valid Dates and rejects invalid Dates", () => {
  const source = new Date(2026, 6, 20, 12, 30);
  expect(cloneValidDate(source)).not.toBe(source);
  expect(cloneValidDate(source)?.getTime()).toBe(source.getTime());
  expect(cloneValidDate(new Date(Number.NaN))).toBeUndefined();
});

test("turns invalid external endpoints into an empty draft", () => {
  expect(
    createDateTimeRangeDraft(
      { from: new Date(Number.NaN), to: new Date(2026, 6, 20, 23, 59, 59, 999) },
      "yyyy-MM-dd HH:mm",
      enUS,
    ),
  ).toEqual({ from: "", to: "2026-07-20 23:59" });
});
```

Retain tests for strict formatting, omitted seconds/milliseconds, malformed/reversed/bounded paths, and the `America/New_York` gap/overlap case. Add an endpoint parsing assertion because Task 2 derives Calendar selection from draft strings:

```ts
expect(parseDateTimeEndpoint("2026-07-20 12:34", "from", pattern, enUS)).toEqual(
  new Date(2026, 6, 20, 12, 34, 0, 0),
);
expect(parseDateTimeEndpoint("bad", "to", pattern, enUS)).toBeUndefined();
```

- [ ] **Step 2: Run the new model test and verify RED**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/components/date-time-range-picker/date-time-range.test.ts
```

Expected: FAIL because `date-time-range.ts`, `DateTimeRange`, and the new functions do not exist.

- [ ] **Step 3: Add the Date-only type and implement the pure model**

Add the new type without removing legacy types yet:

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
```

Move the old parser's tested boundary and DST logic into `date-time-range.ts`. Its public surface is:

```ts
export interface DateTimeRangeDraft {
  readonly from: string;
  readonly to: string;
}

export const cloneValidDate = (value: Date | undefined): Date | undefined;
export const formatDateTime = (value: Date | undefined, pattern: string, locale: Locale): string;
export const createDateTimeRangeDraft = (
  value: DateTimeRange | undefined,
  pattern: string,
  locale: Locale,
): DateTimeRangeDraft;
export const parseDateTimeEndpoint = (
  text: string,
  boundary: "from" | "to",
  pattern: string,
  locale: Locale,
): Date | undefined;
export const createDateTimeRangeDraftSchema = (
  options: DateTimeRangeDraftSchemaOptions,
): z.ZodType<DateTimeRange, DateTimeRangeDraft>;
```

Do not accept strings or numbers in the new module. Clone `min`, `max`, and value endpoints before using them. Keep `DAY_IN_MILLISECONDS` and the existing repeated-hour correction exactly where tests require it.

- [ ] **Step 4: Run model tests GREEN and confirm legacy tests remain GREEN**

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- \
  src/components/date-time-range-picker/date-time-range.test.ts \
  src/components/date-time-range-picker/date-time-range-value.test.ts
```

Expected: both files PASS, including the time-zone-conditional test.

- [ ] **Step 5: Check and commit Task 1**

```bash
rtk bun run check
rtk git diff --check
rtk git add \
  packages/dashboard/src/components/date-time-range-picker/date-time-range.ts \
  packages/dashboard/src/components/date-time-range-picker/date-time-range.test.ts \
  packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.types.ts
rtk proxy git -c commit.gpgsign=false commit \
  -m "refactor(dashboard): isolate date range model" \
  -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Replace panel state with one form-backed controller

**Files:**

- Create: `packages/dashboard/src/components/date-time-range-picker/use-date-time-range-picker.ts`
- Modify: `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker-panel.tsx`
- Modify: `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.tsx`
- Modify: `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.test.tsx`

**Interfaces:**

- Consumes the Task 1 `DateTimeRange`, draft helpers, endpoint parser, and schema.
- Produces `useDateTimeRangePicker(options)` returning `form`, `selected`, `disabledDates`, `activePresetId`, `selectRange`, `selectPreset`, and `clearActivePreset`.
- The panel accepts `value?: DateTimeRange`, `pattern`, `locale`, `min?: Date`, `max?: Date`, `presets`, `mobile`, and `onApply`.
- The public shell keeps its old prop names and legacy input normalization only until Task 3, but resolves locale once and passes it into the panel.

- [ ] **Step 1: Add a failing canonical-draft component test**

Add a test proving manual draft edits update Calendar selection rather than leaving the old selection state behind:

```tsx
test("derives Calendar selection from manual draft edits", async () => {
  render(<DateTimeRangePicker value={value} onChange={rs.fn()} />);
  openPicker();
  fireEvent.change(await screen.findByLabelText(/Start|开始时间/u), {
    target: { value: "2026-07-21 00:00" },
  });
  fireEvent.change(screen.getByLabelText(/End|结束时间/u), {
    target: { value: "2026-07-21 23:59" },
  });

  expect(
    within(screen.getByTestId("date-time-range-calendar")).getByRole("button", {
      name: /Tuesday, July 21st, 2026/u,
    }),
  ).toHaveAttribute("data-range-start", "true");
});
```

- [ ] **Step 2: Run the focused component test and verify RED**

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/components/date-time-range-picker/date-time-range-picker.test.tsx
```

Expected: the new test FAILS because the current Calendar still reads the separate `selected` state initialized from the original value.

- [ ] **Step 3: Implement the form-backed interaction hook**

`use-date-time-range-picker.ts` must:

```ts
const form = useForm({
  defaultValues: createDateTimeRangeDraft(value, pattern, locale),
  validators: { onMount: schema, onChange: schema },
  onSubmit: ({ value: draft }) => {
    const parsed = schema.safeParse(draft);
    if (parsed.success) onApply(parsed.data);
  },
});

const draft = useStore(form.store, (state) => state.values);
const selected = {
  from: parseDateTimeEndpoint(draft.from, "from", pattern, locale),
  to: parseDateTimeEndpoint(draft.to, "to", pattern, locale),
};
```

Return `selected` as `undefined` when neither endpoint parses, and omit `to` when only the start parses. `selectRange` writes `startOfDay`/`endOfDay` through `formatDateTime`; `selectPreset` resolves exactly once, clones its endpoints into the draft, and records the preset ID. Manual edits and Calendar edits clear that ID. Build min/max `Matcher[]` from cloned valid Dates.

- [ ] **Step 4: Refactor the panel into bindings plus one layout definition**

Remove locale resolution, schema creation, `selected` state, issue filtering, and parsing from the panel. Define one local `LAYOUT` map with `mobile` and `desktop` entries covering panel, primary, calendar wrapper/class, presets, preset variant/class, fields, range error, actions, and Apply classes.

Render endpoints from one descriptor list:

```ts
const endpoints = [
  { name: "from", id: "date-time-range-from", label: m["dashboard.date_time_range_picker.start"]() },
  { name: "to", id: "date-time-range-to", label: m["dashboard.date_time_range_picker.end"]() },
] as const;
```

Each `<form.Field>` reads `field.state.meta.errors`; the form-level `FieldError` reads the active mount/change error-map entry. Apply uses a narrow subscription:

```tsx
<form.Subscribe selector={(state) => state.canSubmit}>
  {(canSubmit) => <Button type="submit" disabled={!canSubmit}>...</Button>}
</form.Subscribe>
```

Delete the redundant Calendar `classNames={{ root: "w-full" }}` override; retain the mobile `className="w-full p-0"` regression behavior.

- [ ] **Step 5: Resolve locale once in the shell and adapt its legacy value internally**

Keep Task 2 source-compatible with the current public API. Resolve locale only in the shell, normalize its legacy value/min/max once, and pass Date-only values to the panel. Do not yet rename `render`, `format`, or exported types; Task 3 removes this compatibility boundary.

- [ ] **Step 6: Run focused tests GREEN and commit Task 2**

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/components/date-time-range-picker/date-time-range-picker.test.tsx
rtk bun run check
rtk git diff --check
rtk git add \
  packages/dashboard/src/components/date-time-range-picker/use-date-time-range-picker.ts \
  packages/dashboard/src/components/date-time-range-picker/date-time-range-picker-panel.tsx \
  packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.tsx \
  packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.test.tsx
rtk proxy git -c commit.gpgsign=false commit \
  -m "refactor(dashboard): centralize date picker state" \
  -m "Co-authored-by: Codex <noreply@openai.com>"
```

Expected: all picker tests PASS; the panel and hook are each below 300 lines; no new lint errors.

### Task 3: Publish the revised API and remove the legacy implementation

**Files:**

- Modify: `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.tsx`
- Modify: `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.types.ts`
- Modify: `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.test.tsx`
- Modify: `packages/dashboard/src/components/date-time-range-picker/index.ts`
- Modify: `packages/dashboard/src/modules/logs/log-date-range/log-date-range.ts`
- Modify: `packages/dashboard/src/modules/logs/log-date-range/log-date-range.test.ts`
- Delete: `packages/dashboard/src/components/date-time-range-picker/date-time-range-value.ts`
- Delete: `packages/dashboard/src/components/date-time-range-picker/date-time-range-value.test.ts`

**Interfaces:**

- Public `DateTimeRangePickerProps`: `value: DateTimeRange | undefined`, `presets?`, `pattern?`, `min?: Date`, `max?: Date`, `disabled?`, `trigger?: React.ReactElement`, `allowClear?`, and `onChange`.
- Public exports: `DateTimeRangePicker`, `DateTimeRangePickerProps`, `DateTimeRange`, and `DateTimeRangePreset` only.
- Logs adapters consume and produce `DateTimeRange`; their `QueryRange` output is unchanged.

- [ ] **Step 1: Change component tests to the revised trigger contract and verify RED**

Replace the Base UI `render` element test with:

```tsx
test("uses a custom trigger and leaves clear ownership to it", () => {
  render(
    <DateTimeRangePicker
      value={value}
      trigger={<button type="button">Custom range</button>}
      allowClear
      onChange={rs.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: /Clear time range|清除时间范围/u })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Custom range" }));
  expect(screen.getByRole("button", { name: /Apply|应用/u })).toBeTruthy();
});
```

Delete the callback-render test because the revised API intentionally accepts an element only. Add an invalid-Date test:

```tsx
test("opens with empty fields for invalid external Dates", async () => {
  render(
    <DateTimeRangePicker
      value={{ from: new Date(Number.NaN), to: new Date(Number.NaN) }}
      onChange={rs.fn()}
    />,
  );
  openPicker();
  expect(await screen.findByLabelText(/Start|开始时间/u)).toHaveValue("");
  expect(screen.getByLabelText(/End|结束时间/u)).toHaveValue("");
  expect(screen.getByRole("button", { name: /Apply|应用/u })).toBeDisabled();
});
```

Run the focused test; expected RED because `trigger` is not yet a prop and invalid values still pass through the legacy API.

- [ ] **Step 2: Replace the public shell API**

Export `DateTimeRangePickerProps`, use `pattern = "yyyy-MM-dd HH:mm"`, accept Date-only bounds/value, and use `trigger` instead of `render`. Always pass `disabled` to `PopoverTrigger`/`SheetTrigger`; Base UI merges it into either the default or custom element. Default-trigger children remain Calendar icon plus formatted summary. Automatic clear remains gated by `trigger === undefined && allowClear`.

- [ ] **Step 3: Remove legacy types/files and migrate public exports**

Reduce `date-time-range-picker.types.ts` to `DateTimeRange` and `DateTimeRangePreset`. Update `index.ts`:

```ts
export { DateTimeRangePicker } from "./date-time-range-picker";
export type { DateTimeRangePickerProps } from "./date-time-range-picker";
export type { DateTimeRange, DateTimeRangePreset } from "./date-time-range-picker.types";
```

Delete `date-time-range-value.ts` and its old test. Confirm no source references remain:

```bash
rtk rg "DateTimeInput|DateTimeRangeValue|ResolvedDateTimeRangeValue|date-time-range-value|\brender=" \
  packages/dashboard/src/components/date-time-range-picker packages/dashboard/src/modules/logs
```

Expected: no matches.

- [ ] **Step 4: Migrate Logs adapters and verify their boundary behavior**

Use `DateTimeRange` in `log-date-range.ts` without changing conversion logic. Keep or add assertions that `toPickerRange` returns local `Date` instances representing the ISO instants and `toQueryRange` returns the same `.toISOString()` strings.

- [ ] **Step 5: Run all verification**

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/components/date-time-range-picker
rtk bun run --filter @aio-proxy/dashboard test:unit
rtk bun run check
rtk bun run --filter @aio-proxy/dashboard build
rtk git diff --check
```

Expected: 0 failed tests and every command exits `0`; only existing max-lines warnings may remain.

- [ ] **Step 6: Perform desktop and mobile browser QA**

Reuse the current dev server; do not start another watcher.

- Desktop 1280×720: compact 512px Popover, Calendar left, vertical presets right, two-column fields, Apply bottom-right, no overflow.
- Mobile 390×844: rounded full-width Sheet, two preset columns, seven equal Calendar columns, stacked full-width fields, full-width sticky Apply, no horizontal overflow.
- Verify default clear, custom trigger, preset, manual edit, invalid error, Apply close, and cancel/discard behavior.
- Verify browser console has no errors and reset any temporary viewport override.

- [ ] **Step 7: Commit Task 3 and push PR #59**

```bash
rtk git add \
  packages/dashboard/src/components/date-time-range-picker \
  packages/dashboard/src/modules/logs/log-date-range/log-date-range.ts \
  packages/dashboard/src/modules/logs/log-date-range/log-date-range.test.ts
rtk proxy git -c commit.gpgsign=false commit \
  -m "refactor(dashboard): simplify date picker API" \
  -m "Co-authored-by: Codex <noreply@openai.com>"
rtk git push
```

Before committing, confirm `bun.lock` is unstaged with `rtk git status --short`.
