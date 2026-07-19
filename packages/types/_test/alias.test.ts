import { describe, expect, test } from "bun:test";

import { normalizeAliasName, normalizeVariantKey, resolveAliasTarget } from "../src/index";

describe("alias helpers", () => {
  test("Given an alias name When normalized Then trims without changing case", () => {
    expect(normalizeAliasName("  GPT-Mini  ")).toBe("GPT-Mini");
  });

  test("Given a variant key When normalized Then trims and lowercases it", () => {
    expect(normalizeVariantKey("  XHigh  ")).toBe("xhigh");
  });

  test("Given a matching variant When resolving Then returns its target", () => {
    const target = resolveAliasTarget(
      {
        model: "model-default",
        preserve: false,
        variants: {
          " High ": { model: "model-high", preserve: true },
        },
      },
      "HIGH",
    );

    expect(target).toEqual({ model: "model-high", preserve: true });
  });

  test("Given no matching variant When resolving Then returns the default target", () => {
    const target = resolveAliasTarget(
      {
        model: "model-default",
        preserve: true,
        variants: {
          low: { model: "model-low", preserve: false },
        },
      },
      "medium",
    );

    expect(target).toEqual({ model: "model-default", preserve: true });
  });
});
