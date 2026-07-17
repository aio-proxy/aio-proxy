import { describe, expect, test } from "bun:test";
import { zod } from "@aio-proxy/plugin-sdk";
import { FormSchemaValidationError, renderConfigSpec } from "./index";
import { prompts } from "./test-support";

describe("renderConfigSpec JSON boundaries", () => {
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
    await expect(renderConfigSpec(nonPlain, { prompts: prompts(["https://example.test"]) })).rejects.toBeInstanceOf(
      FormSchemaValidationError,
    );
  });
});
