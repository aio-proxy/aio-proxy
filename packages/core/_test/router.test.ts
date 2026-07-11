import { describe, expect, test } from "bun:test";
import { ProviderProtocol } from "@aio-proxy/types";
import type { ProviderInstance } from "../src/index";
import { Router, RouterModelCollisionError, RouterModelNotFoundError } from "../src/index";

const copilot = {
  kind: "oauth",
  id: "copilot",
  vendor: "github-copilot",
  models: ["claude-sonnet-4-5"],
  alias: { sonnet: { model: "claude-sonnet-4-5", preserve: false } },
} satisfies ProviderInstance;

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

  test("exposes a preserved variant target under its original model id", () => {
    const provider = {
      ...openai,
      alias: {
        mini: {
          model: "gpt-5-mini",
          preserve: false,
          variants: { high: { model: "gpt-5", preserve: true } },
        },
      },
      models: ["gpt-5-mini", "gpt-5"],
    } satisfies ProviderInstance;
    const router = new Router([provider]);

    expect(router.resolve("gpt-5")).toEqual([{ provider, modelId: "gpt-5" }]);
  });

  test("reuses an explicit self-alias for a preserved variant targeting the same model", () => {
    const provider = {
      ...openai,
      alias: {
        "gpt-5": { model: "gpt-5", preserve: false },
        mini: {
          model: "gpt-5-mini",
          preserve: false,
          variants: { high: { model: "gpt-5", preserve: true } },
        },
      },
      models: ["gpt-5-mini", "gpt-5"],
    } satisfies ProviderInstance;
    const router = new Router([provider]);

    expect(router.resolve("gpt-5")).toEqual([{ provider, modelId: "gpt-5" }]);
  });

  test("deduplicates identical preserved routes within a provider", () => {
    const provider = {
      ...openai,
      alias: {
        mini: { model: "gpt-5-mini", preserve: true },
        fast: { model: "gpt-5-mini", preserve: true },
      },
      models: ["gpt-5-mini", "gpt-5"],
    } satisfies ProviderInstance;
    const router = new Router([provider]);

    expect(router.resolve("gpt-5-mini")).toEqual([{ provider, modelId: "gpt-5-mini" }]);
  });

  test("rejects an explicit alias that conflicts with a preserved model id", () => {
    const provider = {
      ...openai,
      alias: {
        "gpt-5-mini": { model: "gpt-5", preserve: false },
        mini: { model: "gpt-5-mini", preserve: true },
      },
      models: ["gpt-5-mini", "gpt-5"],
    } satisfies ProviderInstance;

    expect(() => new Router([provider])).toThrow(RouterModelCollisionError);
  });

  test("provider-qualified aliases only return the requested provider", () => {
    const other = {
      kind: "api",
      id: "other",
      protocol: ProviderProtocol.OpenAICompatible,
      models: ["other-mini"],
      alias: { mini: { model: "other-mini", preserve: false } },
    } satisfies ProviderInstance;

    const router = new Router([openai, other]);

    expect(router.resolve("other/mini")).toEqual([{ provider: other, modelId: "other-mini" }]);
  });

  test("throws a 404 sentinel for a missing alias", () => {
    const router = new Router([openai]);

    expect(() => router.resolve("missing")).toThrow(RouterModelNotFoundError);
    try {
      router.resolve("missing");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterModelNotFoundError);
      if (error instanceof RouterModelNotFoundError) {
        expect(error.code).toBe("MODEL_NOT_FOUND");
        expect(error.status).toBe(404);
      }
    }
  });

  test("ignores disabled providers", () => {
    const router = new Router([{ ...openai, enabled: false }]);

    expect(() => router.resolve("gpt-5-mini")).toThrow(RouterModelNotFoundError);
    expect(() => router.resolve("openai/gpt-5-mini")).toThrow(RouterModelNotFoundError);
  });

  test("resolves the plan QA copilot sonnet alias", () => {
    const router = new Router([copilot]);

    const resolved = router.resolve("sonnet");

    expect(resolved).toEqual([{ provider: copilot, modelId: "claude-sonnet-4-5" }]);
  });

  test("does not expose raw model strings unless preserved", () => {
    const router = new Router([{ ...openai, alias: { mini: { model: "gpt-5-mini", preserve: false } } }]);

    expect(() => router.resolve("gpt-5-mini")).toThrow(RouterModelNotFoundError);
  });

  test("resolves a fully-qualified preserved original model id", () => {
    const router = new Router([openai]);

    const resolved = router.resolve("openai/gpt-5-mini");

    expect(resolved).toEqual([{ provider: openai, modelId: "gpt-5-mini" }]);
  });

  test("treats a preserved self-alias as a single route", () => {
    const selfAlias = {
      ...openai,
      alias: { "gpt-5-mini": { model: "gpt-5-mini", preserve: true } },
    } satisfies ProviderInstance;
    const router = new Router([selfAlias]);

    expect(router.resolve("gpt-5-mini")).toEqual([{ provider: selfAlias, modelId: "gpt-5-mini" }]);
    expect(router.resolve("openai/gpt-5-mini")).toEqual([{ provider: selfAlias, modelId: "gpt-5-mini" }]);
  });

  test("rejects a preserved provider route that conflicts with an explicit alias variant", () => {
    const conflicting = {
      kind: "api",
      id: "dupe",
      protocol: ProviderProtocol.OpenAIResponse,
      models: ["first", "second"],
      alias: {
        first: {
          model: "first",
          preserve: false,
          variants: { high: { model: "second", preserve: false } },
        },
        firstAlias: { model: "first", preserve: true },
      },
    } satisfies ProviderInstance;

    expect(() => new Router([conflicting])).toThrow(/dupe/);
  });
});
