import { describe, expect, test } from 'bun:test';

import {
  geminiGenerateContentToModelMessages,
  modelMessagesToGeminiGenerateContent,
  parseGeminiGenerateContent,
} from '../../index';

describe('Gemini generateContent transform', () => {
  test('preserves mixed media and part order in model history', () => {
    const request = parseGeminiGenerateContent({
      model: 'gemini-3-flash-preview',
      contents: [
        {
          role: 'model',
          parts: [
            { text: 'prior answer' },
            { inlineData: { mimeType: 'image/png', data: 'AA==' } },
            { functionCall: { id: 'call_1', name: 'inspect', args: { scope: 'prior' } } },
            { fileData: { mimeType: 'image/png', fileUri: 'https://example.test/prior.png' } },
            { inlineData: { mimeType: 'application/pdf', data: 'AA==' } },
            { text: 'after media' },
          ],
        },
      ],
    });

    const converted = geminiGenerateContentToModelMessages(request);

    expect(converted.messages[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'prior answer' },
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AA==' } },
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'inspect',
          input: { scope: 'prior' },
        },
        {
          type: 'file',
          mediaType: 'image/png',
          data: { type: 'reference', reference: { google: 'https://example.test/prior.png' } },
        },
        { type: 'file', mediaType: 'application/pdf', data: { type: 'data', data: 'AA==' } },
        { type: 'text', text: 'after media' },
      ],
    });
    expect(modelMessagesToGeminiGenerateContent({ model: request.model, ...converted })).toEqual(request);
  });
});
