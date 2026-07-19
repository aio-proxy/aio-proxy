import { zod } from "@aio-proxy/plugin-sdk";
import { describe, expect, test } from "bun:test";

import {
  FormJsonInvalidError,
  FormNumberInvalidError,
  FormSchemaValidationError,
  type PluginFormPrompts,
  renderConfigSpec,
} from "./index";
import { type PromptCall, prompts, spec } from "./test-support";

describe("renderConfigSpec", () => {
  test("resolves localized field, option, and placeholder copy at prompt time", async () => {
    const calls: PromptCall[] = [];
    await renderConfigSpec(
      {
        schema: zod.object({ mode: zod.literal("fast"), name: zod.string() }),
        form: [
          {
            type: "select",
            key: "mode",
            label: { default: "Mode", "zh-Hans": "模式" },
            description: { default: "Choose", "zh-Hans": "选择" },
            options: [{ value: "fast", label: { default: "Fast", "zh-Hans": "快速" } }],
          },
          {
            type: "text",
            key: "name",
            label: { default: "Name", "zh-Hans": "名称" },
            placeholder: { default: "Ada", "zh-Hans": "小明" },
          },
        ],
      },
      { prompts: prompts(["fast", "Ada"], calls), locale: "zh-Hans" },
    );
    expect(calls.map(({ config }) => config)).toEqual([
      { message: "模式 (选择)", choices: [{ name: "快速", value: "fast" }] },
      { message: "名称", placeholder: "小明" },
    ]);
  });

  test("renders all six field types and keeps secrets out of public values", async () => {
    const calls: PromptCall[] = [];
    const result = await renderConfigSpec(spec, {
      prompts: prompts(["https://example.test", "secret-value", "3", true, "us", '{"mode":"strict"}'], calls),
    });
    expect(result).toEqual({
      publicValues: {
        endpoint: "https://example.test",
        retries: 3,
        enabled: true,
        region: "us",
        advanced: { mode: "strict" },
      },
      secrets: { token: "secret-value" },
    });
    expect(result.publicValues).not.toHaveProperty("token");
    expect(calls[1]?.config).toEqual({ message: "Token", mask: "*" });
  });

  test("skips fields whose when condition is false", async () => {
    const conditional = {
      schema: zod.object({ mode: zod.string(), detail: zod.string().optional() }),
      form: [
        {
          type: "select",
          key: "mode",
          label: "Mode",
          options: [
            { label: "Simple", value: "simple" },
            { label: "Advanced", value: "advanced" },
          ],
        },
        { type: "text", key: "detail", label: "Detail", when: { key: "mode", equals: "advanced" } },
      ],
    } as const;
    const calls: PromptCall[] = [];
    const result = await renderConfigSpec(conditional, { prompts: prompts(["simple"], calls) });
    expect(result.publicValues).toEqual({ mode: "simple" });
    expect(calls).toHaveLength(1);
  });

  test("uses current defaults only when their values are compatible with the field type", async () => {
    const defaultsSpec = {
      schema: zod.object({
        text: zod.string(),
        count: zod.number(),
        enabled: zod.boolean(),
        region: zod.enum(["us", "eu"]),
        data: zod.unknown(),
      }),
      form: [
        { type: "text", key: "text", label: "Text" },
        { type: "number", key: "count", label: "Count" },
        { type: "boolean", key: "enabled", label: "Enabled", defaultValue: true },
        {
          type: "select",
          key: "region",
          label: "Region",
          options: [
            { label: "US", value: "us" },
            { label: "EU", value: "eu" },
          ],
        },
        { type: "json", key: "data", label: "Data", defaultValue: { safe: true } },
      ],
    } as const;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const calls: PromptCall[] = [];
    await renderConfigSpec(defaultsSpec, {
      prompts: prompts(["text", "2", false, "us", "{}"], calls),
      currentPublicValues: {
        text: 123,
        count: Number.POSITIVE_INFINITY,
        enabled: "false",
        region: "missing",
        data: cyclic,
      },
    });
    expect((calls[0]?.config as { default?: unknown } | undefined)?.default).toBeUndefined();
    expect((calls[1]?.config as { default?: unknown } | undefined)?.default).toBeUndefined();
    expect((calls[2]?.config as { default?: unknown } | undefined)?.default).toBe(true);
    expect((calls[3]?.config as { default?: unknown } | undefined)?.default).toBeUndefined();
    expect((calls[4]?.config as { default?: unknown } | undefined)?.default).toBe('{"safe":true}');
  });

  test("forwards the same signal to every prompt and abort returns no partial result", async () => {
    const controller = new AbortController();
    const calls: PromptCall[] = [];
    const aborting: PluginFormPrompts = {
      ...prompts([], calls),
      async input(config, context) {
        calls.push({ type: "input", config, signal: context?.signal });
        controller.abort();
        throw controller.signal.reason;
      },
    };
    await expect(renderConfigSpec(spec, { prompts: aborting, signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    );
    expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
  });

  test("rejects malformed number and json before schema validation", async () => {
    const numberSpec = {
      schema: zod.object({ count: zod.number() }),
      form: [{ type: "number", key: "count", label: "Count" }],
    } as const;
    await expect(renderConfigSpec(numberSpec, { prompts: prompts(["wat"]) })).rejects.toEqual(
      new FormNumberInvalidError("count"),
    );
    const jsonSpec = {
      schema: zod.object({ data: zod.unknown() }),
      form: [{ type: "json", key: "data", label: "Data" }],
    } as const;
    await expect(renderConfigSpec(jsonSpec, { prompts: prompts(["{"]) })).rejects.toEqual(
      new FormJsonInvalidError("data"),
    );
  });

  test("maps schema issues to top-level field keys", async () => {
    const invalidSpec = {
      schema: zod.object({ endpoint: zod.string().url(), retries: zod.number().int().positive() }),
      form: [
        { type: "text", key: "endpoint", label: "Endpoint" },
        { type: "number", key: "retries", label: "Retries" },
      ],
    } as const;
    try {
      await renderConfigSpec(invalidSpec, { prompts: prompts(["nope", "-1"]) });
      throw new Error("expected validation error");
    } catch (error) {
      expect(error).toBeInstanceOf(FormSchemaValidationError);
      expect((error as FormSchemaValidationError).issues.map((issue) => issue.key)).toEqual(["endpoint", "retries"]);
    }
  });
});
