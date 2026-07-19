import { expect, test } from "bun:test";

import { ANTIGRAVITY_FAMILIES } from "../catalog/families";
import { applyAntigravityThinking, geminiThinkingConfig } from "./thinking";

test.each([
  ["low", 4096],
  ["medium", 8192],
  ["high", 16384],
  ["max", 32768],
] as const)("maps Claude 4.6 adaptive %s", (effort, budget) => {
  expect(applyAntigravityThinking("claude-opus-4-6-thinking", { mode: "adaptive", effort })).toEqual({
    thinkingBudget: budget,
    includeThoughts: true,
  });
});

test.each([
  [{ mode: "disabled" }, { thinkingBudget: 0, includeThoughts: false }],
  [
    { mode: "fixed", budgetTokens: 2048 },
    { thinkingBudget: 2048, includeThoughts: true },
  ],
] as const)("maps Anthropic literal thinking %#", (thinking, expected) => {
  expect(applyAntigravityThinking("claude-sonnet-4-6", thinking)).toEqual(expected);
});

test.each([
  ["gemini-3.5-flash-extra-low", "MINIMAL", 1000],
  ["gemini-3.5-flash-extra-low", "LOW", 1000],
  ["gemini-3.5-flash-low", "MEDIUM", 4000],
  ["gemini-3-flash-agent", "HIGH", 10000],
  ["gemini-3.1-pro-low", "LOW", 1001],
  ["gemini-pro-agent", "HIGH", 10001],
] as const)("maps Gemini %s %s to CCA budget", (modelId, thinkingLevel, thinkingBudget) => {
  expect(geminiThinkingConfig(modelId, { thinkingLevel })).toEqual({
    thinkingBudget,
    includeThoughts: true,
  });
});

test("maps Gemini off without a thought summary", () => {
  expect(geminiThinkingConfig("gemini-3.5-flash-extra-low", { thinkingLevel: "OFF" })).toEqual({
    thinkingBudget: 0,
    includeThoughts: false,
  });
});

test("preserves explicit Gemini thinking siblings after normalization", () => {
  expect(
    geminiThinkingConfig("gemini-3-flash-agent", {
      thinkingLevel: "HIGH",
      vendorMarker: true,
      includeThoughts: false,
    }),
  ).toEqual({ vendorMarker: true, thinkingBudget: 10000, includeThoughts: true });
});

test("rejects an effort that does not select the supplied family wire ID", () => {
  expect(() => geminiThinkingConfig("gemini-3.5-flash-low", { thinkingLevel: "HIGH" })).toThrow();
  expect(() =>
    applyAntigravityThinking("claude-opus-4-6-thinking", { mode: "adaptive", effort: "extreme" } as never),
  ).toThrow();
});

test("thinking efforts resolve to the same wire IDs as the family aliases", () => {
  for (const family of ANTIGRAVITY_FAMILIES) {
    for (const [effort, budget] of Object.entries(family.thinking.effortBudgets)) {
      const wireId = effort === "off" ? family.base : (Reflect.get(family.variants, effort) ?? family.base);
      const config =
        family.thinking.mode === "gemini"
          ? geminiThinkingConfig(wireId, { thinkingLevel: effort.toUpperCase() })
          : applyAntigravityThinking(wireId, { mode: "adaptive", effort } as never);

      expect(config).toEqual({ thinkingBudget: budget, includeThoughts: budget > 0 });
    }
  }
});
