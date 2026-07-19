import { describe, expect, test } from "bun:test";

import type { OpenAICompletionsRequest } from "../../src/index";

import {
  modelMessagesToOpenAICompletions,
  openAICompletionsToModelMessages,
  parseOpenAICompletions,
} from "../../src/index";

const fixtureRoot = `${import.meta.dir}/../fixtures/openai-completions`;

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
        ? {
            ...message,
            content: message.content.filter((part) => part.type === "text"),
          }
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

  test("documents unsupported content part loss", async () => {
    const request = await readFixture("valid-content-parts.json");

    const roundTrip = modelMessagesToOpenAICompletions({
      model: request.model,
      ...openAICompletionsToModelMessages(request),
    });

    expect(roundTrip.messages[0]?.content).toEqual([{ type: "text", text: "Describe this image." }]);
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
