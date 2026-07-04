import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import {
  OpenAIResponsesRequestSchema,
  OpenAIResponsesUnsupportedFeatureError,
  parseOpenAIResponses,
  safeParseOpenAIResponses,
} from "../../src/index";

const fixtureRoot = `${import.meta.dir}/../fixtures/openai-responses`;

async function readFixture(file: string): Promise<unknown> {
  return await Bun.file(`${fixtureRoot}/${file}`).json();
}

describe("OpenAIResponsesRequestSchema", () => {
  test("Given string input When parsed Then request is accepted", async () => {
    const input = await readFixture("string-input.json");

    expect(parseOpenAIResponses(input)).toEqual(input);
  });

  test("Given message array with text parts When parsed Then request is accepted", async () => {
    const input = await readFixture("message-array.json");

    expect(parseOpenAIResponses(input)).toEqual(input);
  });

  test("Given function and custom tools When parsed Then declarations are accepted", async () => {
    const input = await readFixture("reasoning-tools.json");

    expect(parseOpenAIResponses(input)).toEqual(input);
  });

  test("Given invalid input role When safe parsed Then Zod path names input", () => {
    const result = OpenAIResponsesRequestSchema.safeParse({
      model: "gpt-5-mini",
      input: [{ role: "tool", content: "bad" }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["input"]);
    }
  });

  test("Given invalid content part When parsed Then ZodError is thrown", () => {
    expect(() =>
      parseOpenAIResponses({
        model: "gpt-5-mini",
        input: [{ role: "user", content: [{ type: "input_text" }] }],
      }),
    ).toThrow(ZodError);
  });

  test.each([
    {
      name: "previous_response_id",
      input: { model: "gpt-5-mini", input: "x", previous_response_id: "r1" },
      path: "previous_response_id",
      feature: "previous_response_id",
    },
    {
      name: "store true",
      input: { model: "gpt-5-mini", input: "x", store: true },
      path: "store",
      feature: "store",
    },
    {
      name: "background true",
      input: { model: "gpt-5-mini", input: "x", background: true },
      path: "background",
      feature: "background",
    },
  ])("Given $name When safe parsed Then unsupported feature is returned", (row) => {
    const result = safeParseOpenAIResponses(row.input);

    expect(result).toEqual({
      ok: false,
      error: new OpenAIResponsesUnsupportedFeatureError(row.feature, row.path),
    });
  });

  test.each([
    "web_search",
    "web_search_preview",
    "file_search",
    "computer_use",
    "computer-use",
    "image_generation",
  ])("Given forbidden %s tool When parsed Then unsupported feature is thrown", (toolType) => {
    const parse = () =>
      parseOpenAIResponses({
        model: "gpt-5-mini",
        input: "x",
        tools: [{ type: toolType }],
      });

    expect(parse).toThrow(new OpenAIResponsesUnsupportedFeatureError(toolType, "tools.0.type"));
  });
});
