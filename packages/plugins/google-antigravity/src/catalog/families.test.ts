import { expect, test } from "bun:test";

import { ANTIGRAVITY_FAMILIES, modelCapabilities } from "./families";

test("defines the complete authoritative Antigravity family table", () => {
  expect(ANTIGRAVITY_FAMILIES).toEqual([
    {
      logicalId: "gemini-3.5-flash",
      base: "gemini-3.5-flash-extra-low",
      variants: {
        minimal: "gemini-3.5-flash-extra-low",
        low: "gemini-3.5-flash-extra-low",
        medium: "gemini-3.5-flash-low",
        high: "gemini-3-flash-agent",
      },
      thinking: { mode: "gemini", effortBudgets: { off: 0, minimal: 1000, low: 1000, medium: 4000, high: 10000 } },
    },
    {
      logicalId: "gemini-3.1-pro",
      base: "gemini-3.1-pro-low",
      retired: ["gemini-3.1-pro-high"],
      variants: { low: "gemini-3.1-pro-low", high: "gemini-pro-agent" },
      thinking: { mode: "gemini", effortBudgets: { off: 0, low: 1001, high: 10001 } },
    },
    {
      logicalId: "claude-sonnet-4-6",
      base: "claude-sonnet-4-6",
      variants: { high: "claude-sonnet-4-6", max: "claude-sonnet-4-6" },
      thinking: { mode: "claude", effortBudgets: { low: 4096, medium: 8192, high: 16384, max: 32768 } },
    },
    {
      logicalId: "claude-opus-4-6",
      base: "claude-opus-4-6-thinking",
      variants: { high: "claude-opus-4-6-thinking", max: "claude-opus-4-6-thinking" },
      thinking: { mode: "claude", effortBudgets: { low: 4096, medium: 8192, high: 16384, max: 32768 } },
    },
  ]);
});

test.each([
  ["gemini-3.5-flash-extra-low", "MODEL_PLACEHOLDER_M187", 65_536],
  ["gemini-3.5-flash-low", "MODEL_PLACEHOLDER_M20", 65_536],
  ["gemini-3-flash-agent", "MODEL_PLACEHOLDER_M132", 65_536],
  ["gemini-3.1-pro-low", "MODEL_PLACEHOLDER_M36", 65_535],
  ["gemini-pro-agent", "MODEL_PLACEHOLDER_M16", 65_535],
] as const)("provides the exact Gemini wire profile for %s", (modelId, modelEnum, maxOutputTokens) => {
  expect(modelCapabilities(modelId)).toEqual({ modelEnum, maxOutputTokens });
});

test.each(["claude-sonnet-4-6", "claude-opus-4-6-thinking"])(
  "caps the verified Claude wire profile %s at 64k",
  (modelId) => {
    expect(modelCapabilities(modelId)).toEqual({ maxOutputTokens: 64_000 });
  },
);

test("returns no wire profile for a dynamically discovered unknown model", () => {
  expect(modelCapabilities("future-model")).toBeUndefined();
});

test("does not expose mutable global wire-profile state", () => {
  const profile = modelCapabilities("gemini-3.5-flash-extra-low") as { maxOutputTokens: number };
  try {
    profile.maxOutputTokens = 1;
    expect(modelCapabilities("gemini-3.5-flash-extra-low")).toEqual({
      modelEnum: "MODEL_PLACEHOLDER_M187",
      maxOutputTokens: 65_536,
    });
  } finally {
    profile.maxOutputTokens = 65_536;
  }
});
