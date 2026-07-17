import { describe, expect, test } from "bun:test";
import { ProviderMutationBodySchema } from "../src/index";

describe("ConfigSchema", () => {
  describe("ProviderMutationBodySchema alias", () => {
    test("Given api mutation body with alias When parsed Then alias is accepted and normalized", () => {
      // Given
      const body = {
        kind: "api",
        id: "openai",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
        models: ["gpt-5-mini"],
        alias: { mini: { model: "gpt-5-mini" } },
      };

      // When
      const result = ProviderMutationBodySchema.parse(body);

      // Then
      expect(result).toMatchObject({
        kind: "api",
        id: "openai",
        alias: { mini: { model: "gpt-5-mini", preserve: false } },
      });
    });

    test("Given ai-sdk mutation body with alias When parsed Then alias is accepted and normalized", () => {
      // Given
      const body = {
        kind: "ai-sdk",
        id: "google",
        packageName: "@ai-sdk/google",
        models: ["gemini-2.5-flash"],
        alias: { flash: { model: "gemini-2.5-flash" } },
      };

      // When
      const result = ProviderMutationBodySchema.parse(body);

      // Then
      expect(result).toMatchObject({
        kind: "ai-sdk",
        id: "google",
        alias: { flash: { model: "gemini-2.5-flash", preserve: false } },
      });
    });

    test("Given api mutation body with alias and variants When parsed Then variants are accepted and normalized", () => {
      // Given
      const body = {
        kind: "api",
        id: "openai",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
        models: ["gpt-5-mini", "gpt-5-mini-low"],
        alias: {
          mini: {
            model: "gpt-5-mini",
            variants: { low: "gpt-5-mini-low" },
          },
        },
      };

      // When
      const result = ProviderMutationBodySchema.parse(body);

      // Then
      expect(result).toMatchObject({
        alias: {
          mini: {
            model: "gpt-5-mini",
            preserve: false,
            variants: { low: { model: "gpt-5-mini-low", preserve: false } },
          },
        },
      });
    });

    test("Given padded alias and variant names When parsed Then keys are normalized", () => {
      const result = ProviderMutationBodySchema.parse({
        kind: "api",
        id: "openai",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
        models: ["gpt-5-mini", "gpt-5"],
        alias: {
          " mini ": {
            model: "gpt-5-mini",
            variants: { " HIGH ": { model: "gpt-5", preserve: false } },
          },
        },
      });

      expect(result.alias).toEqual({
        mini: {
          model: "gpt-5-mini",
          preserve: false,
          variants: { high: { model: "gpt-5", preserve: false } },
        },
      });
    });

    test("Given api mutation body with alias target outside models When parsed Then rejects at alias.mini.model", () => {
      // Given
      const body = {
        kind: "api",
        id: "openai",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
        models: ["gpt-5-mini"],
        alias: { mini: { model: "missing-model" } },
      };

      // When
      const result = ProviderMutationBodySchema.safeParse(body);

      // Then
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["alias", "mini", "model"]);
      }
    });

    test("Given api mutation body with variant target outside models When parsed Then rejects at alias.mini.variants.low.model", () => {
      // Given
      const body = {
        kind: "api",
        id: "openai",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
        models: ["gpt-5-mini"],
        alias: {
          mini: {
            model: "gpt-5-mini",
            variants: { low: "missing-model" },
          },
        },
      };

      // When
      const result = ProviderMutationBodySchema.safeParse(body);

      // Then
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual([
          "alias",
          "mini",
          "variants",
          "low",
          "model",
        ]);
      }
    });

    test("Given normalized duplicate variant keys When parsed Then rejects the duplicate", () => {
      const result = ProviderMutationBodySchema.safeParse({
        kind: "api",
        id: "openai",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
        models: ["gpt-5-mini"],
        alias: {
          mini: {
            model: "gpt-5-mini",
            variants: {
              High: "gpt-5-mini",
              " high ": "gpt-5-mini",
            },
          },
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["alias", "mini", "variants", " high "]);
      }
    });

    test("Given normalized duplicate alias names When parsed Then rejects the duplicate", () => {
      const result = ProviderMutationBodySchema.safeParse({
        kind: "api",
        id: "openai",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
        models: ["gpt-5-mini"],
        alias: {
          mini: "gpt-5-mini",
          " mini ": "gpt-5-mini",
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["alias", " mini "]);
      }
    });

    test("Given an explicit alias conflicting with a preserved model id When parsed Then rejects the alias", () => {
      const result = ProviderMutationBodySchema.safeParse({
        kind: "api",
        id: "openai",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
        models: ["gpt-default", "gpt-raw"],
        alias: {
          "gpt-raw": { model: "gpt-default" },
          mini: { model: "gpt-raw", preserve: true },
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["alias", "gpt-raw"]);
      }
    });

    test("Given repeated preserve declarations for one target When parsed Then accepts them", () => {
      const result = ProviderMutationBodySchema.safeParse({
        kind: "api",
        id: "openai",
        protocol: "openai-response",
        baseURL: "https://api.openai.com",
        models: ["gpt-raw"],
        alias: {
          mini: { model: "gpt-raw", preserve: true },
          fast: { model: "gpt-raw", preserve: true },
        },
      });

      expect(result.success).toBe(true);
    });
  });
});
