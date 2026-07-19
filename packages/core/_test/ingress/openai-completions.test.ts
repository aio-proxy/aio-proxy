import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";

import { OpenAICompletionsRequestSchema, parseOpenAICompletions } from "../../src/index";

const fixtureRoot = `${import.meta.dir}/../fixtures/openai-completions`;

const validFixtures = [
  "valid-basic.json",
  "valid-system-user.json",
  "valid-content-parts.json",
  "valid-tool-call.json",
  "valid-tool-message.json",
  "valid-options.json",
] as const;

const invalidFixtures = [
  { file: "invalid-role.json", path: ["messages", 0, "role"] },
  { file: "invalid-model.json", path: ["model"] },
  { file: "invalid-tool-name.json", path: ["tools", 0, "function", "name"] },
] as const;

async function readFixture(file: string): Promise<unknown> {
  return await Bun.file(`${fixtureRoot}/${file}`).json();
}

describe("OpenAICompletionsRequestSchema", () => {
  for (const file of validFixtures) {
    test(`parses ${file}`, async () => {
      const input = await readFixture(file);

      expect(parseOpenAICompletions(input)).toEqual(input);
    });
  }

  for (const fixture of invalidFixtures) {
    test(`rejects ${fixture.file} at ${fixture.path.join(".")}`, async () => {
      const input = await readFixture(fixture.file);
      const result = OpenAICompletionsRequestSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual(fixture.path);
      }
    });
  }

  test.each(["none", "minimal", "xhigh"])("accepts current reasoning effort %s", (reasoningEffort) => {
    const result = OpenAICompletionsRequestSchema.safeParse({
      model: "gpt-5",
      messages: [{ role: "user", content: "Hello" }],
      reasoning_effort: reasoningEffort,
    });

    expect(result.success).toBe(true);
  });

  test("parseOpenAICompletions throws ZodError on invalid input", async () => {
    const input = await readFixture("invalid-role.json");

    expect(() => parseOpenAICompletions(input)).toThrow(ZodError);
  });
});
