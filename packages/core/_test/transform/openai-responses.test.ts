import { describe, expect, test } from "bun:test";
import type { OpenAIResponsesRequest } from "../../src/index";
import { modelMessagesToOpenAIResponses, openAIResponsesToModelMessages, parseOpenAIResponses } from "../../src/index";

const fixtureRoot = `${import.meta.dir}/../fixtures/openai-responses`;

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
    const roundTrip = modelMessagesToOpenAIResponses({
      model: request.model,
      ...converted,
    });

    expect(roundTrip).toEqual(request);
  });

  test("Given reasoning effort When transformed Then OpenAI provider options carry it", async () => {
    const request = await readFixture("reasoning-tools.json");

    const converted = openAIResponsesToModelMessages(request);

    expect(converted.settings.providerOptions).toEqual({
      openai: {
        reasoningEffort: "medium",
        reasoningSummary: "auto",
      },
    });
  });

  test("Given function and custom tools When transformed Then declarations are preserved", async () => {
    const request = await readFixture("reasoning-tools.json");

    const converted = openAIResponsesToModelMessages(request);

    expect(converted.tools).toEqual([
      {
        type: "function",
        name: "lookup",
        description: "Lookup a value",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      {
        type: "custom",
        name: "emit_raw",
        description: "Emit raw data",
        format: { type: "text" },
      },
    ]);
  });
});
