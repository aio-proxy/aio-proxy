import { describe, expect, test } from "@rstest/core";

import { createDefaultLogsSearch, isWithinRetention, parseLogsSearch, withLogsFilters } from "./logs-search";

describe("logs search", () => {
  test("creates the current local day as the default range", () => {
    const search = createDefaultLogsSearch(new Date(2026, 6, 12, 12, 34, 56, 789));

    expect([search.page, search.pageSize]).toEqual([1, 50]);
    expect(localTime(search.startedAfter)).toEqual([2026, 6, 12, 0, 0, 0, 0]);
    expect(localTime(search.completedBefore)).toEqual([2026, 6, 12, 23, 59, 59, 999]);
  });

  test("parses valid URL values into typed search state", () => {
    expect(
      parseLogsSearch({
        page: "2",
        pageSize: "20",
        outcome: "failure",
        finalStatusCode: "503",
        requestId: " request-1 ",
        startedAfter: "2026-07-01T00:00:00.000Z",
        completedBefore: "2026-07-02T00:00:00.000Z",
      }),
    ).toMatchObject({
      page: 2,
      pageSize: 20,
      outcome: "failure",
      finalStatusCode: 503,
      requestId: "request-1",
    });
  });

  test("falls back safely for malformed values", () => {
    expect(
      parseLogsSearch(
        { page: "0", pageSize: "25", outcome: "unknown", finalStatusCode: "99", startedAfter: "bad" },
        new Date("2026-07-12T12:00:00.000Z"),
      ),
    ).toEqual(createDefaultLogsSearch(new Date("2026-07-12T12:00:00.000Z")));
  });

  test("resets pagination when filters change", () => {
    expect(
      withLogsFilters(
        { ...createDefaultLogsSearch(new Date("2026-07-12T12:00:00.000Z")), page: 3 },
        { finalProviderId: "openrouter" },
      ),
    ).toMatchObject({ page: 1, finalProviderId: "openrouter" });
  });

  test("rejects custom dates older than the retention window", () => {
    const now = new Date("2026-07-12T12:00:00.000Z");
    expect(isWithinRetention("2026-05-01T00:00:00.000Z", now)).toBe(false);
    expect(isWithinRetention("2026-06-01T12:00:00.000Z", now)).toBe(true);
  });
});

const localTime = (value: string) => {
  const date = new Date(value);
  return [
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  ];
};
