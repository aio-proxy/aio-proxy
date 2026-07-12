import { describe, expect, test } from "@rstest/core";
import { displayTotalTokens, formatLogCost } from "./log-formatters";

describe("log formatters", () => {
  test("prefers reported total tokens and only falls back to complete input/output pairs", () => {
    expect(displayTotalTokens({ providerId: "p", modelId: "m", totalTokens: 9, inputTokens: 3, outputTokens: 4 })).toBe(
      9,
    );
    expect(displayTotalTokens({ providerId: "p", modelId: "m", inputTokens: 3, outputTokens: 4 })).toBe(7);
    expect(displayTotalTokens({ providerId: "p", modelId: "m", inputTokens: 3 })).toBeUndefined();
    expect(displayTotalTokens(undefined)).toBeUndefined();
  });

  test("renders missing cost as an em dash", () => {
    expect(formatLogCost(undefined, "en-US")).toBe("—");
    expect(formatLogCost(0.0049, "en-US")).toBe("$0.0049");
  });
});
