import { expect, test } from "bun:test";
import { validThoughtSignature } from "./signatures";

test("accepts signatures with at least fifty characters", () => {
  expect(validThoughtSignature("claude-opus-4-6-thinking", "s".repeat(50))).toBe(true);
  expect(validThoughtSignature("claude-opus-4-6-thinking", "s".repeat(49))).toBe(false);
  expect(validThoughtSignature("claude-opus-4-6-thinking", 50)).toBe(false);
});

test("accepts the skip sentinel only for Gemini models", () => {
  expect(validThoughtSignature("gemini-3-flash-agent", "skip_thought_signature_validator")).toBe(true);
  expect(validThoughtSignature("claude-opus-4-6-thinking", "skip_thought_signature_validator")).toBe(false);
});
