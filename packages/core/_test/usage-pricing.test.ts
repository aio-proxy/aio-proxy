import { describe, expect, test } from "bun:test";
import { calculateEstimatedCost, createOpenRouterPriceCatalog } from "../src/usage-pricing";

const api = {
  openrouter: {
    models: {
      "openai/gpt-5.5": {
        id: "openai/gpt-5.5",
        cost: {
          input: 2,
          output: 10,
          cache_read: 0.5,
          cache_write: 1,
          reasoning: 10,
        },
      },
    },
  },
};

describe("OpenRouter usage pricing", () => {
  test("matches full and bare model ids", async () => {
    const catalog = await createOpenRouterPriceCatalog(async () => api);

    expect(catalog.find("openai/gpt-5.5")?.id).toBe("openai/gpt-5.5");
    expect(catalog.find("gpt-5.5")?.id).toBe("openai/gpt-5.5");
  });

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
