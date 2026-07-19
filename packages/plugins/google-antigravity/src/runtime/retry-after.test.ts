import { expect, test } from "bun:test";

import { retryAfterMilliseconds } from "./retry-after";

const now = Date.UTC(2026, 6, 18, 0, 0, 0);

test.each([2070, 2075])("keeps RFC850 year %i within fifty years in the current century", (year) => {
  const target = Date.UTC(year, 6, 18, 12, 34, 56);

  expect(retryAfterMilliseconds(rfc850(new Date(target)), now)).toBe(target - now);
});

test("moves an RFC850 year more than fifty years ahead to the previous century", () => {
  const target = Date.UTC(1977, 6, 18, 12, 34, 56);

  expect(retryAfterMilliseconds(rfc850(new Date(target)), now)).toBe(0);
});

test("rejects an RFC850 date whose weekday does not match", () => {
  const valid = rfc850(new Date(Date.UTC(2075, 6, 18, 12, 34, 56)));
  const invalid = valid.replace(/^[^,]+/, valid.startsWith("Friday") ? "Thursday" : "Friday");

  expect(retryAfterMilliseconds(invalid, now)).toBe(Number.POSITIVE_INFINITY);
});

function rfc850(date: Date): string {
  const imf = date.toUTCString();
  const [, day, month, year, time] = imf.replace(",", "").split(" ") as [string, string, string, string, string];
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getUTCDay()];
  return `${weekday}, ${day}-${month}-${year.slice(-2)} ${time} GMT`;
}
