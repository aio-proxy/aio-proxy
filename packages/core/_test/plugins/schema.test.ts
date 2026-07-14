import { describe, expect, test } from "bun:test";
import { zod } from "@aio-proxy/plugin-sdk";
import { PluginSchemaContractError, parsePluginSchema } from "../../src/plugins/schema";

describe("parsePluginSchema", () => {
  test("awaits defaults, transforms, and async refinements through safeParseAsync", async () => {
    const schema = zod
      .object({ name: zod.string().default("Ada") })
      .transform(async ({ name }) => name.toUpperCase())
      .refine(async (name) => name === "ADA", "unexpected name");

    expect(await parsePluginSchema(schema, {})).toEqual({ ok: true, value: "ADA" });
  });

  test("normalizes issues to message and JSON-safe paths only", async () => {
    const result = await parsePluginSchema(zod.object({ values: zod.array(zod.string().min(2)) }), {
      values: ["x"],
    });

    expect(result).toEqual({
      ok: false,
      issues: [{ message: "Too small: expected string to have >=2 characters", path: ["values", 0] }],
    });
    expect(JSON.stringify(result)).not.toContain("input");
  });

  test("replaces unexpected issue path segments", async () => {
    const schema = {
      safeParse() {},
      async safeParseAsync() {
        return {
          success: false,
          error: { issues: [{ message: "bad", path: [Symbol("secret"), Number.POSITIVE_INFINITY] }] },
        };
      },
    };

    expect(await parsePluginSchema(schema as never, "hidden-input")).toEqual({
      ok: false,
      issues: [{ message: "bad", path: ["<unknown>", "<unknown>"] }],
    });
  });

  test("malformed schemas throw a fixed contract error without input or cause", async () => {
    const input = "do-not-expose-input";
    try {
      await parsePluginSchema({ safeParseAsync() {} } as never, input);
      throw new Error("expected parsePluginSchema to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginSchemaContractError);
      expect(String(error)).not.toContain(input);
      expect(error).not.toHaveProperty("cause");
    }
  });

  test("validator throws become a fixed contract error without raw cause", async () => {
    const raw = new Error("validator leaked a secret");
    const schema = {
      safeParse() {},
      async safeParseAsync() {
        throw raw;
      },
    };

    try {
      await parsePluginSchema(schema as never, "secret-input");
      throw new Error("expected parsePluginSchema to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginSchemaContractError);
      expect(String(error)).not.toContain("secret");
      expect(error).not.toHaveProperty("cause");
    }
  });
});
