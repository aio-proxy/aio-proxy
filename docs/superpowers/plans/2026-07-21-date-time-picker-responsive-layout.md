# Date-Time Picker Responsive Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shared date-time picker match the compact Cloudflare desktop structure and fill the mobile Sheet's inner width.

**Architecture:** Keep the fix inside `DateTimeRangePicker`; do not change the shared Calendar or Sheet primitives. The panel owns one responsive structure: desktop uses calendar/presets above a two-field row and right-aligned footer, while mobile reorders presets before a full-width calendar and stacks the fields above a full-width sticky Apply action.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 4, Base UI, react-day-picker, TanStack Form, Rstest, Testing Library, Bun.

## Global Constraints

- Work from `/Volumes/ExternalSSD/workspace/aio-proxy`; preserve the unrelated `bun.lock` modification and never stage it.
- Do not modify `packages/dashboard/src/components/ui/calendar.tsx`, `sheet.tsx`, or any other shared UI primitive.
- Keep existing date parsing, validation, presets, Apply semantics, trigger rendering, and desktop/mobile state ownership unchanged.
- Desktop order is calendar plus vertically stacked presets, then From/To, then right-aligned Apply.
- Mobile order is two-column presets, full-width seven-column calendar, stacked From/To fields, then full-width sticky Apply.
- Keep the Sheet edge-to-edge with its existing rounded top treatment; only its inner content must fill the available width.
- Add no dependencies, no new component abstraction, and no new i18n copy.
- Follow TDD: observe the focused layout tests fail before changing production code.

---

## File Map

- `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.test.tsx` — protects desktop structure, mobile full-width hooks, and resets the viewport mock after every test.
- `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker-panel.tsx` — owns the responsive panel structure and Calendar width override.
- `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.tsx` — caps the desktop Popover width and keeps the mobile scroll body full-width.

### Task 1: Correct desktop structure and mobile width

**Files:**

- Modify: `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.test.tsx`
- Modify: `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker-panel.tsx`
- Modify: `packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.tsx`

**Interfaces:**

- Consumes the existing `DateTimeRangePickerProps`, `DateTimeRangePickerPanelProps`, Calendar `className`/`classNames` overrides, and `mobile` boolean.
- Produces no public API changes. Adds a stable panel test ID plus internal `data-slot` hooks for the primary,
  presets, fields, and actions regions.

- [ ] **Step 1: Write failing desktop and mobile layout tests**

Update the test imports so the viewport mock always resets:

```tsx
import { afterEach, describe, expect, rs, test } from "@rstest/core";

afterEach(() => {
  viewport.mobile = false;
});
```

Remove the manual `viewport.mobile = false` at the end of the existing mobile test. Pass two presets to that test, then add these assertions after the Sheet opens:

```tsx
const panel = within(dialog).getByTestId("date-time-range-panel");
const calendar = within(dialog).getByTestId("date-time-range-calendar");
const presets = dialog.querySelector('[data-slot="date-time-range-presets"]');
const actions = dialog.querySelector('[data-slot="date-time-range-actions"]');

expect(panel).toHaveClass("w-full");
expect(calendar).toHaveClass("w-full");
expect(presets).toHaveClass("grid-cols-2");
expect(within(actions as HTMLElement).getByRole("button", { name: /Apply|应用/u })).toHaveClass("w-full");
```

Replace the existing desktop smoke render with one preset and add structural assertions:

```tsx
render(
  <DateTimeRangePicker
    value={value}
    presets={[{ id: "today", label: "Today", resolve: () => value }]}
    onChange={rs.fn()}
  />,
);

openPicker();
const panel = await screen.findByTestId("date-time-range-panel");
const primary = panel.querySelector('[data-slot="date-time-range-primary"]');
const presets = panel.querySelector('[data-slot="date-time-range-presets"]');
const fields = panel.querySelector('[data-slot="date-time-range-fields"]');
const actions = panel.querySelector('[data-slot="date-time-range-actions"]');

expect(panel).toHaveClass("w-128");
expect(primary).toHaveClass("grid-cols-[minmax(0,1fr)_11rem]");
expect(presets).toHaveClass("content-start");
expect(presets).not.toHaveClass("flex-wrap");
expect(fields).toHaveClass("grid-cols-2");
expect(actions).toHaveClass("justify-end");
expect(document.querySelector('[data-slot="popover-content"]')).not.toBeNull();
expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/components/date-time-range-picker/date-time-range-picker.test.tsx
```

Expected: FAIL because `date-time-range-panel` and the responsive layout classes do not exist yet.

- [ ] **Step 3: Implement the minimal responsive panel structure**

In `date-time-range-picker-panel.tsx`, make the form width explicit:

```tsx
<form
  data-testid="date-time-range-panel"
  className={mobile ? "grid w-full gap-4" : "grid w-128 max-w-[calc(100vw-2rem)]"}
  onSubmit={(event) => {
    event.preventDefault();
    void form.handleSubmit();
  }}
>
```

Replace the current calendar/preset wrapper with one primary region. Keep the existing preset click handler unchanged:

```tsx
<div
  data-slot="date-time-range-primary"
  className={mobile ? "grid gap-4" : "grid grid-cols-[minmax(0,1fr)_11rem] gap-4 border-b pb-4"}
>
  <div className={mobile ? "order-2 min-w-0" : "min-w-0"}>
    <Calendar
      data-testid="date-time-range-calendar"
      className={mobile ? "w-full p-0" : "p-0"}
      classNames={mobile ? { root: "w-full" } : undefined}
      mode="range"
      numberOfMonths={1}
      excludeDisabled
      defaultMonth={normalizedFrom}
      selected={selected}
      disabled={disabled}
      locale={locale}
      onSelect={selectRange}
    />
  </div>
  {presets.length > 0 && (
    <div
      data-slot="date-time-range-presets"
      className={mobile ? "order-1 grid grid-cols-2 gap-2" : "grid max-h-72 content-start gap-1 overflow-y-auto"}
    >
      {presets.map((preset) => (
        <Button
          key={preset.id}
          type="button"
          variant={mobile ? "outline" : "ghost"}
          className={mobile ? undefined : "justify-start"}
          aria-pressed={activePreset === preset.id}
          onClick={() => {
            const resolved = preset.resolve(new Date());
            setActivePreset(preset.id);
            setSelected(resolved);
            form.setFieldValue("from", format(resolved.from, pattern, { locale }));
            form.setFieldValue("to", format(resolved.to, pattern, { locale }));
          }}
        >
          {preset.label}
        </Button>
      ))}
    </div>
  )}
</div>
```

Inside the existing `form.Subscribe`, keep parsing and field handlers unchanged, but return a fragment containing a responsive field region and a separate action region:

```tsx
<>
  <div
    data-slot="date-time-range-fields"
    className={mobile ? "grid gap-4" : "grid grid-cols-2 gap-4 border-b py-4"}
  >
    <form.Field name="from">
      {(field) => (
        <Field data-invalid={fromErrors.length > 0}>
          <FieldLabel htmlFor="date-time-range-from">
            {m["dashboard.date_time_range_picker.start"]()}
          </FieldLabel>
          <Input
            id="date-time-range-from"
            value={field.state.value}
            onChange={(event) => {
              setActivePreset(undefined);
              field.handleChange(event.target.value);
            }}
          />
          <FieldError errors={fromErrors} />
        </Field>
      )}
    </form.Field>
    <form.Field name="to">
      {(field) => (
        <Field data-invalid={toErrors.length > 0}>
          <FieldLabel htmlFor="date-time-range-to">
            {m["dashboard.date_time_range_picker.end"]()}
          </FieldLabel>
          <Input
            id="date-time-range-to"
            value={field.state.value}
            onChange={(event) => {
              setActivePreset(undefined);
              field.handleChange(event.target.value);
            }}
          />
          <FieldError errors={toErrors} />
        </Field>
      )}
    </form.Field>
    <FieldError className={mobile ? undefined : "col-span-full"} errors={rangeErrors} />
  </div>
  <div
    data-slot="date-time-range-actions"
    className={mobile ? "sticky bottom-0 bg-popover pt-2" : "flex justify-end pt-4"}
  >
    <Button type="submit" className={mobile ? "w-full" : undefined} disabled={!parsed.success}>
      {m["dashboard.date_time_range_picker.apply"]()}
    </Button>
  </div>
</>
```

In `date-time-range-picker.tsx`, leave Sheet structure unchanged and keep the Popover content intrinsic to the explicit panel width:

```tsx
<PopoverContent className="w-auto" align="start">
  {panel}
</PopoverContent>
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/components/date-time-range-picker/date-time-range-picker.test.tsx
```

Expected: all picker tests PASS, including the new desktop/mobile layout regressions.

- [ ] **Step 5: Run Dashboard verification**

Run:

```bash
rtk bun run check
rtk bun run --filter @aio-proxy/dashboard test:unit
rtk bun run --filter @aio-proxy/dashboard build
rtk git diff --check
```

Expected: every command exits `0`; existing repository `max-lines` warnings may remain non-failing.

- [ ] **Step 6: Perform browser QA**

Reuse the current dev server and authenticated Logs page. Do not start another watcher.

Desktop checks:

1. Popover stays compact instead of spanning the page.
2. Calendar is left, presets are a vertical list on the right.
3. From/To are a two-column row below them.
4. Apply is in the bottom-right footer.

Mobile checks at a narrow viewport:

1. Sheet retains the rounded top and fills the viewport width.
2. Presets render as two columns.
3. Calendar weekday/date columns divide the inner width evenly with no blank right half or horizontal overflow.
4. Inputs and sticky Apply fill the inner width.
5. Reset the temporary viewport override.

- [ ] **Step 7: Commit only the scoped fix**

```bash
rtk git add \
  packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.test.tsx \
  packages/dashboard/src/components/date-time-range-picker/date-time-range-picker-panel.tsx \
  packages/dashboard/src/components/date-time-range-picker/date-time-range-picker.tsx \
  docs/superpowers/plans/2026-07-21-date-time-picker-responsive-layout.md
rtk proxy git -c commit.gpgsign=false commit \
  -m "fix(dashboard): correct date picker layout" \
  -m "Co-authored-by: Codex <noreply@openai.com>"
```
