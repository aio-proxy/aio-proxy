import { expect, spyOn, test } from "bun:test";

import {
  OpenAIResponsesUnsupportedFeatureError,
  openAIResponsesToModelMessages,
  parseOpenAIResponses,
} from "../../index";

test("rejects custom call history without a matching custom tool declaration", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const request = parseOpenAIResponses({
    model: "gpt-5.6-terra",
    input: [{ type: "custom_tool_call", call_id: "call_1", name: "exec", input: "pwd" }],
  });

  try {
    expect(() => openAIResponsesToModelMessages(request)).toThrow(
      new OpenAIResponsesUnsupportedFeatureError("custom_tool_call", "input.0.type"),
    );
  } finally {
    warn.mockRestore();
  }
});

test("rejects custom tool formats unsupported by the pinned OpenAI SDK", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const request = parseOpenAIResponses({
    model: "gpt-5.6-terra",
    input: "hello",
    tools: [{ type: "custom", name: "exec", format: { type: "unknown" } }],
  });

  try {
    expect(() => openAIResponsesToModelMessages(request)).toThrow(
      new OpenAIResponsesUnsupportedFeatureError("custom_tool.format", "tools.0.format"),
    );
  } finally {
    warn.mockRestore();
  }
});
