import type { DateRange, Matcher } from "react-day-picker";

import { getLocale, m } from "@aio-proxy/i18n";
import { useForm } from "@tanstack/react-form";
import { endOfDay, format, startOfDay } from "date-fns";
import { enUS, zhCN } from "date-fns/locale";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

import type {
  DateTimeInput,
  DateTimeRangePreset,
  DateTimeRangeValue,
  ResolvedDateTimeRangeValue,
} from "./date-time-range-picker.types";

import {
  createDateTimeRangeDraft,
  createDateTimeRangeDraftSchema,
  normalizeDateTimeInput,
} from "./date-time-range-value";

interface DateTimeRangePickerPanelProps {
  readonly value: DateTimeRangeValue | undefined;
  readonly presets: readonly DateTimeRangePreset[];
  readonly pattern: string;
  readonly min: DateTimeInput | undefined;
  readonly max: DateTimeInput | undefined;
  readonly mobile: boolean;
  readonly onApply: (value: ResolvedDateTimeRangeValue) => void;
}

const messages = () => ({
  invalid: m["dashboard.date_time_range_picker.invalid"](),
  order: m["dashboard.date_time_range_picker.order"](),
  beforeMin: m["dashboard.date_time_range_picker.before_min"](),
  afterMax: m["dashboard.date_time_range_picker.after_max"](),
});

export const DateTimeRangePickerPanel: React.FC<DateTimeRangePickerPanelProps> = ({
  value,
  presets,
  pattern,
  min,
  max,
  mobile,
  onApply,
}) => {
  const locale = getLocale() === "zh-Hans" ? zhCN : enUS;
  const normalizedFrom = normalizeDateTimeInput(value?.from);
  const normalizedTo = normalizeDateTimeInput(value?.to);
  const minimum = normalizeDateTimeInput(min);
  const maximum = normalizeDateTimeInput(max);
  const [selected, setSelected] = useState<DateRange | undefined>(
    normalizedFrom === undefined ? undefined : { from: normalizedFrom, to: normalizedTo },
  );
  const [activePreset, setActivePreset] = useState<string>();
  const schema = useMemo(
    () => createDateTimeRangeDraftSchema({ pattern, locale, min, max, messages: messages() }),
    [locale, max, min, pattern],
  );
  const form = useForm({
    defaultValues: createDateTimeRangeDraft(value, pattern, locale),
    validators: {
      onChange: ({ value: draft }) => {
        const parsed = schema.safeParse(draft);
        return parsed.success ? undefined : parsed.error.issues.map((issue) => issue.message).join(", ");
      },
    },
    onSubmit: ({ value: draft }) => {
      const parsed = schema.safeParse(draft);
      if (parsed.success) onApply(parsed.data);
    },
  });
  const disabled: Matcher[] = [
    ...(minimum === undefined ? [] : [{ before: minimum }]),
    ...(maximum === undefined ? [] : [{ after: maximum }]),
  ];

  const selectRange = (range: DateRange | undefined) => {
    setActivePreset(undefined);
    setSelected(range);
    form.setFieldValue("from", range?.from === undefined ? "" : format(startOfDay(range.from), pattern, { locale }));
    form.setFieldValue("to", range?.to === undefined ? "" : format(endOfDay(range.to), pattern, { locale }));
  };

  return (
    <form
      className={mobile ? "grid gap-4" : "grid grid-cols-[auto_16rem] gap-4"}
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <div className="grid content-start gap-3">
        {presets.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {presets.map((preset) => (
              <Button
                key={preset.id}
                type="button"
                variant="outline"
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
        <Calendar
          data-testid="date-time-range-calendar"
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
      <form.Subscribe selector={(state) => state.values}>
        {(draft) => {
          const parsed = schema.safeParse(draft);
          const issues = parsed.success ? [] : parsed.error.issues;
          const fromErrors = issues.filter((issue) => issue.path[0] === "from");
          const toErrors = issues.filter((issue) => issue.path[0] === "to");
          const rangeErrors = issues.filter((issue) => issue.path.length === 0);
          return (
            <div className="grid content-start gap-4">
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
                    <FieldLabel htmlFor="date-time-range-to">{m["dashboard.date_time_range_picker.end"]()}</FieldLabel>
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
              <FieldError errors={rangeErrors} />
              <Button type="submit" disabled={!parsed.success}>
                {m["dashboard.date_time_range_picker.apply"]()}
              </Button>
            </div>
          );
        }}
      </form.Subscribe>
    </form>
  );
};
