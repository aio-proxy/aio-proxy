import type { Locale } from "date-fns";

import { m } from "@aio-proxy/i18n";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

import type { DateTimeRange, DateTimeRangePreset } from "./date-time-range-picker.types";

import { useDateTimeRangePicker } from "./use-date-time-range-picker";

interface DateTimeRangePickerPanelProps {
  readonly value?: DateTimeRange;
  readonly pattern: string;
  readonly locale: Locale;
  readonly min?: Date;
  readonly max?: Date;
  readonly presets: readonly DateTimeRangePreset[];
  readonly mobile: boolean;
  readonly onApply: (value: DateTimeRange) => void;
}

const LAYOUT = {
  mobile: {
    panel: "grid w-full gap-4",
    primary: "grid gap-4",
    calendarWrapper: "order-2 min-w-0",
    calendar: "w-full p-0",
    presets: "order-1 grid grid-cols-2 gap-2",
    presetVariant: "outline",
    preset: undefined,
    fields: "grid gap-4",
    rangeError: undefined,
    actions: "sticky bottom-0 bg-popover pt-2",
    apply: "w-full",
  },
  desktop: {
    panel: "grid w-128 max-w-[calc(100vw-2rem)]",
    primary: "grid grid-cols-[minmax(0,1fr)_11rem] gap-4 border-b pb-4",
    calendarWrapper: "min-w-0",
    calendar: "p-0",
    presets: "grid max-h-72 content-start gap-1 overflow-y-auto",
    presetVariant: "ghost",
    preset: "justify-start",
    fields: "grid grid-cols-2 gap-4 border-b py-4",
    rangeError: "col-span-full",
    actions: "flex justify-end pt-4",
    apply: undefined,
  },
} as const;

export const DateTimeRangePickerPanel: React.FC<DateTimeRangePickerPanelProps> = ({
  value,
  pattern,
  locale,
  min,
  max,
  presets,
  mobile,
  onApply,
}) => {
  const layout = LAYOUT[mobile ? "mobile" : "desktop"];
  const { form, selected, disabledDates, activePresetId, selectRange, selectPreset, clearActivePreset } =
    useDateTimeRangePicker({ value, pattern, locale, min, max, onApply });
  const endpoints = [
    { name: "from", id: "date-time-range-from", label: m["dashboard.date_time_range_picker.start"]() },
    { name: "to", id: "date-time-range-to", label: m["dashboard.date_time_range_picker.end"]() },
  ] as const;

  return (
    <form
      data-testid="date-time-range-panel"
      className={layout.panel}
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <div data-slot="date-time-range-primary" className={layout.primary}>
        <div className={layout.calendarWrapper}>
          <Calendar
            data-testid="date-time-range-calendar"
            className={layout.calendar}
            mode="range"
            numberOfMonths={1}
            excludeDisabled
            defaultMonth={selected?.from}
            selected={selected}
            disabled={disabledDates}
            locale={locale}
            onSelect={selectRange}
          />
        </div>
        {presets.length > 0 && (
          <div data-slot="date-time-range-presets" className={layout.presets}>
            {presets.map((preset) => (
              <Button
                key={preset.id}
                type="button"
                variant={layout.presetVariant}
                className={layout.preset}
                aria-pressed={activePresetId === preset.id}
                onClick={() => selectPreset(preset)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      <div data-slot="date-time-range-fields" className={layout.fields}>
        {endpoints.map((endpoint) => (
          <form.Field key={endpoint.name} name={endpoint.name}>
            {(field) => (
              <Field data-invalid={field.state.meta.errors.length > 0}>
                <FieldLabel htmlFor={endpoint.id}>{endpoint.label}</FieldLabel>
                <Input
                  id={endpoint.id}
                  value={field.state.value}
                  onChange={(event) => {
                    clearActivePreset();
                    field.handleChange(event.target.value);
                  }}
                />
                <FieldError errors={field.state.meta.errors} />
              </Field>
            )}
          </form.Field>
        ))}
        <form.Subscribe selector={(state) => state.errorMap.onChange ?? state.errorMap.onMount}>
          {(error) => <FieldError className={layout.rangeError} errors={error?.form?.[""]} />}
        </form.Subscribe>
      </div>
      <div data-slot="date-time-range-actions" className={layout.actions}>
        <form.Subscribe selector={(state) => state.canSubmit}>
          {(canSubmit) => (
            <Button type="submit" className={layout.apply} disabled={!canSubmit}>
              {m["dashboard.date_time_range_picker.apply"]()}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
};
