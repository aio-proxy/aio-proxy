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

  test("rejects malformed, reversed, and out-of-bounds drafts at their public paths", () => {
    const schema = createDateTimeRangeDraftSchema({
      pattern: "yyyy-MM-dd HH:mm",
      locale: enUS,
      min: new Date(2026, 6, 1),
      max: new Date(2026, 6, 31, 23, 59, 59, 999),
      messages,
    });
    const issuePaths = [
      schema.safeParse({ from: "bad", to: "2026-07-20 12:00" }),
      schema.safeParse({ from: "2026-07-21 12:00", to: "2026-07-20 12:00" }),
      schema.safeParse({ from: "2026-06-30 23:59", to: "2026-07-20 12:00" }),
      schema.safeParse({ from: "2026-07-20 12:00", to: "2026-08-01 00:00" }),
    ].map((result) => (result.success ? undefined : result.error.issues[0]?.path));

    expect(issuePaths).toEqual([["from"], [], ["from"], ["to"]]);
  });
});

const testInNewYork = Intl.DateTimeFormat().resolvedOptions().timeZone === "America/New_York" ? test : test.skip;

testInNewYork("rejects gaps and expands repeated local end times", () => {
  const schema = createDateTimeRangeDraftSchema({
    pattern: "yyyy-MM-dd HH:mm",
    locale: enUS,
    messages,
  });
  expect(schema.safeParse({ from: "2026-03-08 02:30", to: "2026-03-08 03:30" }).success).toBe(false);
  const overlap = schema.parse({ from: "2026-11-01 01:30", to: "2026-11-01 01:30" });
  expect(overlap.to.getTime() - overlap.from.getTime()).toBe(60 * 60 * 1_000 + 59 * 1_000 + 999);
  expect([overlap.to.getSeconds(), overlap.to.getMilliseconds()]).toEqual([59, 999]);
});
