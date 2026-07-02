import { describe, expect, test } from "bun:test";
import { ProviderProtocol } from "@aio-proxy/types";
import type { ProviderInstance } from "../src/index";
import { Router, RouterModelNotFoundError } from "../src/index";

const copilot = {
  kind: "subscription",
  id: "copilot",
  vendor: "github-copilot",
  models: [{ alias: "sonnet", id: "claude-sonnet-4-5" }],
} satisfies ProviderInstance;

const openai = {
  kind: "api",
  id: "openai",
  protocol: ProviderProtocol.OpenAIResponse,
  models: ["gpt-5-mini", { alias: "mini", id: "gpt-5-mini" }],
} satisfies ProviderInstance;

describe("Router", () => {
  test("resolves a simple alias to provider and model id", () => {
    const router = new Router([openai]);

    const resolved = router.resolve("mini");

    expect(resolved).toEqual({ provider: openai, modelId: "gpt-5-mini" });
  });

  test("resolves a fully-qualified provider alias override", () => {
    const anthropic = {
      kind: "api",
      id: "anthropic",
      protocol: ProviderProtocol.Anthropic,
      models: [{ alias: "haiku", id: "claude-3-5-haiku" }],
    } satisfies ProviderInstance;
    const router = new Router([openai, anthropic]);

    const resolved = router.resolve("anthropic/haiku");

    expect(resolved).toEqual({
      provider: anthropic,
      modelId: "claude-3-5-haiku",
    });
  });

  test("throws a collision error including both provider ids", () => {
    const other = {
      kind: "api",
      id: "other",
      protocol: ProviderProtocol.OpenAICompatible,
      models: [{ alias: "mini", id: "other-mini" }],
    } satisfies ProviderInstance;

    expect(() => new Router([openai, other])).toThrow(
      /openai.*other|other.*openai/,
    );
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

  test("resolves the plan QA copilot sonnet alias", () => {
    const router = new Router([copilot]);

    const resolved = router.resolve("sonnet");

    expect(resolved).toEqual({
      provider: copilot,
      modelId: "claude-sonnet-4-5",
    });
  });

  test("resolves a direct model string", () => {
    const router = new Router([openai]);

    const resolved = router.resolve("gpt-5-mini");

    expect(resolved).toEqual({ provider: openai, modelId: "gpt-5-mini" });
  });

  test("resolves a fully-qualified direct model string", () => {
    const router = new Router([openai]);

    const resolved = router.resolve("openai/gpt-5-mini");

    expect(resolved).toEqual({ provider: openai, modelId: "gpt-5-mini" });
  });

  test("rejects duplicate provider-specific aliases", () => {
    const duplicate = {
      kind: "api",
      id: "dupe",
      protocol: ProviderProtocol.OpenAIResponse,
      models: [
        { alias: "mini", id: "first" },
        { alias: "mini", id: "second" },
      ],
    } satisfies ProviderInstance;

    expect(() => new Router([duplicate])).toThrow(/dupe/);
  });
});
