import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import type { OpenAIResponsesRequest } from "../../index";
import { OpenAIResponsesRequestSchema, parseOpenAIResponses } from "../../index";

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

  test("Given a malformed known item When parsed Then validation fails", () => {
    expect(() =>
      parseOpenAIResponses({
        model: "gpt-5-mini",
        input: [{ type: "custom_tool_call", call_id: "call_1", name: "exec" }],
      }),
    ).toThrow();
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

  test.each(["none", "xhigh"])("Given current reasoning effort %s When parsed Then request is accepted", (effort) => {
    const result = OpenAIResponsesRequestSchema.safeParse({
      model: "gpt-5",
      input: "Hello",
      reasoning: { effort },
    });

    expect(result.success).toBe(true);
  });

  test("Given session fields When parsed Then fields are preserved", () => {
    const result = parseOpenAIResponses({
      model: "gpt-5-mini",
      input: "x",
      conversation: { id: "conversation-1", extra: true },
      prompt_cache_key: "cache-1",
      previous_response_id: "response-1",
      metadata: { session_id: "metadata-session", conversation_id: "metadata-conversation", extra: true },
      session_id: "session-1",
      conversation_id: "conversation-2",
    });

    expect(result).toMatchObject({
      conversation: { id: "conversation-1", extra: true },
      prompt_cache_key: "cache-1",
      previous_response_id: "response-1",
      metadata: { session_id: "metadata-session", conversation_id: "metadata-conversation", extra: true },
      session_id: "session-1",
      conversation_id: "conversation-2",
    });
  });

  test.each([
    "web_search",
    "web_search_preview",
    "file_search",
    "computer_use",
    "computer-use",
    "image_generation",
  ])("Given raw-only %s tool When parsed Then it is retained", (toolType) => {
    const input = {
      model: "gpt-5-mini",
      input: "x",
      tools: [{ type: toolType }],
    };

    expect(parseOpenAIResponses(input)).toEqual({
      ...input,
      tools: [{ type: "__aio_proxy_unsupported_tool__", wireType: toolType }],
    });
  });
});
