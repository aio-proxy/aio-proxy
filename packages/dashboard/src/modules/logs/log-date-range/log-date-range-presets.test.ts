import { describe, expect, test } from "@rstest/core";
import { endOfMinute } from "date-fns";

import { createLogsDateTimeRangePresets } from "./log-date-range-presets";

const durations = {
  "15m": 15,
  "1h": 60,
  "3h": 180,
  "6h": 360,
  "12h": 720,
  "24h": 1_440,
  "3d": 4_320,
  "7d": 10_080,
} as const;

describe("logs date time range presets", () => {
  test.each(Object.entries(durations))("resolves %s to a fixed minute-inclusive range", (id, minutes) => {
    const now = new Date(2026, 6, 20, 12, 34, 45, 678);
    const preset = createLogsDateTimeRangePresets().find((candidate) => candidate.id === id);

    expect(preset).toBeDefined();
    const range = preset?.resolve(now);
    expect(range?.to).toEqual(endOfMinute(now));
    expect((range?.to.getTime() ?? 0) - (range?.from.getTime() ?? 0)).toBe(minutes * 60_000 - 1);
  });

  test("resolves against the supplied time without mutating an earlier result", () => {
    const preset = createLogsDateTimeRangePresets()[1]!;
    const first = preset.resolve(new Date(2026, 6, 20, 12, 0));
    const snapshot = { from: new Date(first.from), to: new Date(first.to) };
    const second = preset.resolve(new Date(2026, 6, 20, 13, 0));

    expect(first).toEqual(snapshot);
    expect(second).not.toEqual(first);
  });

  test("returns a fresh preset list", () => {
    expect(createLogsDateTimeRangePresets()).not.toBe(createLogsDateTimeRangePresets());
  });
});
