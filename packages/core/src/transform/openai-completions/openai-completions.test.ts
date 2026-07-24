import { describe, expect, test } from "bun:test";

import type { OpenAICompletionsRequest } from "../../index";

import {
  OpenAICompletionsTransformError,
  modelMessagesToOpenAICompletions,
  openAICompletionsToModelMessages,
  parseOpenAICompletions,
} from "../../index";

const fixtureRoot = `${import.meta.dir}/../../../_test/fixtures/openai-completions`;

const validFixtures = [
  "valid-basic.json",
  "valid-system-user.json",
  "valid-content-parts.json",
  "valid-tool-call.json",
  "valid-tool-message.json",
  "valid-options.json",
] as const;

type FixtureFile = (typeof validFixtures)[number];

async function readFixture(file: FixtureFile): Promise<OpenAICompletionsRequest> {
  return parseOpenAICompletions(await Bun.file(`${fixtureRoot}/${file}`).json());
}

function expectedRoundTrip(request: OpenAICompletionsRequest): OpenAICompletionsRequest {
  return {
    ...request,
    tool_choice: undefined,
    max_tokens: undefined,
    max_completion_tokens: request.max_completion_tokens ?? request.max_tokens ?? undefined,
    messages: request.messages.map((message) =>
      Array.isArray(message.content)
        ? { ...message, content: message.content.filter((part) => part.type === "text" || part.type === "image_url") }
        : message,
    ),
  };
}

describe("OpenAI Completions transform", () => {
  for (const file of validFixtures) {
    test(`round-trips ${file}`, async () => {
      const request = await readFixture(file);

      const converted = openAICompletionsToModelMessages(request);
      const roundTrip = modelMessagesToOpenAICompletions({
        model: request.model,
        ...converted,
      });

      expect(roundTrip).toEqual(expectedRoundTrip(request));
    });
  }

  test("preserves conventional user image_url parts", async () => {
    const request = await readFixture("valid-content-parts.json");
    const converted = openAICompletionsToModelMessages(request);

    expect(converted.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Describe this image." },
        {
          type: "file",
          mediaType: "image/png",
          data: { type: "url", url: new URL("https://example.com/image.png") },
        },
      ],
    });
    expect(modelMessagesToOpenAICompletions({ model: request.model, ...converted }).messages[0]?.content).toEqual(
      request.messages[0]?.content,
    );
  });

  test("preserves ordered CPA image_url parts in tool content", () => {
    const request = parseOpenAICompletions({
      model: "gpt-5.6-sol",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "inspect", arguments: "{}" } }],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [
            { type: "text", text: "before" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "high" } },
            { type: "text", text: "after" },
          ],
        },
      ],
    });

    const converted = openAICompletionsToModelMessages(request);
    expect(converted.messages[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
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
                  openai: { imageDetail: "high" },
                  aioProxy: { toolImage: true, trust: expect.any(String) },
                },
              },
              { type: "text", text: "after" },
            ],
          },
        },
      ],
    });
    expect(modelMessagesToOpenAICompletions({ model: request.model, ...converted }).messages[1]).toEqual(
      request.messages[1],
    );
  });

  test("emits every tool result as an ordered Chat message", () => {
    const converted = modelMessagesToOpenAICompletions({
      model: "gpt-5.6-sol",
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "first",
              output: { type: "text", value: "first result" },
            },
            {
              type: "tool-result",
              toolCallId: "call_2",
              toolName: "second",
              output: {
                type: "content",
                value: [
                  {
                    type: "file",
                    mediaType: "image/png",
                    data: { type: "data", data: "AA==" },
                  },
                ],
              },
            },
          ],
        },
      ],
      settings: {},
    });

    expect(converted.messages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "first result" },
      {
        role: "tool",
        tool_call_id: "call_2",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }],
      },
    ]);
  });

  test("rejects tool approval responses that Chat cannot encode", () => {
    expect(() =>
      modelMessagesToOpenAICompletions({
        model: "gpt-5.6-sol",
        messages: [
          {
            role: "tool",
            content: [{ type: "tool-approval-response", approvalId: "approval_1", approved: true }],
          },
        ],
        settings: {},
      }),
    ).toThrow(new OpenAICompletionsTransformError("messages.0.content.0.type"));
  });

  test("rejects a non-HTTP image_url instead of dropping it", () => {
    const request = parseOpenAICompletions({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "file:///tmp/image.png" } }] }],
    });

    expect(() => openAICompletionsToModelMessages(request)).toThrow(
      new OpenAICompletionsTransformError("messages.0.content.0.image_url.url"),
    );
  });

  test("rejects an OpenAI file reference that Chat cannot encode", () => {
    expect(() =>
      modelMessagesToOpenAICompletions({
        model: "gpt-5.6-sol",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "image",
                data: { type: "reference", reference: { openai: "file_123" } },
              },
            ],
          },
        ],
        settings: {},
      }),
    ).toThrow(new OpenAICompletionsTransformError("messages.0.content.0.data"));
  });

  test("infers tool result names from preceding assistant tool calls", async () => {
    const request = await readFixture("valid-tool-message.json");

    const { messages } = openAICompletionsToModelMessages(request);

    expect(messages[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "lookup",
          output: { type: "text", value: '{"ok":true}' },
        },
      ],
    });
  });

  test("maps developer messages to system messages", () => {
    const request = parseOpenAICompletions({
      model: "gpt-5.5",
      messages: [
        { role: "developer", content: "You are a helpful assistant." },
        { role: "user", content: "Hello!" },
      ],
    });

    expect(openAICompletionsToModelMessages(request).messages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    });
  });

  test("throws field path when tool call function name is missing", () => {
    const request = {
      model: "gpt-5-mini",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_missing",
              type: "function",
              function: {
                arguments: "{}",
              },
            },
          ],
        },
      ],
    };

    expect(() => openAICompletionsToModelMessages(request as OpenAICompletionsRequest)).toThrow(
      "messages.0.tool_calls.0.function.name",
    );
  });
});
