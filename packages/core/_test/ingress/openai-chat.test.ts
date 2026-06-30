import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import { OpenAIChatRequestSchema, parseOpenAIChat } from "../../src/index";

const fixtureRoot = `${import.meta.dir}/../fixtures/openai-chat`;

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

describe("OpenAIChatRequestSchema", () => {
  for (const file of validFixtures) {
    test(`parses ${file}`, async () => {
      const input = await readFixture(file);

      expect(parseOpenAIChat(input)).toEqual(input);
    });
  }

  for (const fixture of invalidFixtures) {
    test(`rejects ${fixture.file} at ${fixture.path.join(".")}`, async () => {
      const input = await readFixture(fixture.file);
      const result = OpenAIChatRequestSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual(
          fixture.path,
        );
      }
    });
  }

  test("parseOpenAIChat throws ZodError on invalid input", async () => {
    const input = await readFixture("invalid-role.json");

    expect(() => parseOpenAIChat(input)).toThrow(ZodError);
  });
});
