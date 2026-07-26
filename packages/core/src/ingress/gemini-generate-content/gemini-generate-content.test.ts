import { describe, expect, test } from 'bun:test';

import { ZodError } from 'zod';

import { GeminiGenerateContentRequestSchema } from '../../index';
import { parseGeminiGenerateContent, readFixture, validFixtures } from './gemini-generate-content.test-support';

describe('GeminiGenerateContentRequestSchema', () => {
  for (const file of validFixtures) {
    test(`Given ${file} When parsed Then value is preserved`, async () => {
      const input = await readFixture(file);

      expect(parseGeminiGenerateContent(input)).toEqual(input);
    });
  }

  test('Given invalid role When parsed Then schema rejects role path', () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'assistant', parts: [{ text: 'bad' }] }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(['contents', 0, 'role']);
    }
  });

  test('Given missing model When parsed Then schema rejects model path', () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(['model']);
    }
  });

  test('Given invalid part union When parsed Then schema rejects part', () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: 'hello',
              inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
            },
          ],
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(['contents', 0, 'parts', 0]);
    }
  });

  test('parseGeminiGenerateContent throws ZodError on malformed input', () => {
    expect(() =>
      parseGeminiGenerateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ unknown: true }] }],
      }),
    ).toThrow(ZodError);
  });
});
