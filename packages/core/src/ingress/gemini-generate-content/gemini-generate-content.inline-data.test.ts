import { describe, expect, test } from 'bun:test';

import {
  GeminiGenerateContentRequestSchema,
  GeminiInlineDataTooLargeError,
  safeParseGeminiGenerateContent,
} from '../../index';
import { inlineLimitBytes } from './gemini-generate-content.test-support';

describe('GeminiGenerateContentRequestSchema', () => {
  test('Given oversize inlineData When parsed Then result exposes 413-capable error', () => {
    const data = 'A'.repeat(Math.ceil((inlineLimitBytes + 1) / 3) * 4);
    const result = safeParseGeminiGenerateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'image/png', data } }],
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GeminiInlineDataTooLargeError);
      expect(result.error.status).toBe(413);
      expect(result.error.path).toBe('contents.0.parts.0.inlineData.data');
    }
  });

  test('Given oversized invalid base64 When schema parses Then base64 validation still fails', () => {
    const data = `${'A'.repeat(27_962_028)}====`;
    const result = GeminiGenerateContentRequestSchema.safeParse({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'image/png', data } }],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  test('Given oversized valid base64 with double padding When parsed Then actual byte count is exact', () => {
    const actualBytes = inlineLimitBytes + 2;
    const data = `${'A'.repeat(27_962_030)}==`;
    const result = safeParseGeminiGenerateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data } }] }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GeminiInlineDataTooLargeError);
      expect(result.error.actualBytes).toBe(actualBytes);
    }
  });

  test('rejects oversize inlineData nested in functionResponse.parts', () => {
    const data = 'A'.repeat(Math.ceil((inlineLimitBytes + 1) / 3) * 4);
    const result = safeParseGeminiGenerateContent({
      model: 'gemini-3-flash-preview',
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'inspect',
                response: { ok: true },
                parts: [{ inlineData: { mimeType: 'image/png', data } }],
              },
            },
          ],
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GeminiInlineDataTooLargeError);
      expect(result.error.status).toBe(413);
      expect(result.error.path).toBe('contents.0.parts.0.functionResponse.parts.0.inlineData.data');
    }
  });
});
