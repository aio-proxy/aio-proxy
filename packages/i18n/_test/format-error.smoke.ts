import { describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  AliasCollisionError,
  AppError,
  formatUserError,
  ProviderNotInstalledError,
  StaleProviderGenerationError,
} from "../src/index";
import * as runtime from "../src/paraglide/runtime";

describe("formatUserError", () => {
  test("formats provider errors without mutating global locale", () => {
    // Given
    runtime.setLocale("en");
    const err = new ProviderNotInstalledError("@ai-sdk/test");

    // When
    const result = formatUserError(err, "zh-CN");

    // Then
    expect(result.code).toBe("provider_not_installed");
    expect(result.message).toContain("@ai-sdk/test");
    expect(result.message).toContain("尚未安装");
    expect(runtime.getLocale()).toBe("en");
  });

  test("formats alias collision errors with both providers", () => {
    // Given
    const err = new AliasCollisionError("fast", "openai", "groq");

    // When
    const result = formatUserError(err, "en");

    // Then
    expect(result).toEqual({
      code: "alias_collision",
      message:
        "Alias collision: fast is provided by both openai and groq. Rename one or use the provider/alias syntax.",
    });
  });

  test("formats zod errors as stable validation failures", () => {
    // Given
    const parseResult = z.object({ port: z.number().min(1) }).safeParse({
      port: 0,
    });
    expect(parseResult.success).toBe(false);
    if (parseResult.success) {
      throw new Error("expected zod failure");
    }

    // When
    const result = formatUserError(parseResult.error, "en");

    // Then
    expect(result.code).toBe("validation_failed");
    expect(result.message).toContain("Invalid input");
  });

  test("formats Hono HTTPException with stable code", () => {
    // Given
    const err = new HTTPException(404);

    // When
    const result = formatUserError(err, "en");

    // Then
    expect(result.code).toBe("http_exception");
    expect(result.message).toContain("404");
  });

  test("formats custom app errors and stale generation errors", () => {
    // Given / When / Then
    expect(formatUserError(new AppError("config_not_found", "cli_error_config_not_found"), "en")).toEqual({
      code: "config_not_found",
      message: "Config file not found.",
    });

    expect(formatUserError(new StaleProviderGenerationError("openai"), "en")).toEqual({
      code: "stale_provider_generation",
      message: "Provider generation is stale for openai. Regenerate providers.",
    });
  });
});
