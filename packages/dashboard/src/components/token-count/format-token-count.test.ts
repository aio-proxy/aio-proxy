import { describe, expect, test } from "@rstest/core";
import { formatCompactTokenCount, formatExactTokenCount } from "./format-token-count";

describe("formatCompactTokenCount", () => {
  test("keeps small integers exact and compacts with K/M/B suffixes", () => {
    expect(formatCompactTokenCount(0)).toBe("0");
    expect(formatCompactTokenCount(999)).toBe("999");
    expect(formatCompactTokenCount(1_200)).toBe("1.2K");
    expect(formatCompactTokenCount(1_234_567)).toBe("1.2M");
    expect(formatCompactTokenCount(1_500_000_000)).toBe("1.5B");
  });
});

describe("formatExactTokenCount", () => {
  test("formats the full integer with locale grouping", () => {
    expect(formatExactTokenCount(1_200, "en-US")).toBe("1,200");
    expect(formatExactTokenCount(1_234_567, "en-US")).toBe("1,234,567");
  });
});
