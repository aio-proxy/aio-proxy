import { expect, test } from 'bun:test';

import { z } from 'zod';

import {
  GeminiBatchEmbedContentsRequestSchema,
  GeminiEmbedContentRequestSchema,
} from './gemini-embeddings/gemini-embeddings';
import { OpenAICompletionsRequestSchema } from './openai-completions';
import { OpenAIEmbeddingsRequestSchema } from './openai-embeddings/openai-embeddings';
import { OpenAILegacyCompletionsRequestSchema } from './openai-legacy-completions/openai-legacy-completions';

test('OpenAI Completions / Embeddings / Legacy Completions schemas compile', () => {
  expect(() => z.compile(OpenAICompletionsRequestSchema, { strict: true })).not.toThrow();
  expect(() => z.compile(OpenAIEmbeddingsRequestSchema, { strict: true })).not.toThrow();
  expect(() => z.compile(OpenAILegacyCompletionsRequestSchema, { strict: true })).not.toThrow();
});

test('Gemini Embeddings schemas compile', () => {
  expect(() => z.compile(GeminiEmbedContentRequestSchema, { strict: true })).not.toThrow();
  expect(() => z.compile(GeminiBatchEmbedContentsRequestSchema, { strict: true })).not.toThrow();
});
