import { expect, spyOn, test } from "bun:test";

import { OpenAIResponsesUnsupportedFeatureError, openAIResponsesToModelMessages, parseOpenAIResponses } from "../index";

test("converts custom tool history with reversible metadata", () => {
  const request = parseOpenAIResponses({
    model: "gpt-5.6-terra",
    input: [
      { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", input: "pwd" },
      { type: "custom_tool_call_output", id: "out_1", call_id: "call_1", output: "done" },
    ],
  });

  expect(openAIResponsesToModelMessages(request).messages).toEqual([
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "exec",
          input: { input: "pwd" },
          providerOptions: {
            aioProxy: {
              openaiResponses: {
                protocol: "openai-responses",
                inputIndex: 0,
                itemType: "custom_tool_call",
                itemId: "ctc_1",
                wireToolType: "custom",
                wireToolName: "exec",
              },
            },
          },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "exec",
          output: { type: "text", value: "done" },
          providerOptions: {
            aioProxy: {
              openaiResponses: {
                protocol: "openai-responses",
                inputIndex: 1,
                itemType: "custom_tool_call_output",
                itemId: "out_1",
                wireToolType: "custom",
                wireToolName: "exec",
                outputKind: "string",
              },
            },
          },
        },
      ],
    },
  ]);
});

test("materializes additional custom and namespaced tools", () => {
  const request = parseOpenAIResponses({
    model: "gpt-5.6-terra",
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          { type: "custom", name: "exec" },
          {
            type: "namespace",
            name: "agents",
            tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" }, strict: false }],
          },
        ],
      },
    ],
  });

  expect(openAIResponsesToModelMessages(request).tools).toMatchObject([
    { name: "exec", metadata: { aioProxy: { openaiResponses: { wireToolType: "custom" } } } },
    {
      name: "agents__spawn_agent",
      strict: false,
      metadata: { aioProxy: { openaiResponses: { wireToolName: "spawn_agent", namespace: "agents" } } },
    },
  ]);
});

test("converts reasoning summary and diagnoses encrypted content", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const request = parseOpenAIResponses({
    model: "gpt-5.6-terra",
    input: [
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "secret",
        summary: [{ type: "summary_text", text: "checked" }],
      },
    ],
  });

  try {
    expect(openAIResponsesToModelMessages(request).messages).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "checked",
            providerOptions: {
              aioProxy: {
                openaiResponses: {
                  protocol: "openai-responses",
                  inputIndex: 0,
                  itemType: "reasoning",
                  itemId: "rs_1",
                },
              },
            },
          },
        ],
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[aio-proxy] OpenAI Responses model conversion degraded",
      "reasoning.encrypted_content",
      "input.0.encrypted_content",
      "dropped",
    );
  } finally {
    warn.mockRestore();
  }
});

test("converts agent messages with attribution and diagnoses encrypted content", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const request = parseOpenAIResponses({
    model: "gpt-5.6-terra",
    input: [
      {
        type: "agent_message",
        id: "amsg_1",
        author: "worker",
        recipient: "root",
        content: [
          { type: "input_text", text: "finished" },
          { type: "encrypted_content", encrypted_content: "secret" },
        ],
      },
    ],
  });

  try {
    expect(openAIResponsesToModelMessages(request).messages).toEqual([
      {
        role: "user",
        content: "[agent worker -> root] finished",
        providerOptions: {
          aioProxy: {
            openaiResponses: {
              protocol: "openai-responses",
              inputIndex: 0,
              itemType: "agent_message",
              itemId: "amsg_1",
              author: "worker",
              recipient: "root",
            },
          },
        },
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[aio-proxy] OpenAI Responses model conversion degraded",
      "agent_message.role",
      "input.0.type",
      "converted",
    );
    expect(warn).toHaveBeenCalledWith(
      "[aio-proxy] OpenAI Responses model conversion degraded",
      "agent_message.encrypted_content",
      "input.0.content.1.type",
      "dropped",
    );
  } finally {
    warn.mockRestore();
  }
});

test("rejects raw-only item references on the model path", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const request = parseOpenAIResponses({
    model: "gpt-5.6-terra",
    input: [{ type: "item_reference", id: "item_1" }],
  });

  try {
    expect(() => openAIResponsesToModelMessages(request)).toThrow(
      new OpenAIResponsesUnsupportedFeatureError("item_reference", "input.0.type"),
    );
    expect(warn).toHaveBeenCalledWith(
      "[aio-proxy] OpenAI Responses model conversion degraded",
      "item_reference",
      "input.0.type",
      "rejected",
    );
  } finally {
    warn.mockRestore();
  }
});

test("rewrites a named namespaced function choice to the flattened AI SDK tool key", () => {
  const request = parseOpenAIResponses({
    model: "gpt-5.6-terra",
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "agents",
            tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }],
          },
        ],
      },
    ],
    tool_choice: { type: "function", name: "spawn_agent" },
  });

  expect(openAIResponsesToModelMessages(request).settings.toolChoice).toEqual({
    type: "tool",
    toolName: "agents__spawn_agent",
  });
});

test("rejects structured tool choices that cannot be represented by the AI SDK", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const request = parseOpenAIResponses({
    model: "gpt-5.6-terra",
    input: "hello",
    tool_choice: { type: "allowed_tools", mode: "auto", tools: [] },
  });

  try {
    expect(() => openAIResponsesToModelMessages(request)).toThrow(
      new OpenAIResponsesUnsupportedFeatureError("tool_choice", "tool_choice"),
    );
    expect(warn).toHaveBeenCalledWith(
      "[aio-proxy] OpenAI Responses model conversion degraded",
      "tool_choice",
      "tool_choice",
      "rejected",
    );
  } finally {
    warn.mockRestore();
  }
});
