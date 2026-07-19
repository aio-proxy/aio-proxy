import { describe, expect, test } from "@rstest/core";

import { toPickerRange, toQueryRange } from "./log-date-range";

describe("log date range", () => {
  test("maps active query instants to local calendar dates", () => {
    const range = toPickerRange({
      startedAfter: "2026-07-11T08:00:00.000Z",
      completedBefore: "2026-07-12T08:00:00.000Z",
    });

    expect(range.from?.getFullYear()).toBe(new Date("2026-07-11T08:00:00.000Z").getFullYear());
    expect(range.from?.getMonth()).toBe(new Date("2026-07-11T08:00:00.000Z").getMonth());
    expect(range.from?.getDate()).toBe(new Date("2026-07-11T08:00:00.000Z").getDate());
    expect(range.to?.getDate()).toBe(new Date("2026-07-12T08:00:00.000Z").getDate());
  });

  test("does not commit an incomplete range", () => {
    expect(toQueryRange({ from: new Date(2026, 6, 12) })).toBeUndefined();
  });

  test("commits a complete range as local day boundaries", () => {
    const query = toQueryRange({ from: new Date(2026, 6, 11, 12), to: new Date(2026, 6, 12, 12) });

    expect(query).toBeDefined();
    const start = new Date(query?.startedAfter ?? "");
    const end = new Date(query?.completedBefore ?? "");
    expect([start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()]).toEqual([0, 0, 0, 0]);
    expect([end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()]).toEqual([23, 59, 59, 999]);
  });
});
