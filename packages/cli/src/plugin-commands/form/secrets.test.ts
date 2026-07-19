import { zod } from "@aio-proxy/plugin-sdk";
import { describe, expect, test } from "bun:test";

import { FormSchemaValidationError, renderConfigSpec } from "./index";
import { type PromptCall, prompts, spec } from "./test-support";

describe("renderConfigSpec secrets", () => {
  test("uses existing public defaults, retains blank secrets, and supports explicit clear", async () => {
    const calls: PromptCall[] = [];
    const existing = await renderConfigSpec(spec, {
      prompts: prompts(["https://new.test", "", "4", false, "eu", '{"mode":"strict"}'], calls),
      currentPublicValues: { endpoint: "https://old.test", retries: 2 },
      currentSecrets: { token: "old-secret" },
    });
    expect((calls[0]?.config as { default?: unknown } | undefined)?.default).toBe("https://old.test");
    expect((calls[2]?.config as { default?: unknown } | undefined)?.default).toBe("2");
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
      renderConfigSpec(renamedSecret, { prompts: prompts(["https://example.test", "transform-secret-sentinel"]) }),
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
    const calls: PromptCall[] = [];
    const result = await renderConfigSpec(transformed, {
      prompts: prompts(["https://example.test/path", "  transformed-secret  "], calls),
      currentPublicValues: { endpoint: "https://old.example/path" },
    });
    expect((calls[0]?.config as { default?: unknown } | undefined)?.default).toBe("https://old.example/path");
    expect(result).toEqual({
      publicValues: { endpoint: "https://example.test/path" },
      secrets: { token: "transformed-secret" },
    });
  });
});
