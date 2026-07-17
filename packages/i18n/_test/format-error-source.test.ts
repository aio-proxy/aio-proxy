import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("formatUserError source", () => {
  test("does not call setLocale in source", () => {
    // Given
    const source = readFileSync("packages/i18n/src/format-error.ts", "utf8");

    // When / Then
    expect(source).not.toContain("setLocale(");
  });
});
