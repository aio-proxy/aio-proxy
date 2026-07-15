import { describe, expect, test } from "bun:test";
import { zod } from "@aio-proxy/plugin-sdk";
import {
  FormJsonInvalidError,
  FormNumberInvalidError,
  FormSchemaValidationError,
  type PluginFormPrompts,
  renderConfigSpec,
} from "../src/plugin-commands/form";

function prompts(
  values: readonly unknown[],
  calls: { type: string; config: unknown; signal?: AbortSignal }[] = [],
): PluginFormPrompts {
  let index = 0;
  const next = (type: string) => async (config: unknown, context?: { signal?: AbortSignal }) => {
    calls.push({ type, config, signal: context?.signal });
    return values[index++];
  };
  return {
    input: next("input") as PluginFormPrompts["input"],
    password: next("password") as PluginFormPrompts["password"],
    confirm: next("confirm") as PluginFormPrompts["confirm"],
    select: next("select") as PluginFormPrompts["select"],
  };
}

const spec = {
  schema: zod.object({
    endpoint: zod.string().url(),
    token: zod.string().min(1).optional(),
    retries: zod.number().int(),
    enabled: zod.boolean(),
    region: zod.enum(["us", "eu"]),
    advanced: zod.object({ mode: zod.literal("strict") }),
  }),
  form: [
    { type: "text", key: "endpoint", label: "Endpoint" },
    { type: "secret", key: "token", label: "Token" },
    { type: "number", key: "retries", label: "Retries" },
    { type: "boolean", key: "enabled", label: "Enabled", defaultValue: false },
    {
      type: "select",
      key: "region",
      label: "Region",
      options: [
        { label: "US", value: "us" },
        { label: "EU", value: "eu" },
      ],
    },
    { type: "json", key: "advanced", label: "Advanced" },
  ],
} as const;

describe("renderConfigSpec", () => {
  test("renders all six field types and keeps secrets out of public values", async () => {
    const result = await renderConfigSpec(spec, {
      prompts: prompts(["https://example.test", "secret-value", "3", true, "us", '{"mode":"strict"}']),
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
    const calls: { type: string; config: unknown; signal?: AbortSignal }[] = [];

    const result = await renderConfigSpec(conditional, { prompts: prompts(["simple"], calls) });

    expect(result.publicValues).toEqual({ mode: "simple" });
    expect(calls).toHaveLength(1);
  });

  test("uses existing public defaults, retains blank secrets, and supports explicit clear", async () => {
    const calls: { type: string; config: unknown; signal?: AbortSignal }[] = [];
    const existing = await renderConfigSpec(spec, {
      prompts: prompts(["https://new.test", "", "4", false, "eu", '{"mode":"strict"}'], calls),
      currentPublicValues: { endpoint: "https://old.test", retries: 2 },
      currentSecrets: { token: "old-secret" },
    });
    expect((calls[0]?.config as { default?: unknown }).default).toBe("https://old.test");
    expect((calls[2]?.config as { default?: unknown }).default).toBe("2");
    expect(existing.secrets).toEqual({ token: "old-secret" });

    const cleared = await renderConfigSpec(spec, {
      prompts: prompts(["https://new.test", "", "4", false, "eu", '{"mode":"strict"}']),
      currentSecrets: { token: "old-secret" },
      clearSecrets: ["token"],
    });
    expect(cleared.secrets).toEqual({});
  });

  test("retains hidden existing secrets and applies explicit clear after visibility", async () => {
    const requiredHidden = {
      schema: zod.object({ mode: zod.enum(["simple", "advanced"]), token: zod.string().min(1) }),
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
        { type: "secret", key: "token", label: "Token", when: { key: "mode", equals: "advanced" } },
      ],
    } as const;
    const retained = await renderConfigSpec(requiredHidden, {
      prompts: prompts(["simple"]),
      currentSecrets: { token: "retained" },
    });
    expect(retained).toEqual({ publicValues: { mode: "simple" }, secrets: { token: "retained" } });

    const optionalHidden = {
      ...requiredHidden,
      schema: zod.object({ mode: zod.enum(["simple", "advanced"]), token: zod.string().optional() }),
    } as const;
    const cleared = await renderConfigSpec(optionalHidden, {
      prompts: prompts(["simple"]),
      currentSecrets: { token: "retained" },
      clearSecrets: ["token"],
    });
    expect(cleared).toEqual({ publicValues: { mode: "simple" }, secrets: {} });
  });

  test("drops secrets removed from the current descriptor even when its schema passes unknown keys through", async () => {
    const sentinel = "retired-secret-sentinel";
    const migrated = {
      schema: zod.object({ endpoint: zod.string().url() }).passthrough(),
      form: [{ type: "text", key: "endpoint", label: "Endpoint" }],
    } as const;

    const result = await renderConfigSpec(migrated, {
      prompts: prompts(["https://example.test"]),
      currentSecrets: { retiredToken: sentinel },
    });

    expect(result).toEqual({ publicValues: { endpoint: "https://example.test" }, secrets: {} });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  test("ignores clear-secret keys that are public fields in the current descriptor", async () => {
    const publicOnly = {
      schema: zod.object({ endpoint: zod.string().url().optional() }),
      form: [{ type: "text", key: "endpoint", label: "Endpoint" }],
    } as const;

    const result = await renderConfigSpec(publicOnly, {
      prompts: prompts(["https://example.test"]),
      clearSecrets: ["endpoint"],
    });

    expect(result).toEqual({ publicValues: { endpoint: "https://example.test" }, secrets: {} });
  });

  test("rejects a schema transform that renames a current secret into an undeclared public key", async () => {
    const sentinel = "transform-secret-sentinel";
    const renamedSecret = {
      schema: zod
        .object({ endpoint: zod.string().url(), token: zod.string() })
        .transform(({ endpoint, token }) => ({ endpoint, leaked: token })),
      form: [
        { type: "text", key: "endpoint", label: "Endpoint" },
        { type: "secret", key: "token", label: "Token" },
      ],
    } as const;

    await expect(
      renderConfigSpec(renamedSecret, {
        prompts: prompts(["https://example.test", sentinel]),
      }),
    ).rejects.toBeInstanceOf(FormSchemaValidationError);
  });

  test("allows same-key secret transforms while preserving public prompt defaults", async () => {
    const transformed = {
      schema: zod
        .object({ endpoint: zod.string().url(), token: zod.string() })
        .transform(({ endpoint, token }) => ({ endpoint: endpoint.toLowerCase(), token: token.trim() })),
      form: [
        { type: "text", key: "endpoint", label: "Endpoint" },
        { type: "secret", key: "token", label: "Token" },
      ],
    } as const;
    const calls: { type: string; config: unknown; signal?: AbortSignal }[] = [];

    const result = await renderConfigSpec(transformed, {
      prompts: prompts(["https://example.test/path", "  transformed-secret  "], calls),
      currentPublicValues: { endpoint: "https://old.example/path" },
    });

    expect((calls[0]?.config as { default?: unknown }).default).toBe("https://old.example/path");
    expect(result).toEqual({
      publicValues: { endpoint: "https://example.test/path" },
      secrets: { token: "transformed-secret" },
    });
  });

  test("uses stable deep equality for unchanged public JSON while transforming a secret", async () => {
    let schemaOwnedSettings: { alpha: number; beta: number } | undefined;
    const transformed = {
      schema: zod
        .object({ settings: zod.object({ alpha: zod.number(), beta: zod.number() }), token: zod.string() })
        .transform(({ settings, token }) => {
          schemaOwnedSettings = { beta: settings.beta, alpha: settings.alpha };
          return { settings: schemaOwnedSettings, token: token.trim() };
        }),
      form: [
        { type: "json", key: "settings", label: "Settings" },
        { type: "secret", key: "token", label: "Token" },
      ],
    } as const;

    const result = await renderConfigSpec(transformed, {
      prompts: prompts(['{"alpha":1,"beta":2}', "  transformed-secret  "]),
    });

    expect(result).toEqual({
      publicValues: { settings: { beta: 2, alpha: 1 } },
      secrets: { token: "transformed-secret" },
    });
    expect(result.publicValues.settings).not.toBe(schemaOwnedSettings);
    if (schemaOwnedSettings === undefined) throw new Error("schema did not produce settings");
    schemaOwnedSettings.alpha = 99;
    expect(result.publicValues.settings).toEqual({ beta: 2, alpha: 1 });
  });

  test("allows public transforms and defaults when no secret input is present", async () => {
    const publicOnly = {
      schema: zod.object({ endpoint: zod.string() }).transform(({ endpoint }) => ({
        endpoint: endpoint === "" ? "DEFAULT-ENDPOINT" : endpoint.toUpperCase(),
      })),
      form: [{ type: "text", key: "endpoint", label: "Endpoint" }],
    } as const;

    const transformed = await renderConfigSpec(publicOnly, { prompts: prompts(["mixed-case"]) });
    const defaulted = await renderConfigSpec(publicOnly, { prompts: prompts([""]) });

    expect(transformed.publicValues).toEqual({ endpoint: "MIXED-CASE" });
    expect(defaulted.publicValues).toEqual({ endpoint: "DEFAULT-ENDPOINT" });
  });

  test("clones ordinary sparse array output without retaining schema ownership", async () => {
    let schemaOwned: unknown[] | undefined;
    const sparseOutput = {
      schema: zod.object({ items: zod.array(zod.unknown()) }).transform(() => {
        schemaOwned = new Array(2);
        schemaOwned[1] = { value: "kept" };
        return { items: schemaOwned };
      }),
      form: [{ type: "json", key: "items", label: "Items" }],
    } as const;

    const result = await renderConfigSpec(sparseOutput, { prompts: prompts(["[]"]) });
    const items = result.publicValues.items as unknown[];

    expect(items).not.toBe(schemaOwned);
    expect(items).toHaveLength(2);
    expect(0 in items).toBe(false);
    expect(items[1]).toEqual({ value: "kept" });
  });

  test("rejects non-plain schema output records", async () => {
    class Output {
      endpoint = "https://example.test";
    }
    const nonPlain = {
      schema: zod.object({ endpoint: zod.string().url() }).transform(() => new Output()),
      form: [{ type: "text", key: "endpoint", label: "Endpoint" }],
    } as const;

    await expect(
      renderConfigSpec(nonPlain, {
        prompts: prompts(["https://example.test"]),
      }),
    ).rejects.toBeInstanceOf(FormSchemaValidationError);
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
    const calls: { type: string; config: unknown; signal?: AbortSignal }[] = [];

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

    expect((calls[0]?.config as { default?: unknown }).default).toBeUndefined();
    expect((calls[1]?.config as { default?: unknown }).default).toBeUndefined();
    expect((calls[2]?.config as { default?: unknown }).default).toBe(true);
    expect((calls[3]?.config as { default?: unknown }).default).toBeUndefined();
    expect((calls[4]?.config as { default?: unknown }).default).toBe('{"safe":true}');
  });

  test("forwards the same signal to every prompt and abort returns no partial result", async () => {
    const controller = new AbortController();
    const calls: { type: string; config: unknown; signal?: AbortSignal }[] = [];
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
