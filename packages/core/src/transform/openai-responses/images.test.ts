import { expect, test } from "bun:test";

import { OpenAIResponsesTransformError, openAIResponsesToModelMessages, parseOpenAIResponses } from "../../index";

test("preserves message data images and OpenAI file references", () => {
  const request = parseOpenAIResponses({
    model: "gpt-5.6-sol",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Compare both." },
          { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "low" },
          { type: "input_image", file_id: "file_123", detail: "high" },
        ],
      },
    ],
  });

  expect(openAIResponsesToModelMessages(request).messages).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "Compare both." },
        {
          type: "file",
          mediaType: "image/png",
          data: { type: "data", data: "AA==" },
          providerOptions: { openai: { imageDetail: "low" } },
        },
        {
          type: "file",
          mediaType: "image",
          data: { type: "reference", reference: { openai: "file_123" } },
          providerOptions: { openai: { imageDetail: "high" } },
        },
      ],
    },
  ]);
});

test("preserves ordered images in function and custom tool outputs", () => {
  const request = parseOpenAIResponses({
    model: "gpt-5.6-sol",
    input: [
      { type: "function_call", call_id: "call_function", name: "inspect", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "call_function",
        output: [
          { type: "input_text", text: "before" },
          { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "low" },
          { type: "input_text", text: "after" },
        ],
      },
      { type: "custom_tool_call", call_id: "call_custom", name: "computer", input: "click" },
      {
        type: "custom_tool_call_output",
        call_id: "call_custom",
        output: [{ type: "input_image", image_url: "https://example.test/screenshot.png" }],
      },
    ],
  });

  const messages = openAIResponsesToModelMessages(request).messages;
  expect(messages[1]).toEqual({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_function",
        toolName: "inspect",
        output: {
          type: "content",
          value: [
            { type: "text", text: "before" },
            {
              type: "file",
              mediaType: "image/png",
              data: { type: "data", data: "AA==" },
              providerOptions: {
                openai: { imageDetail: "low" },
                aioProxy: { toolImage: true },
              },
            },
            { type: "text", text: "after" },
          ],
        },
      },
    ],
  });
  expect(messages[3]).toMatchObject({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_custom",
        toolName: "computer",
        output: {
          type: "content",
          value: [
            {
              type: "file",
              mediaType: "image",
              data: { type: "url", url: new URL("https://example.test/screenshot.png") },
              providerOptions: { aioProxy: { toolImage: true } },
            },
          ],
        },
      },
    ],
  });
});

test("rejects malformed image sources as an invalid Responses request", () => {
  const request = parseOpenAIResponses({
    model: "gpt-5.6-sol",
    input: [{ role: "user", content: [{ type: "input_image", image_url: "file:///tmp/private.png" }] }],
  });

  expect(() => openAIResponsesToModelMessages(request)).toThrow(
    new OpenAIResponsesTransformError("input.0.content.0.image_url"),
  );
});

test("requires exactly one source on every Responses input_image", () => {
  expect(() =>
    parseOpenAIResponses({
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: [{ type: "input_image" }] }],
    }),
  ).toThrow();
  expect(() =>
    parseOpenAIResponses({
      model: "gpt-5.6-sol",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "data:image/png;base64,AA==",
              file_id: "file_123",
            },
          ],
        },
      ],
    }),
  ).toThrow();
});
