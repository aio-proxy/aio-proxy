import { expect, test } from "bun:test";

import {
  anthropicMessagesToModelMessages,
  modelMessagesToAnthropicMessages,
  parseAnthropicMessages,
} from "../../index";

test("preserves ordered user and tool-result images as canonical file parts", () => {
  const request = parseAnthropicMessages({
    model: "claude-sonnet-4-5",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "inspect", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "before" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AA==" },
            cache_control: { type: "ephemeral", ttl: "5m" },
          },
          { type: "text", text: "middle" },
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "text", text: "tool-before" },
              { type: "image", source: { type: "url", url: "https://example.test/result.png" } },
              { type: "text", text: "tool-after" },
            ],
          },
        ],
      },
    ],
  });

  const converted = anthropicMessagesToModelMessages(request);
  expect(converted.messages[1]).toEqual({
    role: "user",
    content: [
      { type: "text", text: "before" },
      {
        type: "file",
        mediaType: "image/png",
        data: { type: "data", data: "AA==" },
        providerOptions: {
          anthropic: { cache_control: { type: "ephemeral", ttl: "5m" } },
        },
      },
      { type: "text", text: "middle" },
      {
        type: "tool-result",
        toolCallId: "toolu_1",
        toolName: "inspect",
        output: {
          type: "content",
          value: [
            { type: "text", text: "tool-before" },
            {
              type: "file",
              mediaType: "image/png",
              data: { type: "url", url: new URL("https://example.test/result.png") },
              providerOptions: { aioProxy: { toolImage: true, trust: expect.any(String) } },
            },
            { type: "text", text: "tool-after" },
          ],
        },
      },
    ],
  });
  expect(modelMessagesToAnthropicMessages({ model: request.model, ...converted })).toEqual(request);
});

test("normalizes an Anthropic data URL image source to native base64", () => {
  const request = parseAnthropicMessages({
    model: "claude-sonnet-4-5",
    messages: [
      {
        role: "user",
        content: [{ type: "image", source: { type: "url", url: "data:image/png;base64,AA==" } }],
      },
    ],
  });

  const converted = anthropicMessagesToModelMessages(request);
  expect(converted.messages).toEqual([
    {
      role: "user",
      content: [{ type: "file", mediaType: "image/png", data: { type: "data", data: "AA==" } }],
    },
  ]);
  expect(modelMessagesToAnthropicMessages({ model: request.model, ...converted })).toEqual({
    model: "claude-sonnet-4-5",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AA==" },
          },
        ],
      },
    ],
  });
});
