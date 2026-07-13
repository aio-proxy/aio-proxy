import { describe, expect, test } from "bun:test";
import { calculateEstimatedCost, createModelsDevCatalog, createOpenRouterPriceCatalog } from "../src/usage-pricing";

const api = {
  openai: {
    models: {
      "gpt-5.5": {
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
    },
  },
  openrouter: {
    models: {
      "openai/gpt-5.5": {
        id: "openai/gpt-5.5",
        name: "GPT-5.5",
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
  proxy: {
    models: {
      "gpt-5.5": {
        id: "gpt-5.5",
        name: "gpt-5.5",
      },
    },
  },
};

const conflictingApi = {
  first: {
    models: {
      shared: { id: "shared-model", name: "Shared Model" },
    },
  },
  second: {
    models: {
      shared: { id: "shared-model", name: "Different Shared Model" },
    },
  },
};

describe("OpenRouter usage pricing", () => {
  test("matches full and bare model ids", async () => {
    const catalog = await createOpenRouterPriceCatalog(async () => api);

    expect(catalog.find("openai/gpt-5.5")?.id).toBe("openai/gpt-5.5");
    expect(catalog.find("gpt-5.5")?.id).toBe("openai/gpt-5.5");
  });

  test("resolves one human-readable name across duplicate provider entries", async () => {
    const catalog = await createModelsDevCatalog(async () => api);

    expect(catalog.displayName("gpt-5.5")).toBe("GPT-5.5");
    expect(catalog.displayName("openai/gpt-5.5")).toBe("GPT-5.5");
  });

  test("rejects conflicting human-readable names", async () => {
    const catalog = await createModelsDevCatalog(async () => conflictingApi);

    expect(catalog.displayName("shared-model")).toBeUndefined();
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
