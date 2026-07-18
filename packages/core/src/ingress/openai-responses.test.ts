import { expect, spyOn, test } from "bun:test";
import type { OpenAIResponsesRequest } from "../index";
import { parseOpenAIResponses } from "../index";

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

test("logs and ignores unsupported input items", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const additionalTools = { type: "additional_tools", role: "developer", tools: [] };
  const computerCall = { type: "computer_call", id: "computer_1" };

  try {
    expect(
      parseOpenAIResponses({
        model: "gpt-5.6-terra",
        input: [{ role: "user", content: "hello" }, additionalTools, computerCall],
      }).input,
    ).toEqual([{ role: "user", content: "hello" }]);
    expect(warn).toHaveBeenCalledWith("[aio-proxy] Unsupported OpenAI Responses input item", "additional_tools");
    expect(warn).toHaveBeenCalledWith("[aio-proxy] Unsupported OpenAI Responses input item", "computer_call");
  } finally {
    warn.mockRestore();
  }
});
