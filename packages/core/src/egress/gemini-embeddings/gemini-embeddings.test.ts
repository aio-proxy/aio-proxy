import { expect, test } from 'bun:test';

import { writeGeminiEmbeddingsResponse } from './gemini-embeddings';

test('single convert egress writes usageMetadata when usage is present and omits it when absent', () => {
  expect(writeGeminiEmbeddingsResponse({ embeddings: [[0.1, 0.2]], usage: { tokens: 8 } }, { modelId: 'm' })).toEqual({
    embedding: { values: [0.1, 0.2] },
    usageMetadata: { promptTokenCount: 8 },
  });
  expect(writeGeminiEmbeddingsResponse({ embeddings: [[0.1, 0.2]] }, { modelId: 'm' })).toEqual({
    embedding: { values: [0.1, 0.2] },
  });
});

test('batch convert egress writes embeddings and the same usage present/absent rule', () => {
  expect(
    writeGeminiEmbeddingsResponse(
      { embeddings: [[0.1], [0.2]], usage: { tokens: 8 } },
      { modelId: 'm', action: 'batchEmbedContents' },
    ),
  ).toEqual({
    embeddings: [{ values: [0.1] }, { values: [0.2] }],
    usageMetadata: { promptTokenCount: 8 },
  });
  expect(
    writeGeminiEmbeddingsResponse({ embeddings: [[0.1], [0.2]] }, { modelId: 'm', action: 'batchEmbedContents' }),
  ).toEqual({
    embeddings: [{ values: [0.1] }, { values: [0.2] }],
  });
});
