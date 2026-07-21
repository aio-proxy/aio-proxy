import { format, isValid, parse, type Locale } from "date-fns";
import { z } from "zod";

import type { DateTimeInput, DateTimeRangeDraft, DateTimeRangeValue } from "./date-time-range-picker.types";

interface DateTimeRangeDraftSchemaOptions {
  readonly pattern: string;
  readonly locale: Locale;
  readonly min?: DateTimeInput;
  readonly max?: DateTimeInput;
  readonly messages: {
    readonly invalid: string;
    readonly order: string;
    readonly beforeMin: string;
    readonly afterMax: string;
  };
}

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1_000;

export const normalizeDateTimeInput = (value: DateTimeInput | undefined): Date | undefined => {
  if (value === undefined) return undefined;
  const date = new Date(value instanceof Date ? value.getTime() : value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

export const formatDateTimeInput = (value: DateTimeInput | undefined, pattern: string, locale: Locale): string => {
  const date = normalizeDateTimeInput(value);
  return date === undefined ? "" : format(date, pattern, { locale });
};

export const createDateTimeRangeDraft = (
  value: DateTimeRangeValue | undefined,
  pattern: string,
  locale: Locale,
): DateTimeRangeDraft => ({
  from: formatDateTimeInput(value?.from, pattern, locale),
  to: formatDateTimeInput(value?.to, pattern, locale),
});

const parseLocalDateTime = (
  text: string,
  pattern: string,
  locale: Locale,
  boundary: "from" | "to",
): Date | undefined => {
  const reference = new Date(2000, 0, 1, 0, 0, boundary === "from" ? 0 : 59, boundary === "from" ? 0 : 999);
  const parsed = parse(text, pattern, reference, { locale });
  if (!isValid(parsed) || format(parsed, pattern, { locale }) !== text) return undefined;

  if (boundary === "to") {
    const nextDay = new Date(parsed);
    nextDay.setDate(nextDay.getDate() + 1);
    const overlap = nextDay.getTime() - parsed.getTime() - DAY_IN_MILLISECONDS;
    const candidate = new Date(parsed.getTime() + overlap);
    if (overlap > 0 && format(candidate, pattern, { locale }) === text) return candidate;
  }

  const zero = new Date(2000, 0, 1);
  if (format(zero, pattern, { locale }) === format(new Date(2000, 0, 1, 0, 0, 59), pattern, { locale })) {
    parsed.setSeconds(reference.getSeconds());
  }
  if (format(zero, pattern, { locale }) === format(new Date(2000, 0, 1, 0, 0, 0, 999), pattern, { locale })) {
    parsed.setMilliseconds(reference.getMilliseconds());
  }
  return parsed;
};

const createEndpointSchema = (boundary: "from" | "to", pattern: string, locale: Locale, invalidMessage: string) =>
  z.string().transform((text, context) => {
    const date = parseLocalDateTime(text, pattern, locale, boundary);
    if (date !== undefined) return date;
    context.addIssue({ code: "custom", message: invalidMessage });
    return z.NEVER;
  });

export const createDateTimeRangeDraftSchema = ({
  pattern,
  locale,
  min,
  max,
  messages,
}: DateTimeRangeDraftSchemaOptions) => {
  const minimum = normalizeDateTimeInput(min);
  const maximum = normalizeDateTimeInput(max);

  return z
    .object({
      from: createEndpointSchema("from", pattern, locale, messages.invalid),
      to: createEndpointSchema("to", pattern, locale, messages.invalid),
    })
    .superRefine(({ from, to }, context) => {
      if (from > to) context.addIssue({ code: "custom", message: messages.order });
      if (minimum !== undefined && from < minimum) {
        context.addIssue({ code: "custom", message: messages.beforeMin, path: ["from"] });
      }
      if (maximum !== undefined && to > maximum) {
        context.addIssue({ code: "custom", message: messages.afterMax, path: ["to"] });
      }
    });
};
