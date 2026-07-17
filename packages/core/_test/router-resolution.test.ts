import { describe, expect, test } from "bun:test";
import { ProviderProtocol } from "@aio-proxy/types";
import type { ProviderInstance } from "../src/index";
import { Router } from "../src/index";

const openai = {
  kind: "api",
  id: "openai",
  protocol: ProviderProtocol.OpenAIResponse,
  models: ["gpt-5-mini"],
  alias: { mini: { model: "gpt-5-mini", preserve: true } },
} satisfies ProviderInstance;

describe("Router", () => {
  test("resolves a simple alias to provider and model id", () => {
    const router = new Router([openai]);

    const resolved = router.resolve("mini");

    expect(resolved).toEqual([{ provider: openai, modelId: "gpt-5-mini" }]);
  });

  test("resolves a fully-qualified provider alias override", () => {
    const anthropic = {
      kind: "api",
      id: "anthropic",
      protocol: ProviderProtocol.Anthropic,
      models: ["claude-3-5-haiku"],
      alias: { haiku: { model: "claude-3-5-haiku", preserve: false } },
    } satisfies ProviderInstance;
    const router = new Router([openai, anthropic]);

    const resolved = router.resolve("anthropic/haiku");

    expect(resolved).toEqual([{ provider: anthropic, modelId: "claude-3-5-haiku" }]);
  });

  test("returns ordered candidates for duplicate aliases", () => {
    const other = {
      kind: "api",
      id: "other",
      protocol: ProviderProtocol.OpenAICompatible,
      models: ["other-mini"],
      alias: { mini: { model: "other-mini", preserve: false } },
    } satisfies ProviderInstance;

    const router = new Router([openai, other]);

    expect(router.resolve("mini")).toEqual([
      { provider: openai, modelId: "gpt-5-mini" },
      { provider: other, modelId: "other-mini" },
    ]);
  });

  test("resolves a normalized variant for every provider candidate without reordering", () => {
    const primary = {
      ...openai,
      alias: {
        mini: {
          model: "gpt-5-mini",
          preserve: false,
          variants: { high: { model: "gpt-5", preserve: false } },
        },
      },
      models: ["gpt-5-mini", "gpt-5"],
    } satisfies ProviderInstance;
    const fallback = {
      kind: "api",
      id: "fallback",
      protocol: ProviderProtocol.OpenAICompatible,
      models: ["fallback-mini", "fallback-high"],
      alias: {
        mini: {
          model: "fallback-mini",
          preserve: false,
          variants: { high: { model: "fallback-high", preserve: false } },
        },
      },
    } satisfies ProviderInstance;
    const router = new Router([primary, fallback]);

    expect(router.resolve("mini", " High ")).toEqual([
      { provider: primary, modelId: "gpt-5" },
      { provider: fallback, modelId: "fallback-high" },
    ]);
  });

  test("falls back to each alias default when the variant is missing", () => {
    const provider = {
      ...openai,
      alias: {
        mini: {
          model: "gpt-5-mini",
          preserve: false,
          variants: { high: { model: "gpt-5", preserve: false } },
        },
      },
      models: ["gpt-5-mini", "gpt-5"],
    } satisfies ProviderInstance;
    const router = new Router([provider]);

    expect(router.resolve("mini", "unknown")).toEqual([{ provider, modelId: "gpt-5-mini" }]);
  });

  test("resolves provider-qualified aliases with variants", () => {
    const provider = {
      ...openai,
      alias: {
        mini: {
          model: "gpt-5-mini",
          preserve: false,
          variants: { high: { model: "gpt-5", preserve: false } },
        },
      },
      models: ["gpt-5-mini", "gpt-5"],
    } satisfies ProviderInstance;
    const router = new Router([provider]);

    expect(router.resolve("openai/mini", "high")).toEqual([{ provider, modelId: "gpt-5" }]);
  });
});
