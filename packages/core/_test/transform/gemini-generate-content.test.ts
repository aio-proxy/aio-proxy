import { describe, expect, test } from "bun:test";
import type {
  GeminiGenerateContentModelMessages,
  GeminiGenerateContentRequest,
} from "../../src/index";
import {
  GeminiGenerateContentTransformError,
  geminiGenerateContentToModelMessages,
  modelMessagesToGeminiGenerateContent,
  parseGeminiGenerateContent,
} from "../../src/index";

const fixtureRoot = `${import.meta.dir}/../fixtures/gemini-generate-content`;

const validFixtures = [
  "simple-text.json",
  "system-instruction.json",
  "inline-data-vision.json",
  "function-call.json",
  "function-response-tools-safety.json",
] as const;

type FixtureFile = (typeof validFixtures)[number];

async function readFixture(
  file: FixtureFile,
): Promise<GeminiGenerateContentRequest> {
  return parseGeminiGenerateContent(
    await Bun.file(`${fixtureRoot}/${file}`).json(),
  );
}

describe("Gemini generateContent transform", () => {
  for (const file of validFixtures) {
    test(`Given ${file} When transformed twice Then it round-trips exactly`, async () => {
      const request = await readFixture(file);

      const converted = geminiGenerateContentToModelMessages(request);
      const roundTrip = modelMessagesToGeminiGenerateContent({
        model: request.model,
        ...converted,
      });

      expect(JSON.stringify(roundTrip)).toBe(JSON.stringify(request));
    });
  }

  test("Given inlineData When converted Then AI SDK file part preserves bytes", async () => {
    const request = await readFixture("inline-data-vision.json");

    const converted = geminiGenerateContentToModelMessages(request);

    expect(converted.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Describe this image." },
        {
          type: "file",
          mediaType: "image/png",
          data: { type: "data", data: "iVBORw0KGgo=" },
        },
      ],
    });
  });

  test("Given functionCall When converted Then AI SDK tool-call part is emitted", async () => {
    const request = await readFixture("function-call.json");

    const converted = geminiGenerateContentToModelMessages(request);

    expect(converted.messages[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "gemini-1-0",
          toolName: "get_weather",
          input: { city: "Tokyo" },
        },
      ],
    });
  });

  test("Given functionResponse and safetySettings When converted Then tool result and google provider options are emitted", async () => {
    const request = await readFixture("function-response-tools-safety.json");

    const converted = geminiGenerateContentToModelMessages(request);

    expect(converted.messages[0]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "gemini-response-get_weather-0-0",
          toolName: "get_weather",
          output: {
            type: "text",
            value: JSON.stringify({
              temperature: "18C",
              condition: "rain",
            }),
          },
        },
      ],
    });
    expect(converted.settings.providerOptions).toEqual({
      google: {
        safetySettings: request.safetySettings,
      },
    });
  });

  test("Given model messages without model When reversed Then typed error names path", () => {
    const converted: GeminiGenerateContentModelMessages = {
      messages: [{ role: "user", content: "hello" }],
      settings: {},
    };

    expect(() =>
      modelMessagesToGeminiGenerateContent({
        ...converted,
        model: "",
      }),
    ).toThrow(new GeminiGenerateContentTransformError("model"));
  });
});
