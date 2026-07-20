# Dashboard Date-Time Range Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable, Cloudflare-style date-time range picker and replace the request Logs page's date-only picker with it.

**Architecture:** A shared `date-time-range-picker` directory owns the public React component, its panel, and pure local-time parsing/validation helpers. The component is controlled by a plain `{ from, to }` value, keeps edits in a TanStack Form draft until Apply, uses a Popover on desktop and a bottom Sheet on mobile, and accepts Base UI's `render` prop for trigger replacement. Logs supplies fixed relative presets and maps applied `Date` values to its existing absolute ISO URL/API fields.

**Tech Stack:** React 19, TypeScript, Base UI 1.6, shadcn dashboard primitives, TanStack Form 1.33, Zod 4, date-fns 4, react-day-picker 10, Rstest, Testing Library, Bun.

## Global Constraints

- Work from `/Volumes/ExternalSSD/workspace/aio-proxy`; prefix every shell command with `rtk`.
- Read `packages/dashboard/AGENTS.md` before implementation; do not edit generated `src/route-tree.gen.ts`.
- Do not modify files in `packages/dashboard/src/components/ui`; reuse Calendar, Popover, Sheet, Input, Field, and Button.
- Every editable input must use TanStack Form, with Zod as the validation source.
- All user-facing copy must come from `packages/i18n/messages/en.json` and `zh-Hans.json`; run `rtk bun run i18n:compile` after message changes.
- Use the browser's current time zone only. Do not add a time-zone prop, selector, URL field, or dependency.
- `value` is `{ from, to }`; each input accepts `string | number | Date`, and `onChange` emits normalized `Date` values or `undefined`.
- Presets resolve once when selected. Applied ranges remain fixed across refresh and polling; do not add `presetId` state or URL parameters.
- `render` follows Base UI's element/callback render contract. When `render` is supplied, `allowClear` is ignored.
- Default selected dates normalize to local `00:00:00.000` and `23:59:59.999`; manual values preserve their entered times.
- Handwritten source and test files must remain below 300 lines. Use export-only `index.ts` files for new public directories.
- Add no dependencies. Preserve unrelated dirty-worktree changes.
- Follow TDD: add a behavior-level failing test, verify the expected failure, implement the smallest fix, then rerun.

---

## File Map

### New shared component

- `packages/dashboard/src/components/date-time-range-picker/index.ts` — export-only public entry point.
- `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.types.ts` — public Date input, value, preset, and draft types.
- `packages/dashboard/src/components/date-time-range-picker/date-time-range-value.ts` — private normalization, formatting, local wall-time parsing, DST disambiguation, and Zod schema construction.
- `packages/dashboard/src/components/date-time-range-picker/date-time-range-value.test.ts` — pure behavior and DST regression tests.
- `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker-panel.tsx` — one React component containing the calendar, presets, TanStack Form fields, validation, and Apply action.
- `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.tsx` — one React component owning applied/draft opening lifecycle, default/custom trigger, desktop Popover, mobile Sheet, and clear behavior.
- `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.test.tsx` — desktop, render-prop, clear, draft, and mobile interaction tests.

### Logs integration

- `packages/dashboard/src/modules/logs/log-date-range/index.ts` — export-only replacement for the current flat module.
- `packages/dashboard/src/modules/logs/log-date-range/log-date-range.ts` — exact Date/ISO mapping.
- `packages/dashboard/src/modules/logs/log-date-range/log-date-range-presets.ts` — Logs-specific fixed preset definitions.
- `packages/dashboard/src/modules/logs/log-date-range/log-date-range.test.ts` — exact-time conversion tests.
- `packages/dashboard/src/modules/logs/log-date-range/log-date-range-presets.test.ts` — preset-resolution tests.
- `packages/dashboard/src/modules/logs/components/logs-filters.tsx` — use the shared picker and preserve non-date filters on Apply/clear.
- `packages/dashboard/src/modules/logs/templates/logs-page/logs-page.test.tsx` — protect the integrated Logs behavior.
- Delete `packages/dashboard/src/modules/logs/log-date-range.ts` after moving its public contract into the directory.
- Delete `packages/dashboard/src/modules/logs/log-date-range.test.ts` after moving and updating its tests.
- Delete `packages/dashboard/src/modules/logs/components/logs-date-range-picker.tsx`; the shared component replaces it.

### Copy

- `packages/i18n/messages/en.json` — shared picker labels/errors and missing Logs preset labels.
- `packages/i18n/messages/zh-Hans.json` — Chinese equivalents.

---

### Task 1: Local date-time value model and validation

**Files:**

- Create: `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.types.ts`
- Create: `packages/dashboard/src/components/date-time-range-picker/date-time-range-value.ts`
- Create: `packages/dashboard/src/components/date-time-range-picker/date-time-range-value.test.ts`

**Interfaces:**

- Produces `DateTimeInput`, `DateTimeRangeValue`, `ResolvedDateTimeRangeValue`, `DateTimeRangePreset`, and `DateTimeRangeDraft`.
- Produces `normalizeDateTimeInput`, `formatDateTimeInput`, `createDateTimeRangeDraft`, and `createDateTimeRangeDraftSchema` for Task 2.
- The schema output is `{ from: Date; to: Date }`; the schema paths are `from`, `to`, or the object root for range-order errors.

- [ ] **Step 1: Write failing normalization, boundary, validation, and DST tests**

Create `date-time-range-value.test.ts` with behavior-level cases equivalent to:

```ts
import { describe, expect, test } from "@rstest/core";
import { enUS } from "date-fns/locale";

import {
  createDateTimeRangeDraft,
  createDateTimeRangeDraftSchema,
  normalizeDateTimeInput,
} from "./date-time-range-value";

const messages = {
  invalid: "Invalid date and time",
  order: "Start must not be after end",
  beforeMin: "Before minimum",
  afterMax: "After maximum",
};

describe("date time range values", () => {
  test("normalizes Date-compatible inputs without sharing mutable Dates", () => {
    const source = new Date(2026, 6, 20, 12, 30);
    expect(normalizeDateTimeInput(source)).not.toBe(source);
    expect(normalizeDateTimeInput(source)?.getTime()).toBe(source.getTime());
    expect(normalizeDateTimeInput(source.getTime())?.getTime()).toBe(source.getTime());
    expect(normalizeDateTimeInput(source.toISOString())?.getTime()).toBe(source.getTime());
    expect(normalizeDateTimeInput("invalid")).toBeUndefined();
  });

  test("formats a complete incoming value into an editable draft", () => {
    expect(
      createDateTimeRangeDraft(
        { from: new Date(2026, 6, 20, 0, 0), to: new Date(2026, 6, 21, 23, 59, 59, 999) },
        "yyyy-MM-dd HH:mm",
        enUS,
      ),
    ).toEqual({ from: "2026-07-20 00:00", to: "2026-07-21 23:59" });
  });

  test("fills omitted seconds with inclusive start and end boundaries", () => {
    const schema = createDateTimeRangeDraftSchema({
      pattern: "yyyy-MM-dd HH:mm",
      locale: enUS,
      messages,
    });
    const parsed = schema.parse({ from: "2026-07-20 12:34", to: "2026-07-20 13:45" });
    expect([parsed.from.getSeconds(), parsed.from.getMilliseconds()]).toEqual([0, 0]);
    expect([parsed.to.getSeconds(), parsed.to.getMilliseconds()]).toEqual([59, 999]);
  });

  test("rejects malformed, reversed, and out-of-bounds drafts", () => {
    const schema = createDateTimeRangeDraftSchema({
      pattern: "yyyy-MM-dd HH:mm",
      locale: enUS,
      min: new Date(2026, 6, 1),
      max: new Date(2026, 6, 31, 23, 59, 59, 999),
      messages,
    });
    expect(schema.safeParse({ from: "bad", to: "2026-07-20 12:00" }).success).toBe(false);
    expect(schema.safeParse({ from: "2026-07-21 12:00", to: "2026-07-20 12:00" }).success).toBe(false);
    expect(schema.safeParse({ from: "2026-06-30 23:59", to: "2026-07-20 12:00" }).success).toBe(false);
    expect(schema.safeParse({ from: "2026-07-20 12:00", to: "2026-08-01 00:00" }).success).toBe(false);
  });
});
```

Add this DST block so the normal suite skips environment-specific assertions while the explicit New York command executes them:

```ts
const testInNewYork =
  Intl.DateTimeFormat().resolvedOptions().timeZone === "America/New_York" ? test : test.skip;

testInNewYork("rejects gaps and expands repeated local end times", () => {
  const schema = createDateTimeRangeDraftSchema({
    pattern: "yyyy-MM-dd HH:mm",
    locale: enUS,
    messages,
  });
  expect(schema.safeParse({ from: "2026-03-08 02:30", to: "2026-03-08 03:30" }).success).toBe(false);
  const overlap = schema.parse({ from: "2026-11-01 01:30", to: "2026-11-01 01:30" });
  expect(overlap.to.getTime() - overlap.from.getTime()).toBe(60 * 60 * 1_000);
});
```

- [ ] **Step 2: Run the focused test and verify the red state**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/components/date-time-range-picker/date-time-range-value.test.ts
```

Expected: FAIL because the three new modules do not exist.

- [ ] **Step 3: Implement the public value types and local-time helpers**

Define the public types exactly:

```ts
export type DateTimeInput = string | number | Date;

export interface DateTimeRangeValue {
  readonly from: DateTimeInput;
  readonly to: DateTimeInput;
}

export interface ResolvedDateTimeRangeValue {
  readonly from: Date;
  readonly to: Date;
}

export interface DateTimeRangePreset {
  readonly id: string;
  readonly label: string;
  readonly resolve: (now: Date) => ResolvedDateTimeRangeValue;
}

export interface DateTimeRangeDraft {
  readonly from: string;
  readonly to: string;
}
```

Implement `date-time-range-value.ts` with date-fns `format`, `parse`, and `isValid`, plus Zod:

```ts
export const normalizeDateTimeInput = (value: DateTimeInput | undefined): Date | undefined => {
  if (value === undefined) return undefined;
  const date = new Date(value instanceof Date ? value.getTime() : value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};
```

Use a fixed local reference date with `00.000` for From and `59.999` for To. After `parse`, require `format(parsed, pattern, { locale }) === text`; that round trip rejects impossible spring-forward wall times and invalid calendar dates. For To values, detect a fall-back overlap by comparing the same local wall time on the following day with 24 hours; add a positive overlap only when the formatted candidate still equals the original text. Build endpoint transforms with Zod and add custom issues for invalid, order, min, and max failures.

- [ ] **Step 4: Run normal and DST-focused tests**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/components/date-time-range-picker/date-time-range-value.test.ts
rtk proxy env TZ=America/New_York bun run --filter @aio-proxy/dashboard test:unit -- src/components/date-time-range-picker/date-time-range-value.test.ts
```

Expected: both commands PASS; the second command executes the DST assertions instead of skipping them.

- [ ] **Step 5: Commit Task 1**

```bash
rtk git add packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.types.ts packages/dashboard/src/components/date-time-range-picker/date-time-range-value.ts packages/dashboard/src/components/date-time-range-picker/date-time-range-value.test.ts
rtk proxy git -c commit.gpgsign=false commit -m "feat(dashboard): add date time range value model" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Desktop picker, draft form, presets, and Apply

**Files:**

- Create: `packages/dashboard/src/components/date-time-range-picker/index.ts`
- Create: `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker-panel.tsx`
- Create: `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.tsx`
- Create: `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.test.tsx`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`

**Interfaces:**

- Consumes Task 1's types and parsing schema.
- Produces `DateTimeRangePicker` with `value`, `presets`, `format`, `min`, `max`, `allowClear`, `disabled`, `render`, and `onChange` props.
- Task 2 implements the default desktop trigger first. Tasks 3 and 4 add trigger replacement/clear and mobile Sheet behavior without changing the value contract.

- [ ] **Step 1: Add failing desktop interaction tests**

Cover these behaviors in `date-time-range-picker.test.tsx`:

```ts
test("keeps calendar and time edits in draft until Apply", async () => {
  const onChange = rs.fn();
  render(
    <DateTimeRangePicker
      value={{ from: new Date(2026, 6, 20, 0, 0), to: new Date(2026, 6, 20, 23, 59, 59, 999) }}
      onChange={onChange}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /Time range|时间范围/u }));
  fireEvent.change(await screen.findByLabelText(/Start|开始时间/u), { target: { value: "2026-07-20 08:15" } });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Apply|应用/u }));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange.mock.calls[0]?.[0].from).toEqual(new Date(2026, 6, 20, 8, 15, 0, 0));
});

test("resolves a preset once and waits for Apply", async () => {
  const onChange = rs.fn();
  const now = new Date(2026, 6, 20, 12, 0);
  render(
    <DateTimeRangePicker
      value={{ from: now, to: now }}
      presets={[{ id: "1h", label: "Past hour", resolve: () => ({ from: new Date(2026, 6, 20, 11, 0), to: now }) }]}
      onChange={onChange}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /Time range|时间范围/u }));
  fireEvent.click(await screen.findByRole("button", { name: "Past hour" }));
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Apply|应用/u }));
  expect(onChange.mock.calls[0]?.[0].from).toEqual(new Date(2026, 6, 20, 11, 0));
});

test("disables Apply for invalid or reversed text", async () => {
  render(
    <DateTimeRangePicker
      value={{ from: new Date(2026, 6, 20, 0, 0), to: new Date(2026, 6, 20, 23, 59) }}
      onChange={rs.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Time range|时间范围/u }));
  fireEvent.change(await screen.findByLabelText(/Start|开始时间/u), { target: { value: "bad" } });
  expect(screen.getByRole("button", { name: /Apply|应用/u })).toBeDisabled();
  expect(screen.getByRole("alert")).toBeTruthy();
});
```

Also test that closing the Popover without Apply leaves `onChange` untouched, the Calendar renders one month, and a completed calendar selection writes local full-day boundaries into the two text fields.

- [ ] **Step 2: Run the component test and verify it fails**

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/components/date-time-range-picker/date-time-range-picker.test.tsx
```

Expected: FAIL because `DateTimeRangePicker` and its panel do not exist.

- [ ] **Step 3: Add shared i18n copy and compile it**

Add this `dashboard.date_time_range_picker` object to `en.json`:

```json
{
  "title": "Time range",
  "start": "Start",
  "end": "End",
  "apply": "Apply",
  "clear": "Clear time range",
  "invalid": "Enter a valid date and time",
  "order": "Start must not be after end",
  "before_min": "Start is before the allowed range",
  "after_max": "End is after the allowed range"
}
```

Add the matching object to `zh-Hans.json`:

```json
{
  "title": "时间范围",
  "start": "开始时间",
  "end": "结束时间",
  "apply": "应用",
  "clear": "清除时间范围",
  "invalid": "请输入有效的日期和时间",
  "order": "开始时间不能晚于结束时间",
  "before_min": "开始时间早于允许范围",
  "after_max": "结束时间晚于允许范围"
}
```

Do not place Logs-specific preset labels in this shared object.

```bash
rtk bun run i18n:compile
```

Expected: Paraglide compilation completes successfully.

- [ ] **Step 4: Implement the panel with TanStack Form and Zod**

`DateTimeRangePickerPanel` is the only component in its file. Its props are:

```ts
interface DateTimeRangePickerPanelProps {
  readonly value: DateTimeRangeValue | undefined;
  readonly presets: readonly DateTimeRangePreset[];
  readonly pattern: string;
  readonly min: DateTimeInput | undefined;
  readonly max: DateTimeInput | undefined;
  readonly mobile: boolean;
  readonly onApply: (value: ResolvedDateTimeRangeValue) => void;
}
```

Use `useForm` with `{ from: string; to: string }` defaults from `createDateTimeRangeDraft`. Use the Task 1 Zod schema as `validators.onChange`, and call `schema.safeParse` in `onSubmit` before `onApply`. Render:

- `Calendar mode="range"`, `numberOfMonths={1}`, `excludeDisabled`, `defaultMonth={normalizedFrom}`, and disabled matchers derived from `min/max`.
- Caller presets as plain Buttons with `aria-pressed` only during the current draft session.
- Two `<form.Field>` blocks using shared Field, FieldLabel, Input, and FieldError components.
- Apply as the only footer action, disabled when the schema rejects the current draft.

Calendar selection must format `startOfDay(range.from)` and `endOfDay(range.to)` into the draft; a partial range clears the To text. Preset and calendar changes call `form.setFieldValue`; manual field changes clear only the transient preset highlight.

- [ ] **Step 5: Implement the desktop root and export-only index**

The desktop root owns `open`, formats the collapsed absolute summary, renders the default outline Button through `PopoverTrigger`, and calls `onChange` only from panel Apply. Use the default pattern `yyyy-MM-dd HH:mm`. Do not add clear or custom render behavior yet. Define its initial props exactly as:

```ts
interface DateTimeRangePickerProps {
  readonly value: DateTimeRangeValue | undefined;
  readonly presets?: readonly DateTimeRangePreset[];
  readonly format?: string;
  readonly min?: DateTimeInput;
  readonly max?: DateTimeInput;
  readonly disabled?: boolean;
  readonly onChange: (value: ResolvedDateTimeRangeValue | undefined) => void;
}
```

`index.ts` contains exports only:

```ts
export { DateTimeRangePicker } from "./date-time-range-picker";
export type {
  DateTimeInput,
  DateTimeRangePreset,
  DateTimeRangeValue,
  ResolvedDateTimeRangeValue,
} from "./date-time-range-picker.types";
```

- [ ] **Step 6: Run focused tests and package type/build validation**

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/components/date-time-range-picker/date-time-range-value.test.ts src/components/date-time-range-picker/date-time-range-picker.test.tsx
rtk bun run --filter @aio-proxy/dashboard build
```

Expected: focused tests PASS and the dashboard build exits 0.

- [ ] **Step 7: Commit Task 2**

```bash
rtk git add packages/dashboard/src/components/date-time-range-picker packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json
rtk proxy git -c commit.gpgsign=false commit -m "feat(dashboard): add desktop date time range picker" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Custom trigger rendering and default-trigger clear

**Files:**

- Modify: `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.tsx`
- Modify: `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.test.tsx`

**Interfaces:**

- Adds `render?: React.ComponentProps<typeof PopoverTrigger>["render"]`.
- Adds `allowClear?: boolean`, defaulting to false.
- With the default trigger, clear calls `onChange(undefined)` immediately and does not open the panel.
- With custom `render`, built-in clear is never rendered and `allowClear` has no effect.

- [ ] **Step 1: Add failing render and clear tests**

```ts
test("clears immediately from the default trigger without opening", () => {
  const onChange = rs.fn();
  render(
    <DateTimeRangePicker
      value={{ from: new Date(2026, 6, 20), to: new Date(2026, 6, 21) }}
      allowClear
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Clear time range|清除时间范围/u }));
  expect(onChange).toHaveBeenCalledWith(undefined);
  expect(screen.queryByRole("button", { name: /Apply|应用/u })).toBeNull();
});

test("uses Base UI element render and ignores allowClear", () => {
  render(
    <DateTimeRangePicker
      value={{ from: new Date(2026, 6, 20), to: new Date(2026, 6, 21) }}
      render={<button type="button">Custom range</button>}
      allowClear
      onChange={rs.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: /Clear time range|清除时间范围/u })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Custom range" }));
  expect(screen.getByRole("button", { name: /Apply|应用/u })).toBeTruthy();
});

test("passes open state and merged props to callback render", () => {
  render(
    <DateTimeRangePicker
      value={{ from: new Date(2026, 6, 20), to: new Date(2026, 6, 21) }}
      render={(props, state) => (
        <button {...props} type="button" data-picker-open={state.open ? "yes" : "no"}>
          Callback range
        </button>
      )}
      onChange={rs.fn()}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Callback range" });
  expect(trigger).toHaveAttribute("data-picker-open", "no");
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("data-picker-open", "yes");
});
```

- [ ] **Step 2: Run the focused test and verify the missing behavior**

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/components/date-time-range-picker/date-time-range-picker.test.tsx
```

Expected: FAIL because `render` and `allowClear` are not implemented.

- [ ] **Step 3: Implement trigger composition**

Pass `render` directly to `PopoverTrigger`. When it is undefined, render the existing input-style Button. Only the default branch may render a separate trailing clear Button; keep it outside the trigger to avoid nested interactive controls. Stop propagation on clear and call `onChange(undefined)` without changing `open`. When `render` is defined, do not render the clear Button.

- [ ] **Step 4: Run tests and commit Task 3**

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/components/date-time-range-picker/date-time-range-picker.test.tsx
rtk git add packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.tsx packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.test.tsx
rtk proxy git -c commit.gpgsign=false commit -m "feat(dashboard): support custom date picker triggers" -m "Co-authored-by: Codex <noreply@openai.com>"
```

Expected: tests PASS before the commit.

---

### Task 4: Mobile bottom Sheet

**Files:**

- Modify: `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.tsx`
- Modify: `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker-panel.tsx`
- Modify: `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.test.tsx`

**Interfaces:**

- Consumes `useIsMobile` and the existing Sheet primitives.
- Keeps one controlled `open` value and one panel contract across Popover and Sheet.
- Preserves the exact same `render` and `allowClear` rules on both breakpoints.

- [ ] **Step 1: Add a failing mobile Sheet test**

Hoist a mutable `mobile` flag and mock `@/hooks/use-mobile`. Assert that mobile uses a dialog with one calendar, one preset list, From/To fields, and a footer Apply button; assert that desktop still uses the Popover path.

```ts
const viewport = rs.hoisted(() => ({ mobile: false }));

rs.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => viewport.mobile,
}));

test("uses a bottom Sheet on mobile", async () => {
  viewport.mobile = true;
  render(
    <DateTimeRangePicker
      value={{ from: new Date(2026, 6, 20), to: new Date(2026, 6, 21) }}
      onChange={rs.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Time range|时间范围/u }));
  expect(await screen.findByRole("dialog")).toHaveAttribute("data-side", "bottom");
  expect(screen.getByRole("button", { name: /Apply|应用/u })).toBeTruthy();
  viewport.mobile = false;
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/components/date-time-range-picker/date-time-range-picker.test.tsx
```

Expected: FAIL because the component always renders a Popover.

- [ ] **Step 3: Implement the responsive branch**

Use `useIsMobile()`. Desktop renders Popover/PopoverTrigger/PopoverContent. Mobile renders Sheet/SheetTrigger/SheetContent with `side="bottom"`, an accessible SheetTitle, a scrollable body, and the same `DateTimeRangePickerPanel` with `mobile={true}`. Keep Apply in a sticky panel footer. The two Base UI trigger primitives share the element/callback render contract; type the public prop from `PopoverTrigger` and pass it to the active branch only.

- [ ] **Step 4: Run tests and commit Task 4**

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/components/date-time-range-picker/date-time-range-picker.test.tsx
rtk git add packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.tsx packages/dashboard/src/components/date-time-range-picker/date-time-range-picker-panel.tsx packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.test.tsx
rtk proxy git -c commit.gpgsign=false commit -m "feat(dashboard): adapt date picker for mobile" -m "Co-authored-by: Codex <noreply@openai.com>"
```

Expected: tests PASS before the commit.

---

### Task 5: Logs presets and exact-range integration

**Files:**

- Create: `packages/dashboard/src/modules/logs/log-date-range/index.ts`
- Create: `packages/dashboard/src/modules/logs/log-date-range/log-date-range.ts`
- Create: `packages/dashboard/src/modules/logs/log-date-range/log-date-range-presets.ts`
- Create: `packages/dashboard/src/modules/logs/log-date-range/log-date-range.test.ts`
- Create: `packages/dashboard/src/modules/logs/log-date-range/log-date-range-presets.test.ts`
- Modify: `packages/dashboard/src/modules/logs/components/logs-filters.tsx`
- Modify: `packages/dashboard/src/modules/logs/templates/logs-page/logs-page.test.tsx`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Delete: `packages/dashboard/src/modules/logs/log-date-range.ts`
- Delete: `packages/dashboard/src/modules/logs/log-date-range.test.ts`
- Delete: `packages/dashboard/src/modules/logs/components/logs-date-range-picker.tsx`

**Interfaces:**

- `toPickerRange` maps the required Logs ISO pair to `{ from: Date; to: Date }`.
- `toQueryRange` maps a resolved range to exact ISO strings without `startOfDay/endOfDay`.
- `createLogsDateTimeRangePresets()` returns 15m, 1h, 3h, 6h, 12h, 24h, 3d, and 7d presets with localized labels.
- Logs clear resets only the date pair to `createDefaultLogsSearch()` values; all other filters remain intact.

- [ ] **Step 1: Move and rewrite date-range tests in the new directory**

Protect exact times instead of day re-normalization:

```ts
test("commits a complete range without discarding custom times", () => {
  const range = toQueryRange({ from: new Date(2026, 6, 20, 8, 15, 0, 0), to: new Date(2026, 6, 20, 9, 45, 59, 999) });
  expect(range).toEqual({
    startedAfter: new Date(2026, 6, 20, 8, 15, 0, 0).toISOString(),
    completedBefore: new Date(2026, 6, 20, 9, 45, 59, 999).toISOString(),
  });
});

test("does not commit an incomplete range", () => {
  expect(toQueryRange(undefined)).toBeUndefined();
});
```

Add preset tests with an injected `now`. For each ID, assert a fixed duration and assert that invoking the resolver at a later `now` yields a new range while a previously resolved value stays unchanged.

- [ ] **Step 2: Run moved/helper tests and verify they fail**

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/logs/log-date-range/log-date-range.test.ts src/modules/logs/log-date-range/log-date-range-presets.test.ts
```

Expected: FAIL because the new directory files do not exist.

- [ ] **Step 3: Implement exact mapping and fixed preset factories**

`toQueryRange` must return `range.from.toISOString()` and `range.to.toISOString()` exactly. Preset factories use an injected `now` and minute-inclusive boundaries so the default minute format round-trips predictably:

```ts
const resolveMinutes = (minutes: number, now: Date) => {
  const to = endOfMinute(now);
  return {
    from: new Date(to.getTime() - minutes * 60_000 + 1),
    to,
  };
};
```

Use 15, 60, 180, 360, 720, 1_440, 4_320, and 10_080 minutes. Return a new array from `createLogsDateTimeRangePresets()` so current locale messages are read at render time.

- [ ] **Step 4: Add preset copy and compile i18n**

Add these exact missing Logs keys and reuse existing `range_24h` / `range_7d`:

```json
{
  "range_15m": "Last 15 minutes",
  "range_1h": "Last 1 hour",
  "range_3h": "Last 3 hours",
  "range_6h": "Last 6 hours",
  "range_12h": "Last 12 hours",
  "range_3d": "Last 3 days"
}
```

```json
{
  "range_15m": "最近 15 分钟",
  "range_1h": "最近 1 小时",
  "range_3h": "最近 3 小时",
  "range_6h": "最近 6 小时",
  "range_12h": "最近 12 小时",
  "range_3d": "最近 3 天"
}
```

Do not expose 14d, 30d, or 45d in the new picker.

```bash
rtk bun run i18n:compile
```

Expected: compilation succeeds.

- [ ] **Step 5: Add failing Logs integration assertions**

Replace the existing "without custom presets" assertion in `logs-page.test.tsx`. Assert the shared trigger opens one calendar and the eight preset labels, editing From/To and applying sends exact ISO values with `page: 1`, and clearing restores only today's range while preserving another active filter.

The clear regression must start with `outcome: "failure"` and verify the last `onSearchChange` call still contains `outcome: "failure"`.

- [ ] **Step 6: Replace the Logs-specific picker**

In `logs-filters.tsx`:

- Import `DateTimeRangePicker` from `@/components/date-time-range-picker`.
- Pass `value={field.state.value}`, `presets={createLogsDateTimeRangePresets()}`, `min={retentionStart}`, `max={endOfDay(now)}`, and `allowClear`.
- On a resolved value, call `field.handleChange(value)` and patch exact `toQueryRange(value)` output.
- On `undefined`, get a fresh `createDefaultLogsSearch()` and patch only `startedAfter/completedBefore`.
- Keep TanStack Form as the owner of the Logs field.
- Remove the old Logs-specific picker import and file.

Update the Logs form Zod schema so `dateRange` accepts a complete `{ from: z.date(), to: z.date() }` or `undefined` during the immediate clear callback.

- [ ] **Step 7: Run Logs and shared component tests**

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/components/date-time-range-picker/date-time-range-value.test.ts src/components/date-time-range-picker/date-time-range-picker.test.tsx src/modules/logs/log-date-range/log-date-range.test.ts src/modules/logs/log-date-range/log-date-range-presets.test.ts src/modules/logs/templates/logs-page/logs-page.test.tsx src/modules/logs/logs-search.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 8: Commit Task 5**

```bash
rtk git add packages/dashboard/src/components/date-time-range-picker packages/dashboard/src/modules/logs packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json
rtk proxy git -c commit.gpgsign=false commit -m "feat(dashboard): use date time picker for logs" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 6: Full verification and visual QA

**Files:**

- Modify only files from Tasks 1–5 if verification reveals a concrete regression.

**Interfaces:**

- No new product behavior. This task proves the accepted spec and repository quality gates.

- [ ] **Step 1: Run formatting/lint checks and the complete dashboard tests**

```bash
rtk bun run check
rtk bun run --filter @aio-proxy/dashboard test:unit
rtk bun run --filter @aio-proxy/dashboard build
```

Expected: all commands exit 0.

- [ ] **Step 2: Run repository preflight**

```bash
rtk bun run preflight
```

Expected: oxlint, oxfmt check, all unit tests, plugin-sdk type tests, artifact tests, and dev-task graph tests pass.

- [ ] **Step 3: Verify the desktop flow in the running dashboard**

Use the existing dev session; do not start a duplicate watcher. In an authenticated dashboard tab:

1. Open Logs and verify the input-style default trigger.
2. Open the Popover and verify one month, eight presets, From/To fields, and Apply.
3. Select a calendar range and confirm local `00:00` / `23:59` defaults.
4. Edit times, Apply, and confirm the URL has exact ISO values.
5. Select a preset, Apply, wait for auto-refresh, and confirm the URL range remains fixed.
6. Clear and confirm the range returns to local today without losing other filters.
7. Check browser console errors.

If authentication is required, stop visual QA and ask the user to sign in; never read or fill the dashboard password.

- [ ] **Step 4: Verify the mobile Sheet**

Read the browser viewport capability documentation before changing dimensions. Test at a narrow viewport, confirm the bottom Sheet has no horizontal overflow, the content scrolls, Apply stays reachable, and dismissal discards the draft. Reset the temporary viewport override afterward.

- [ ] **Step 5: Final diff checks**

```bash
rtk git diff --check
rtk git status --short
```

Expected: no whitespace errors; only intentional task files differ from the task's starting state.

- [ ] **Step 6: Commit verification fixes only if Step 1–5 required code changes**

```bash
rtk git add packages/dashboard/src/components/date-time-range-picker packages/dashboard/src/modules/logs packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json
rtk proxy git -c commit.gpgsign=false commit -m "fix(dashboard): harden date time range picker" -m "Co-authored-by: Codex <noreply@openai.com>"
```

Skip this commit when verification required no code changes.
