import { describe, expect, test } from "bun:test";
import { ProviderProtocol } from "@aio-proxy/types";
import type { ProviderInstance } from "../src/index";
import { Router, RouterModelNotFoundError } from "../src/index";

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

  test("rejects duplicate provider-specific aliases", () => {
    const duplicate = {
      kind: "api",
      id: "dupe",
      protocol: ProviderProtocol.OpenAIResponse,
      models: ["first", "second"],
      alias: {
        firstAlias: { model: "first", preserve: true },
        secondAlias: { model: "first", preserve: true },
      },
    } satisfies ProviderInstance;

    expect(() => new Router([duplicate])).toThrow(/dupe/);
  });
});
