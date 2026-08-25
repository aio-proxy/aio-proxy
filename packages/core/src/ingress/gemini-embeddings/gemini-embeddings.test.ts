import { expect, test } from 'bun:test';

import { ZodError } from 'zod';

import { parseGeminiBatchEmbedContents, parseGeminiEmbedContent } from './gemini-embeddings';

test('accepts a single text part', () => {
  const parsed = parseGeminiEmbedContent({
    content: { parts: [{ text: 'hello' }] },
  });
  expect(parsed.content.parts).toEqual([{ text: 'hello' }]);
});

test('accepts multiple text parts for later join with no separator', () => {
  const parsed = parseGeminiEmbedContent({
    content: { parts: [{ text: 'ab' }, { text: 'cd' }] },
  });
  expect(parsed.content.parts).toEqual([{ text: 'ab' }, { text: 'cd' }]);
});

test('rejects empty joined text', () => {
  expect(() =>
    parseGeminiEmbedContent({
      content: { parts: [{ text: '' }] },
    }),
  ).toThrow(ZodError);
  expect(() =>
    parseGeminiEmbedContent({
      content: { parts: [{ text: '' }, { text: '' }] },
    }),
  ).toThrow(ZodError);
});

test('rejects non-text parts', () => {
  expect(() =>
    parseGeminiEmbedContent({
      content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'abc' } }] },
    }),
  ).toThrow(ZodError);
  expect(() =>
    parseGeminiEmbedContent({
      content: { parts: [{ text: 'ok' }, { fileData: { mimeType: 'text/plain', fileUri: 'https://x/y' } }] },
    }),
  ).toThrow(ZodError);
});

test('accepts embedContentConfig taskType title outputDimensionality autoTruncate', () => {
  const parsed = parseGeminiEmbedContent({
    content: { parts: [{ text: 'doc' }] },
    embedContentConfig: {
      taskType: 'RETRIEVAL_DOCUMENT',
      title: 'Doc',
      outputDimensionality: 768,
      autoTruncate: true,
    },
  });
  expect(parsed.embedContentConfig).toEqual({
    taskType: 'RETRIEVAL_DOCUMENT',
    title: 'Doc',
    outputDimensionality: 768,
    autoTruncate: true,
  });
});

test('rejects embedContentConfig.audioTrackExtraction rather than stripping it', () => {
  expect(() =>
    parseGeminiEmbedContent({
      content: { parts: [{ text: 'doc' }] },
      embedContentConfig: { audioTrackExtraction: {} },
    }),
  ).toThrow(ZodError);
});

test('rejects embedContentConfig.documentOcr', () => {
  expect(() =>
    parseGeminiEmbedContent({
      content: { parts: [{ text: 'doc' }] },
      embedContentConfig: { documentOcr: {} },
    }),
  ).toThrow(ZodError);
});

test('accepts top-level legacy taskType title outputDimensionality', () => {
  const parsed = parseGeminiEmbedContent({
    content: { parts: [{ text: 'doc' }] },
    taskType: 'RETRIEVAL_QUERY',
    title: 'Legacy title',
    outputDimensionality: 256,
  });
  expect(parsed.taskType).toBe('RETRIEVAL_QUERY');
  expect(parsed.title).toBe('Legacy title');
  expect(parsed.outputDimensionality).toBe(256);
});

test('does not treat top-level autoTruncate as a legacy alias', () => {
  const parsed = parseGeminiEmbedContent({
    content: { parts: [{ text: 'doc' }] },
    autoTruncate: true,
  });
  expect(parsed.embedContentConfig?.autoTruncate).toBeUndefined();
});

test('rejects empty batch requests', () => {
  expect(() => parseGeminiBatchEmbedContents({ requests: [] })).toThrow(ZodError);
});

test('batch item inherits single-item rules', () => {
  expect(() =>
    parseGeminiBatchEmbedContents({
      requests: [{ content: { parts: [{ text: '' }] } }],
    }),
  ).toThrow(ZodError);
  expect(() =>
    parseGeminiBatchEmbedContents({
      requests: [
        { content: { parts: [{ text: 'ok' }] } },
        { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'abc' } }] } },
      ],
    }),
  ).toThrow(ZodError);
});

test('accepts a valid batch embed request', () => {
  const parsed = parseGeminiBatchEmbedContents({
    requests: [
      { content: { parts: [{ text: 'a' }] } },
      { content: { parts: [{ text: 'b' }, { text: 'c' }] }, embedContentConfig: { autoTruncate: false } },
    ],
  });
  expect(parsed.requests).toHaveLength(2);
  expect(parsed.requests[1]?.embedContentConfig?.autoTruncate).toBe(false);
});
