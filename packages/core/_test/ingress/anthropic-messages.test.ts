import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import { AnthropicMessagesRequestSchema, parseAnthropicMessages } from "../../src/index";

const fixtureRoot = `${import.meta.dir}/../fixtures/anthropic-messages`;

const validFixtures = [
  "simple.json",
  "with-cache.json",
  "with-thinking.json",
  "multi-tool.json",
  "system-array.json",
] as const;

const invalidInputs = [
  {
    name: "missing model",
    input: { max_tokens: 1, messages: [{ role: "user", content: "hello" }] },
    path: ["model"],
  },
  {
    name: "invalid role",
    input: {
      model: "claude-sonnet-4-5",
      messages: [{ role: "system", content: "hello" }],
    },
    path: ["messages", 0, "role"],
  },
  {
    name: "thinking cache_control",
    input: {
      model: "claude-sonnet-4-5",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "private",
              signature: "sig",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    },
    path: ["messages", 0, "content", 0, "cache_control"],
  },
  {
    name: "tool_result missing tool_use_id",
    input: {
      model: "claude-sonnet-4-5",
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", content: "missing id" }],
        },
      ],
    },
    path: ["messages", 0, "content", 0, "tool_use_id"],
  },
] as const;

async function readFixture(file: string): Promise<unknown> {
  return await Bun.file(`${fixtureRoot}/${file}`).json();
}

describe("AnthropicMessagesRequestSchema", () => {
  for (const file of validFixtures) {
    test(`Given ${file} When parsed Then it is accepted unchanged`, async () => {
      const input = await readFixture(file);

      expect(parseAnthropicMessages(input)).toEqual(input);
    });
  }

  for (const fixture of invalidInputs) {
    test(`Given ${fixture.name} When parsed Then it rejects ${fixture.path.join(".")}`, () => {
      const result = AnthropicMessagesRequestSchema.safeParse(fixture.input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual(fixture.path);
      }
    });
  }

  test("Given invalid input When parseAnthropicMessages is called Then it throws ZodError", () => {
    expect(() => parseAnthropicMessages({})).toThrow(ZodError);
  });
});
