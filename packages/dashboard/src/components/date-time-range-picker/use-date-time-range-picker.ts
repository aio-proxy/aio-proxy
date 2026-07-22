import type { DateRange, Matcher } from "react-day-picker";

import { m } from "@aio-proxy/i18n";
import { useForm, useStore } from "@tanstack/react-form";
import { endOfDay, startOfDay, type Locale } from "date-fns";
import { useMemo, useState } from "react";

import type { DateTimeRange, DateTimeRangePreset } from "./date-time-range-picker.types";

import {
  cloneValidDate,
  createDateTimeRangeDraft,
  createDateTimeRangeDraftSchema,
  formatDateTime,
  parseDateTimeEndpoint,
} from "./date-time-range";

interface UseDateTimeRangePickerOptions {
  readonly value?: DateTimeRange;
  readonly pattern: string;
  readonly locale: Locale;
  readonly min?: Date;
  readonly max?: Date;
  readonly onApply: (value: DateTimeRange) => void;
}

const messages = () => ({
  invalid: m["dashboard.date_time_range_picker.invalid"](),
  order: m["dashboard.date_time_range_picker.order"](),
  beforeMin: m["dashboard.date_time_range_picker.before_min"](),
  afterMax: m["dashboard.date_time_range_picker.after_max"](),
});

export const useDateTimeRangePicker = ({
  value,
  pattern,
  locale,
  min,
  max,
  onApply,
}: UseDateTimeRangePickerOptions) => {
  const [activePresetId, setActivePresetId] = useState<string>();
  const schema = useMemo(
    () => createDateTimeRangeDraftSchema({ pattern, locale, min, max, messages: messages() }),
    [locale, max, min, pattern],
  );
  const form = useForm({
    defaultValues: createDateTimeRangeDraft(value, pattern, locale),
    validators: { onMount: schema, onChange: schema },
    onSubmit: ({ value: draft }) => {
      const parsed = schema.safeParse(draft);
      if (parsed.success) onApply(parsed.data);
    },
  });
  const draft = useStore(form.store, (state) => state.values);
  const from = parseDateTimeEndpoint(draft.from, "from", pattern, locale);
  const to = parseDateTimeEndpoint(draft.to, "to", pattern, locale);
  const selected: DateRange | undefined =
    from === undefined && to === undefined ? undefined : to === undefined ? { from } : { from, to };
  const minimum = cloneValidDate(min);
  const maximum = cloneValidDate(max);
  const disabledDates: Matcher[] = [
    ...(minimum === undefined ? [] : [{ before: minimum }]),
    ...(maximum === undefined ? [] : [{ after: maximum }]),
  ];
  const clearActivePreset = () => setActivePresetId(undefined);
  const selectRange = (range: DateRange | undefined) => {
    clearActivePreset();
    form.setFieldValue("from", formatDateTime(range?.from && startOfDay(range.from), pattern, locale));
    form.setFieldValue("to", formatDateTime(range?.to && endOfDay(range.to), pattern, locale));
  };
  const selectPreset = (preset: DateTimeRangePreset) => {
    const resolved = preset.resolve(new Date());
    form.setFieldValue("from", formatDateTime(cloneValidDate(resolved.from), pattern, locale));
    form.setFieldValue("to", formatDateTime(cloneValidDate(resolved.to), pattern, locale));
    setActivePresetId(preset.id);
  };

  return { form, selected, disabledDates, activePresetId, selectRange, selectPreset, clearActivePreset };
};
