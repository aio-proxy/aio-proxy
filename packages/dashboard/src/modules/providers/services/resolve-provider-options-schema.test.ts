import { describe, expect, test } from "@rstest/core";

import { resolveLocalProviderOptionsSchema } from "./resolve-provider-options-schema";

describe("resolveLocalProviderOptionsSchema", () => {
  test("returns ready schema for a catalog package", () => {
    const result = resolveLocalProviderOptionsSchema("@ai-sdk/openai-compatible");
    expect(result.resolution).toBe("ready");
    if (result.resolution !== "ready") throw new Error("expected ready");
    expect(result.schema).toMatchObject({ type: "object" });
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  test("returns unavailable for a non-catalog package", () => {
    const result = resolveLocalProviderOptionsSchema("@vendor/custom-provider");
    expect(result.resolution).toBe("unavailable");
    expect(result.schema).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });
});
