import { describe, expect, test } from "bun:test";
import type { Model, Provider, ProviderMap } from "@opencode-ai/models";
import { calculateEstimatedCost, createModelsDevCatalog, createOpenRouterPriceCatalog } from "../src/usage-pricing";

const model = (id: string, name: string, overrides: Partial<Model> = {}): Model => ({
  attachment: false,
  description: "",
  id,
  last_updated: "2026-01-15",
  limit: { context: 128_000, output: 8_000 },
  modalities: { input: ["text"], output: ["text"] },
  name,
  open_weights: false,
  reasoning: false,
  release_date: "2026-01-15",
  tool_call: false,
  ...overrides,
});

const provider = (id: string, models: Record<string, Model>): Provider => ({
  doc: `https://example.com/${id}`,
  env: [],
  id,
  models,
  name: id,
  npm: `@ai-sdk/${id}`,
});

const api: ProviderMap = {
  anthropic: provider("anthropic", {
    "claude-sonnet-4-6": model("claude-sonnet-4-6", "Claude Sonnet 4.6", {
      attachment: true,
      limit: { context: 1_000_000, output: 128_000 },
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
      reasoning: true,
      reasoning_options: [
        { type: "effort", values: ["low", "medium", "high", "max"] },
        { type: "budget_tokens", min: 1_024 },
      ],
      release_date: "2026-02-17",
      structured_output: true,
      tool_call: true,
    }),
  }),
  openai: provider("openai", {
    "gpt-5.5": model("gpt-5.5", "Direct OpenAI Name", {
      limit: { context: 64_000, output: 4_000 },
    }),
  }),
  openrouter: provider("openrouter", {
    "openai/gpt-5.5": model("openai/gpt-5.5", "GPT-5.5", {
      attachment: true,
      cost: { cache_read: 0.5, cache_write: 1, input: 2, output: 10, reasoning: 10 },
      limit: { context: 128_000, input: 120_000, output: 8_000 },
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
      structured_output: true,
      tool_call: true,
    }),
  }),
  proxy: provider("proxy", {
    "claude-sonnet-4-6": model("claude-sonnet-4-6", "Claude Sonnet 4-6"),
    "gpt-5.5": model("gpt-5.5", "GPT 5.5"),
  }),
};

const conflictingApi: ProviderMap = {
  first: provider("first", { shared: model("shared-model", "Shared Model") }),
  second: provider("second", { shared: model("shared-model", "Different Shared Model") }),
};

describe("OpenRouter usage pricing", () => {
  test("matches full and bare model ids", async () => {
    const catalog = await createOpenRouterPriceCatalog(async () => api);

    expect(catalog.find("openai/gpt-5.5")?.id).toBe("openai/gpt-5.5");
    expect(catalog.find("gpt-5.5")?.id).toBe("openai/gpt-5.5");
  });

  test("prefers complete OpenRouter metadata and keeps provider fallbacks", async () => {
    const catalog = await createModelsDevCatalog(async () => api);

    expect(catalog.metadata("gpt-5.5")).toEqual({
      capabilities: {
        effort: {
          high: { supported: true },
          low: { supported: true },
          max: { supported: false },
          medium: { supported: true },
          supported: true,
          xhigh: { supported: false },
        },
        image_input: { supported: true },
        pdf_input: { supported: true },
        structured_outputs: { supported: true },
        thinking: {
          supported: true,
          types: { adaptive: { supported: true }, enabled: { supported: false } },
        },
      },
      displayName: "GPT-5.5",
      maxInputTokens: 120_000,
      maxTokens: 8_000,
      releaseDate: "2026-01-15",
    });
    expect(catalog.metadata("claude-sonnet-4-6")).toMatchObject({
      displayName: "Claude Sonnet 4.6",
      maxInputTokens: 1_000_000,
      maxTokens: 128_000,
      releaseDate: "2026-02-17",
    });
    expect(catalog.metadata("openai/gpt-5.5")).toEqual(catalog.metadata("gpt-5.5"));
    expect(catalog.metadata("anthropic/claude-sonnet-4-6")).toEqual(catalog.metadata("claude-sonnet-4-6"));
  });

  test("rejects conflicting human-readable names", async () => {
    const catalog = await createModelsDevCatalog(async () => conflictingApi);

    expect(catalog.metadata("shared-model")).toBeUndefined();
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
