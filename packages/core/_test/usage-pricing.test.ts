import { describe, expect, test } from "bun:test";

import { calculateEstimatedCost } from "../src/usage-pricing";

describe("OpenRouter usage pricing", () => {
  test("calculates cost from known token dimensions", () => {
    expect(
      calculateEstimatedCost(
        {
          inputTokens: 1_000_000,
          outputTokens: 500_000,
          cacheReadTokens: 100_000,
          cacheWriteTokens: 200_000,
          reasoningTokens: 300_000,
        },
        {
          id: "openai/gpt-5.5",
          input: 2,
          output: 10,
          cacheRead: 0.5,
          cacheWrite: 1,
          reasoning: 10,
        },
      ),
    ).toEqual({
      estimatedCostUsd: 10.25,
      priceModelId: "openai/gpt-5.5",
    });
  });
});
