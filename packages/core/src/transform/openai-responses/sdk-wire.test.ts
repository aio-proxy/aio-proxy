import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { ProviderProtocol } from "@aio-proxy/types";
import { expect, test } from "bun:test";

import { streamAiSdkText } from "../../ai-sdk-bridge";
import { openAIResponsesAdapter } from "../../protocol/openai-responses";

test("preserves custom tool identity through the OpenAI Responses SDK encoder", async () => {
  const parsed = await openAIResponsesAdapter.parse(
    new Request("https://proxy.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: [
          { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", input: "pwd" },
          {
            type: "custom_tool_call_output",
            call_id: "call_1",
            output: [
              { type: "input_text", text: "done" },
              { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "low" },
            ],
          },
          {
            type: "function_call",
            call_id: "call_2",
            name: "lookup",
            arguments: '{"key":"value"}',
          },
          { type: "function_call_output", call_id: "call_2", output: "found" },
        ],
        tools: [
          { type: "custom", name: "exec", format: { type: "text" } },
          { type: "function", name: "lookup", parameters: { type: "object" } },
        ],
        tool_choice: { type: "custom", name: "exec" },
      }),
    }),
    {},
  );
  const invocation = openAIResponsesAdapter.modelInvocationForTarget(
    openAIResponsesAdapter.modelInvocation(parsed, {}),
    ProviderProtocol.OpenAIResponse,
  );
  let body: unknown;
  const model = createOpenAI({
    apiKey: "test",
    fetch: (async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        'data: {"type":"response.completed","response":{"incomplete_details":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof globalThis.fetch,
  }).responses("gpt-5.6-sol");
  const result = streamAiSdkText({
    model,
    messages: invocation.messages,
    ...(invocation.settings === undefined ? {} : { settings: invocation.settings }),
    ...(invocation.tools === undefined ? {} : { tools: invocation.tools }),
  });
  for await (const _part of result.fullStream) {
    // The request body is captured before the synthetic terminal event.
  }
  if (body === undefined) throw new Error("provider did not issue a request");

  expect(body).toMatchObject({
    input: [
      { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", input: "pwd" },
      {
        type: "custom_tool_call_output",
        call_id: "call_1",
        output: [
          { type: "input_text", text: "done" },
          { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "low" },
        ],
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "lookup",
        arguments: '{"key":"value"}',
      },
      { type: "function_call_output", call_id: "call_2", output: "found" },
    ],
    tools: [
      { type: "custom", name: "exec", format: { type: "text" } },
      { type: "function", name: "lookup", parameters: { type: "object" } },
    ],
    tool_choice: { type: "custom", name: "exec" },
  });
});

test("materializes Responses custom tools as portable Anthropic functions", async () => {
  const parsed = await openAIResponsesAdapter.parse(
    new Request("https://proxy.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        input: [
          { type: "custom_tool_call", call_id: "call_1", name: "exec", input: "pwd" },
          { type: "custom_tool_call_output", call_id: "call_1", output: "done" },
        ],
        tools: [{ type: "custom", name: "exec", description: "shell", format: { type: "text" } }],
        tool_choice: { type: "custom", name: "exec" },
      }),
    }),
    {},
  );
  const invocation = openAIResponsesAdapter.modelInvocationForTarget(
    openAIResponsesAdapter.modelInvocation(parsed, {}),
    ProviderProtocol.Anthropic,
  );
  let body: unknown;
  const model = createAnthropic({
    apiKey: "test",
    fetch: (async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_capture","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof globalThis.fetch,
  }).languageModel("claude-sonnet-4-5");
  const result = streamAiSdkText({
    model,
    messages: invocation.messages,
    ...(invocation.settings === undefined ? {} : { settings: invocation.settings }),
    ...(invocation.tools === undefined ? {} : { tools: invocation.tools }),
  });
  for await (const _part of result.fullStream) {
    // The request body is captured before the synthetic terminal event.
  }
  if (body === undefined) throw new Error("provider did not issue a request");

  expect(body).toEqual(
    expect.objectContaining({
      messages: [
        expect.objectContaining({
          role: "assistant",
          content: [expect.objectContaining({ type: "tool_use", id: "call_1", name: "exec", input: { input: "pwd" } })],
        }),
        expect.objectContaining({
          role: "user",
          content: [expect.objectContaining({ type: "tool_result", tool_use_id: "call_1", content: "done" })],
        }),
      ],
      tools: [
        expect.objectContaining({
          name: "exec",
          input_schema: expect.objectContaining({ type: "object" }),
        }),
      ],
      tool_choice: { type: "tool", name: "exec" },
    }),
  );
});
