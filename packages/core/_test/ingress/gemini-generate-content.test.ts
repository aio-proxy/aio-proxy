import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";

import {
  GeminiGenerateContentRequestSchema,
  GeminiInlineDataTooLargeError,
  parseGeminiGenerateContent,
  safeParseGeminiGenerateContent,
} from "../../src/index";

const fixtureRoot = `${import.meta.dir}/../fixtures/gemini-generate-content`;
const inlineLimitBytes = 20 * 1024 * 1024;

const validFixtures = [
  "simple-text.json",
  "system-instruction.json",
  "inline-data-vision.json",
  "function-call.json",
  "function-response-tools-safety.json",
] as const;

async function readFixture(file: string): Promise<unknown> {
  return await Bun.file(`${fixtureRoot}/${file}`).json();
}

describe("GeminiGenerateContentRequestSchema", () => {
  for (const file of validFixtures) {
    test(`Given ${file} When parsed Then value is preserved`, async () => {
      const input = await readFixture(file);

      expect(parseGeminiGenerateContent(input)).toEqual(input);
    });
  }

  test("Given invalid role When parsed Then schema rejects role path", () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      model: "gemini-2.5-flash",
      contents: [{ role: "assistant", parts: [{ text: "bad" }] }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["contents", 0, "role"]);
    }
  });

  test("Given missing model When parsed Then schema rejects model path", () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["model"]);
    }
  });

  test("Given invalid part union When parsed Then schema rejects part", () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "hello",
              inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" },
            },
          ],
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["contents", 0, "parts", 0]);
    }
  });

  test("Given oversize inlineData When parsed Then result exposes 413-capable error", () => {
    const data = "A".repeat(Math.ceil((inlineLimitBytes + 1) / 3) * 4);
    const result = safeParseGeminiGenerateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType: "image/png", data } }],
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GeminiInlineDataTooLargeError);
      expect(result.error.status).toBe(413);
      expect(result.error.path).toBe("contents.0.parts.0.inlineData.data");
    }
  });

  test("parseGeminiGenerateContent throws ZodError on malformed input", () => {
    expect(() =>
      parseGeminiGenerateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ unknown: true }] }],
      }),
    ).toThrow(ZodError);
  });
});
