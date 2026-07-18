import { describe, expect, spyOn, test } from "bun:test";
import type { OpenAIResponsesRequest } from "../../index";
import {
  OpenAIResponsesRequestSchema,
  OpenAIResponsesUnsupportedFeatureError,
  parseOpenAIResponses,
  safeParseOpenAIResponses,
} from "../../index";

const fixtureRoot = `${import.meta.dir}/../../../_test/fixtures/openai-responses`;

async function readFixture(file: string): Promise<OpenAIResponsesRequest> {
  return parseOpenAIResponses(await Bun.file(`${fixtureRoot}/${file}`).json());
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

  test("Given unparseable input items When parsed Then they are logged and ignored", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const sensitiveMarker = "secret-role-must-not-be-logged";
    const invalidRole = { role: sensitiveMarker, content: "bad" };
    const invalidContent = { role: "user", content: [{ type: "input_text" }] };

    try {
      expect(
        parseOpenAIResponses({
          model: "gpt-5-mini",
          input: [invalidRole, invalidContent],
        }).input,
      ).toEqual([]);
      expect(warn).toHaveBeenNthCalledWith(1, "[aio-proxy] Unsupported OpenAI Responses input item", "unknown");
      expect(warn).toHaveBeenNthCalledWith(2, "[aio-proxy] Unsupported OpenAI Responses input item", "unknown");
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sensitiveMarker);
    } finally {
      warn.mockRestore();
    }
  });

  test.each(["none", "xhigh"])("Given current reasoning effort %s When parsed Then request is accepted", (effort) => {
    const result = OpenAIResponsesRequestSchema.safeParse({
      model: "gpt-5",
      input: "Hello",
      reasoning: { effort },
    });

    expect(result.success).toBe(true);
  });

  test("Given previous_response_id When safe parsed Then unsupported feature is returned", () => {
    const result = safeParseOpenAIResponses({
      model: "gpt-5-mini",
      input: "x",
      previous_response_id: "r1",
    });

    expect(result).toEqual({
      ok: false,
      error: new OpenAIResponsesUnsupportedFeatureError("previous_response_id", "previous_response_id"),
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
