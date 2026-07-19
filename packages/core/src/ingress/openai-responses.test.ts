import { expect, test } from "bun:test";
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

test("preserves known semantic extension items", () => {
  const input: Extract<OpenAIResponsesRequest["input"], unknown[]> = [
    {
      type: "additional_tools",
      role: "developer",
      tools: [{ type: "custom", name: "exec", format: { type: "text" } }],
    },
    { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", input: "pwd" },
    { type: "custom_tool_call_output", id: "out_1", call_id: "call_1", output: "done" },
    {
      type: "agent_message",
      id: "amsg_1",
      author: "worker",
      recipient: "root",
      content: [{ type: "input_text", text: "finished" }],
    },
  ];

  expect(parseOpenAIResponses({ model: "gpt-5.6-terra", input }).input).toEqual(input);
});

test("retains unknown typed items for raw-only routing", () => {
  const input = [{ type: "computer_call", id: "computer_1" }];

  expect(parseOpenAIResponses({ model: "gpt-5.6-terra", input }).input).toEqual([
    { type: "__aio_proxy_unsupported__", wireType: "computer_call" },
  ]);
});
