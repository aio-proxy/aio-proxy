import { describe, expect, test } from "bun:test";

import type { OpenAIResponsesRequest } from "../index";

import { modelMessagesToOpenAIResponses, openAIResponsesToModelMessages, parseOpenAIResponses } from "../index";

const fixtureRoot = `${import.meta.dir}/../../_test/fixtures/openai-responses`;

type FixtureFile = "string-input.json" | "message-array.json" | "reasoning-tools.json";

async function readFixture(file: FixtureFile): Promise<OpenAIResponsesRequest> {
  return parseOpenAIResponses(await Bun.file(`${fixtureRoot}/${file}`).json());
}

describe("OpenAI Responses transform", () => {
  test("Given string input When transformed Then it becomes one user message", async () => {
    const request = await readFixture("string-input.json");

    expect(openAIResponsesToModelMessages(request).messages).toEqual([{ role: "user", content: "Say pong." }]);
  });

  test("Given text message array When transformed twice Then it round-trips enough for MVP", async () => {
    const request = await readFixture("message-array.json");

    const converted = openAIResponsesToModelMessages(request);
    const roundTrip = modelMessagesToOpenAIResponses({ model: request.model, ...converted });

    expect(roundTrip).toEqual(request);
  });

  test("Given reasoning effort When transformed Then portable reasoning carries it", async () => {
    const request = await readFixture("reasoning-tools.json");

    const converted = openAIResponsesToModelMessages(request);
    const roundTrip = modelMessagesToOpenAIResponses({ model: request.model, ...converted });

    expect(converted.settings.reasoning).toBe("medium");
    expect(converted.settings.providerOptions).toEqual({ openai: { reasoningSummary: "auto" } });
    expect(roundTrip.reasoning).toEqual(request.reasoning);
  });

  test("Given provider options reasoning When transformed Then it is used as a fallback", () => {
    const settings = {
      providerOptions: { openai: { reasoningEffort: "high", reasoningSummary: "detailed" } },
    } as const;

    const request = modelMessagesToOpenAIResponses({
      model: "gpt-5",
      messages: [{ role: "user", content: "Solve this." }],
      settings,
    });

    expect(request.reasoning).toEqual({ effort: "high", summary: "detailed" });
  });

  test("Given portable and provider options reasoning When transformed Then portable settings win", () => {
    const settings = {
      reasoning: "low",
      reasoningSummary: "concise",
      providerOptions: { openai: { reasoningEffort: "high", reasoningSummary: "detailed" } },
    } as const;

    const request = modelMessagesToOpenAIResponses({
      model: "gpt-5",
      messages: [{ role: "user", content: "Solve this." }],
      settings,
    });

    expect(request.reasoning).toEqual({ effort: "low", summary: "concise" });
  });

  test("Given function and custom tools When transformed Then declarations are preserved", async () => {
    const request = await readFixture("reasoning-tools.json");

    const converted = openAIResponsesToModelMessages(request);

    expect(converted.tools).toMatchObject([
      { type: "function", name: "lookup", metadata: { aioProxy: { openaiResponses: { wireToolType: "function" } } } },
      { type: "function", name: "emit_raw", metadata: { aioProxy: { openaiResponses: { wireToolType: "custom" } } } },
    ]);
    expect(modelMessagesToOpenAIResponses({ model: request.model, ...converted }).tools).toEqual(request.tools);
  });

  test("Given additional tools When transformed twice Then they are normalized before messages", () => {
    const request = parseOpenAIResponses({
      model: "gpt-5.6-terra",
      input: [
        { type: "reasoning", summary: [] },
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            { type: "custom", name: "emit_raw", format: { type: "text" } },
            {
              type: "namespace",
              name: "agents",
              tools: [{ type: "function", name: "spawn_agent", strict: false }],
            },
          ],
        },
        { role: "user", content: "after" },
      ],
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      tool_choice: { type: "custom", name: "emit_raw" },
    });

    const converted = openAIResponsesToModelMessages(request);
    const roundTrip = modelMessagesToOpenAIResponses({ model: request.model, ...converted });

    expect(converted.settings.toolChoice).toEqual({ type: "tool", toolName: "emit_raw" });
    expect(roundTrip.input).toEqual([request.input[1], request.input[2]]);
  });
});
