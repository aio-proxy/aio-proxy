import { expect, test } from "bun:test";
import type { ModelCatalog } from "@aio-proxy/plugin-sdk";
import { defaultAntigravityAliases } from "./aliases";

test("emits only aliases and variants whose wire targets were discovered", () => {
  const aliases = defaultAntigravityAliases(catalog("gemini-3.5-flash-extra-low", "gemini-3-flash-agent"));
  expect(aliases["gemini-3.5-flash"]).toEqual({
    model: "gemini-3.5-flash-extra-low",
    preserve: false,
    variants: {
      minimal: { model: "gemini-3.5-flash-extra-low", preserve: false },
      low: { model: "gemini-3.5-flash-extra-low", preserve: false },
      high: { model: "gemini-3-flash-agent", preserve: false },
    },
  });
  expect(aliases["gemini-3.5-flash"]?.variants).not.toHaveProperty("medium");
});

test("omits a family when its base wire target is unavailable", () => {
  const aliases = defaultAntigravityAliases(catalog("gemini-3-flash-agent", "gemini-pro-agent"));
  expect(aliases).not.toHaveProperty("gemini-3.5-flash");
  expect(aliases).not.toHaveProperty("gemini-3.1-pro");
});

test("emits complete first-login aliases for the verified snapshot", () => {
  const aliases = defaultAntigravityAliases(
    catalog(
      "gemini-3.5-flash-extra-low",
      "gemini-3.5-flash-low",
      "gemini-3-flash-agent",
      "gemini-3.1-pro-low",
      "gemini-pro-agent",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
    ),
  );
  expect(Object.keys(aliases)).toEqual(["gemini-3.5-flash", "gemini-3.1-pro", "claude-sonnet-4-6", "claude-opus-4-6"]);
  expect(aliases["gemini-3.1-pro"]?.variants).toEqual({
    low: { model: "gemini-3.1-pro-low", preserve: false },
    high: { model: "gemini-pro-agent", preserve: false },
  });
});

function catalog(...ids: string[]): ModelCatalog {
  return {
    language: ids.map((id) => ({ id })),
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
}
