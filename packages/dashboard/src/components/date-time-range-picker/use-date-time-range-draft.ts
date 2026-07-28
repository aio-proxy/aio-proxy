import { m } from '@aio-proxy/i18n';
import { endOfDay, startOfDay, type Locale } from 'date-fns';
import { useState } from 'react';
import type { DateRange, Matcher } from 'react-day-picker';

import {
  cloneValidDate,
  createDateTimeRangeDraft,
  createDateTimeRangeDraftSchema,
  formatDateTime,
  parseDateTimeEndpoint,
} from './date-time-range';
import type { DateTimeRange, DateTimeRangePreset } from './date-time-range-picker.types';

interface UseDateTimeRangeDraftOptions {
  value?: DateTimeRange | undefined;
  pattern: string;
  locale: Locale;
  min?: Date | undefined;
  max?: Date | undefined;
  onChange: (value: DateTimeRange) => void;
}

export const useDateTimeRangeDraft = ({ value, pattern, locale, min, max, onChange }: UseDateTimeRangeDraftOptions) => {
  const schema = createDateTimeRangeDraftSchema({
    pattern,
    locale,
    min,
    max,
    messages: {
      invalid: m['dashboard.date_time_range_picker.invalid'](),
      order: m['dashboard.date_time_range_picker.order'](),
      beforeMin: m['dashboard.date_time_range_picker.before_min'](),
      afterMax: m['dashboard.date_time_range_picker.after_max'](),
    },
  });
  const [draft, setDraft] = useState(() => createDateTimeRangeDraft(value, pattern, locale));
  const validation = schema.safeParse(draft);
  const errors = validation.success ? [] : validation.error.issues;
  const from = parseDateTimeEndpoint(draft.from, 'from', pattern, locale);
  const to = parseDateTimeEndpoint(draft.to, 'to', pattern, locale);
  const selected: DateRange | undefined =
    from === undefined && to === undefined ? undefined : to === undefined ? { from } : { from, to };
  const minimum = cloneValidDate(min);
  const maximum = cloneValidDate(max);
  const disabledDates: Matcher[] = [
    ...(minimum === undefined ? [] : [{ before: minimum }]),
    ...(maximum === undefined ? [] : [{ after: maximum }]),
  ];
  const selectRange = (range: DateRange | undefined) =>
    setDraft({
      from: formatDateTime(range?.from && startOfDay(range.from), pattern, locale),
      to: formatDateTime(range?.to && endOfDay(range.to), pattern, locale),
    });
  const selectPreset = (preset: DateTimeRangePreset) => {
    const nextDraft = createDateTimeRangeDraft(preset.resolve(new Date()), pattern, locale);
    const next = schema.safeParse(nextDraft);
    if (next.success) onChange(next.data);
    else setDraft(nextDraft);
  };
  const endpoints = [
    { name: 'from', id: 'date-time-range-from', label: m['dashboard.date_time_range_picker.start']() },
    { name: 'to', id: 'date-time-range-to', label: m['dashboard.date_time_range_picker.end']() },
  ] as const;

  return { draft, setDraft, validation, errors, selected, disabledDates, selectRange, selectPreset, endpoints };
};
