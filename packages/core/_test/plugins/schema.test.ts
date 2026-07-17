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

  test("an empty issue list is a malformed parse result", async () => {
    const schema = {
      safeParse() {},
      async safeParseAsync() {
        return { success: false, error: { issues: [] } };
      },
    };

    await expect(parsePluginSchema(schema as never, "hidden-input")).rejects.toEqual(new PluginSchemaContractError());
  });

  test.each([
    [
      "schema method proxy",
      () =>
        new Proxy(
          {},
          {
            get() {
              throw new Error("schema-proxy-secret");
            },
          },
        ),
      "schema-proxy-secret",
    ],
    [
      "result success getter",
      () => ({
        safeParse() {},
        async safeParseAsync() {
          return Object.defineProperty({}, "success", {
            get() {
              throw new Error("success-getter-secret");
            },
          });
        },
      }),
      "success-getter-secret",
    ],
    [
      "result error getter",
      () => ({
        safeParse() {},
        async safeParseAsync() {
          return Object.defineProperty({ success: false }, "error", {
            get() {
              throw new Error("error-getter-secret");
            },
          });
        },
      }),
      "error-getter-secret",
    ],
    [
      "error issues getter",
      () => ({
        safeParse() {},
        async safeParseAsync() {
          const error = Object.defineProperty({}, "issues", {
            get() {
              throw new Error("issues-getter-secret");
            },
          });
          return { success: false, error };
        },
      }),
      "issues-getter-secret",
    ],
    [
      "issue message getter",
      () => ({
        safeParse() {},
        async safeParseAsync() {
          const issue = Object.defineProperty({ path: [] }, "message", {
            get() {
              throw new Error("message-getter-secret");
            },
          });
          return { success: false, error: { issues: [issue] } };
        },
      }),
      "message-getter-secret",
    ],
    [
      "issue path getter",
      () => ({
        safeParse() {},
        async safeParseAsync() {
          const issue = Object.defineProperty({ message: "bad" }, "path", {
            get() {
              throw new Error("path-getter-secret");
            },
          });
          return { success: false, error: { issues: [issue] } };
        },
      }),
      "path-getter-secret",
    ],
  ])("%s throws only the fixed contract error", async (_name, createSchema, leakedSecret) => {
    try {
      await parsePluginSchema(createSchema() as never, "hidden-input");
      throw new Error("expected parsePluginSchema to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginSchemaContractError);
      expect(String(error)).not.toContain(leakedSecret);
      expect(error).not.toHaveProperty("cause");
    }
  });
});
