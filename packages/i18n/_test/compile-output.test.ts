import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { m } from "../src/paraglide/messages";

const generatedFiles = [
  "packages/i18n/src/paraglide/messages.js",
  "packages/i18n/src/paraglide/messages.d.ts",
  "packages/i18n/src/paraglide/runtime.js",
  "packages/i18n/src/paraglide/runtime.d.ts",
] as const;

const compositeOutputFiles = ["packages/i18n/dist/index.js", "packages/i18n/dist/index.d.ts"] as const;

describe("paraglide compile output", () => {
  test("emits runtime and declaration files", () => {
    // Given / When / Then
    for (const file of generatedFiles) {
      expect(existsSync(file)).toBe(true);
    }
  });

  test("emits composite outputs required by downstream project references", () => {
    // Given / When / Then
    for (const file of compositeOutputFiles) {
      expect(existsSync(file)).toBe(true);
    }
  });

  test("emits an aggregated typed m object", () => {
    // Given
    const declaration = readFileSync("packages/i18n/src/paraglide/messages.d.ts", "utf8");
    const indexDeclaration = readFileSync("packages/i18n/src/paraglide/messages/_index.d.ts", "utf8");

    // When / Then
    expect(declaration).toContain("export * as m");
    expect(indexDeclaration).toContain("cli_error_port_out_of_range");
    expect(typeof m.cli_serve_description).toBe("function");
    expect(typeof m.error_provider_not_installed).toBe("function");
    expect(m.cli_error_port_out_of_range({ port: 99_999 })).toContain("99999");
  });
});
