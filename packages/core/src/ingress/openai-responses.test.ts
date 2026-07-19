import { expect, test } from "bun:test";
import type { OpenAIResponsesRequest } from "../index";
import { OpenAIResponsesUnsupportedFeatureError, parseOpenAIResponses, safeParseOpenAIResponses } from "../index";

test("accepts a developer message", () => {
  const request: OpenAIResponsesRequest = {
    model: "gpt-5.6-terra",
    input: [{ role: "developer", content: "You are a coding agent." }],
  };

  expect(parseOpenAIResponses(request)).toEqual(request);
});

test("accepts function-call history with reasoning", () => {
  const request: OpenAIResponsesRequest = {
    model: "gpt-5.6-terra",
    input: [
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "opaque",
        summary: [{ type: "summary_text", text: "Checked the repository." }],
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "read_file",
        arguments: '{"path":"README.md"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "contents" },
    ],
  };

  expect(parseOpenAIResponses(request)).toEqual(request);
});

test("accepts store true for raw capability selection", () => {
  const request = { model: "gpt-5.6-terra", input: "hello", store: true } as const;

  expect(parseOpenAIResponses(request)).toEqual(request);
});

test("accepts background true for synchronous downgrade", () => {
  const request = { model: "gpt-5.6-terra", input: "hello", background: true } as const;

  expect(parseOpenAIResponses(request)).toEqual(request);
});

test("identifies an unsupported built-in item", () => {
  const result = safeParseOpenAIResponses({
    model: "gpt-5.6-terra",
    input: [{ type: "computer_call", id: "computer_1" }],
  });

  expect(result).toEqual({
    ok: false,
    error: new OpenAIResponsesUnsupportedFeatureError("computer_call", "input.0.type"),
  });
  if (!result.ok && result.error instanceof OpenAIResponsesUnsupportedFeatureError) {
    expect(result.error.status).toBe(501);
  }
});
