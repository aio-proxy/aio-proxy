import { expect, test } from 'bun:test';

import { ZodError } from 'zod';

import { parseOpenAIEmbeddings } from './openai-embeddings';

test('accepts a nonempty string and a 2048-item string array', () => {
  expect(parseOpenAIEmbeddings({ model: 'm', input: 'hi' }).input).toBe('hi');
  expect(parseOpenAIEmbeddings({ model: 'm', input: Array.from({ length: 2048 }, () => 'x') }).input).toHaveLength(
    2048,
  );
});

test('rejects empty strings and 2049 string items', () => {
  expect(() => parseOpenAIEmbeddings({ model: 'm', input: '' })).toThrow(ZodError);
  expect(() => parseOpenAIEmbeddings({ model: 'm', input: ['ok', ''] })).toThrow(ZodError);
  expect(() => parseOpenAIEmbeddings({ model: 'm', input: Array.from({ length: 2049 }, () => 'x') })).toThrow(ZodError);
});

test('accepts token-id number[] of 2048 and rejects 2049', () => {
  expect(parseOpenAIEmbeddings({ model: 'm', input: Array.from({ length: 2048 }, (_, i) => i) }).input).toHaveLength(
    2048,
  );
  expect(() => parseOpenAIEmbeddings({ model: 'm', input: Array.from({ length: 2049 }, (_, i) => i) })).toThrow(
    ZodError,
  );
});

test('accepts number[][] up to 2048 outer items', () => {
  expect(parseOpenAIEmbeddings({ model: 'm', input: [[1, 2], [3]] }).input).toEqual([[1, 2], [3]]);
  expect(() => parseOpenAIEmbeddings({ model: 'm', input: Array.from({ length: 2049 }, () => [1]) })).toThrow(ZodError);
});
