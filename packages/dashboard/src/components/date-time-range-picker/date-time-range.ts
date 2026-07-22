import { format, isValid, parse, type Locale } from "date-fns";
import { z } from "zod";

import type { DateTimeRange } from "./date-time-range-picker.types";

export interface DateTimeRangeDraft {
  readonly from: string;
  readonly to: string;
}

export interface DateTimeRangeDraftSchemaOptions {
  readonly pattern: string;
  readonly locale: Locale;
  readonly min?: Date;
  readonly max?: Date;
  readonly messages: {
    readonly invalid: string;
    readonly order: string;
    readonly beforeMin: string;
    readonly afterMax: string;
  };
}

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1_000;

export const cloneValidDate = (value: Date | undefined): Date | undefined => {
  if (value === undefined) return undefined;
  const date = new Date(value.getTime());
  return Number.isNaN(date.getTime()) ? undefined : date;
};

export const formatDateTime = (value: Date | undefined, pattern: string, locale: Locale): string => {
  const date = cloneValidDate(value);
  return date === undefined ? "" : format(date, pattern, { locale });
};

export const createDateTimeRangeDraft = (
  value: DateTimeRange | undefined,
  pattern: string,
  locale: Locale,
): DateTimeRangeDraft => ({
  from: formatDateTime(value?.from, pattern, locale),
  to: formatDateTime(value?.to, pattern, locale),
});

export const parseDateTimeEndpoint = (
  text: string,
  boundary: "from" | "to",
  pattern: string,
  locale: Locale,
): Date | undefined => {
  const reference = new Date(2000, 0, 1, 0, 0, boundary === "from" ? 0 : 59, boundary === "from" ? 0 : 999);
  let parsed = parse(text, pattern, reference, { locale });
  if (!isValid(parsed) || format(parsed, pattern, { locale }) !== text) return undefined;

  if (boundary === "to") {
    const nextDay = new Date(parsed);
    nextDay.setDate(nextDay.getDate() + 1);
    const overlap = nextDay.getTime() - parsed.getTime() - DAY_IN_MILLISECONDS;
    const candidate = new Date(parsed.getTime() + overlap);
    if (overlap > 0 && format(candidate, pattern, { locale }) === text) parsed = candidate;
  }

  const zero = new Date(2000, 0, 1);
  if (format(zero, pattern, { locale }) === format(new Date(2000, 0, 1, 0, 0, 59), pattern, { locale })) {
    parsed.setTime(parsed.getTime() + (reference.getSeconds() - parsed.getSeconds()) * 1_000);
  }
  if (format(zero, pattern, { locale }) === format(new Date(2000, 0, 1, 0, 0, 0, 999), pattern, { locale })) {
    parsed.setTime(parsed.getTime() + reference.getMilliseconds() - parsed.getMilliseconds());
  }
  return parsed;
};

const createEndpointSchema = (boundary: "from" | "to", pattern: string, locale: Locale, invalidMessage: string) =>
  z.string().transform((text, context) => {
    const date = parseDateTimeEndpoint(text, boundary, pattern, locale);
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
}: DateTimeRangeDraftSchemaOptions): z.ZodType<DateTimeRange, DateTimeRangeDraft> => {
  const minimum = cloneValidDate(min);
  const maximum = cloneValidDate(max);

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
