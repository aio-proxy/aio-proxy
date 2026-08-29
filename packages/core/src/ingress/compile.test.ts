import { expect, test } from 'bun:test';

import { z } from 'zod';

import { OpenAICompletionsRequestSchema } from './openai-completions';
import { OpenAIEmbeddingsRequestSchema } from './openai-embeddings/openai-embeddings';
import { OpenAILegacyCompletionsRequestSchema } from './openai-legacy-completions/openai-legacy-completions';

test('OpenAI Completions / Embeddings / Legacy Completions schemas compile', () => {
  expect(() => z.compile(OpenAICompletionsRequestSchema, { strict: true })).not.toThrow();
  expect(() => z.compile(OpenAIEmbeddingsRequestSchema, { strict: true })).not.toThrow();
  expect(() => z.compile(OpenAILegacyCompletionsRequestSchema, { strict: true })).not.toThrow();
});
