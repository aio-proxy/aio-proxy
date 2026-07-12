import { describe, expect, test } from "bun:test";
import type { AnthropicMessagesModelMessages, AnthropicMessagesRequest } from "../../src/index";
import {
  AnthropicMessagesTransformError,
  anthropicMessagesToModelMessages,
  modelMessagesToAnthropicMessages,
  parseAnthropicMessages,
} from "../../src/index";

const fixtureRoot = `${import.meta.dir}/../fixtures/anthropic-messages`;

const validFixtures = [
  "simple.json",
  "with-cache.json",
  "with-thinking.json",
  "multi-tool.json",
  "system-array.json",
] as const;

type FixtureFile = (typeof validFixtures)[number];

async function readFixture(file: FixtureFile): Promise<AnthropicMessagesRequest> {
  return parseAnthropicMessages(await Bun.file(`${fixtureRoot}/${file}`).json());
}

describe("Anthropic Messages transform", () => {
  for (const file of validFixtures) {
    test(`Given ${file} When transformed twice Then it round-trips exactly`, async () => {
      const request = await readFixture(file);

      const converted = anthropicMessagesToModelMessages(request);
      const roundTrip = modelMessagesToAnthropicMessages({
        model: request.model,
        ...converted,
      });

      expect(roundTrip).toEqual(request);
    });
  }

  test("Given thinking content When converted Then signature is byte-equal", async () => {
    const request = await readFixture("with-thinking.json");

    const converted = anthropicMessagesToModelMessages(request);
    const assistant = converted.messages[1];

    expect(assistant).toEqual({
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "I should add the two numbers.",
          providerOptions: { anthropic: { signature: "sig-abc123==" } },
        },
        { type: "text", text: "4" },
      ],
    });
  });

  test("Given multi-tool content When converted Then tool_result stays inside user message", async () => {
    const request = await readFixture("multi-tool.json");

    const converted = anthropicMessagesToModelMessages(request);

    expect(converted.messages[2]).toEqual({
      role: "user",
      content: [
        expect.objectContaining({
          type: "tool-result",
          toolCallId: "toolu_weather",
          toolName: "weather",
        }),
        expect.objectContaining({
          type: "tool-result",
          toolCallId: "toolu_time",
          toolName: "clock",
        }),
        { type: "text", text: "Summarize both." },
      ],
    });
  });

  test("Given model messages without model When reversed Then typed error names path", () => {
    const converted: AnthropicMessagesModelMessages = {
      messages: [{ role: "user", content: "hello" }],
      settings: {},
    };

    expect(() =>
      modelMessagesToAnthropicMessages({
        ...converted,
        model: "",
      }),
    ).toThrow(new AnthropicMessagesTransformError("model"));
  });

  test("Given non-leading system When reversed Then typed error names path", () => {
    expect(() =>
      modelMessagesToAnthropicMessages({
        model: "claude-sonnet-4-5",
        messages: [
          { role: "user", content: "hello" },
          { role: "system", content: "late" },
        ],
        settings: {},
      }),
    ).toThrow(new AnthropicMessagesTransformError("messages.1.role"));
  });

  test("Given reasoning without signature When reversed Then typed error names path", () => {
    expect(() =>
      modelMessagesToAnthropicMessages({
        model: "claude-sonnet-4-5",
        messages: [
          {
            role: "assistant",
            content: [{ type: "reasoning", text: "private" }],
          },
        ],
        settings: {},
      }),
    ).toThrow(new AnthropicMessagesTransformError("messages.0.content.0.providerOptions.anthropic.signature"));
  });

  test("Given unsupported role When reversed Then typed error names path", () => {
    const converted: AnthropicMessagesModelMessages = {
      messages: [{ role: "tool", content: [] }],
      settings: {},
    };

    expect(() =>
      modelMessagesToAnthropicMessages({
        model: "claude-sonnet-4-5",
        ...converted,
      }),
    ).toThrow(new AnthropicMessagesTransformError("messages.0.role"));
  });
});
