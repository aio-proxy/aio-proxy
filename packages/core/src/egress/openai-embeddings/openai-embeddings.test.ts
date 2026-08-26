import { expect, test } from 'bun:test';

import { EmbeddingUsageRequiredError } from '../../error';
import { writeOpenAIEmbeddingsResponse } from './openai-embeddings';

test('writes required usage when tokens are present', () => {
  expect(
    writeOpenAIEmbeddingsResponse(
      { embeddings: [[0.1, 0.2]], usage: { tokens: 8 } },
      { modelId: 'text-embedding-3-small' },
    ),
  ).toEqual({
    object: 'list',
    data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 8, total_tokens: 8 },
  });
});

test('throws when result.usage is missing', () => {
  expect(() => writeOpenAIEmbeddingsResponse({ embeddings: [[0.1]] }, { modelId: 'm' })).toThrow(
    EmbeddingUsageRequiredError,
  );
});

test('base64-encodes each vector only when encodingFormat is base64', () => {
  const result = { embeddings: [[1, 0]], usage: { tokens: 1 } } as const;
  const floats = writeOpenAIEmbeddingsResponse(result, { modelId: 'm', encodingFormat: 'float' });
  const encoded = writeOpenAIEmbeddingsResponse(result, { modelId: 'm', encodingFormat: 'base64' });

  expect(floats.data[0]?.embedding).toEqual([1, 0]);
  expect(encoded.data[0]?.embedding).toBe(Buffer.from(Float32Array.from([1, 0]).buffer).toString('base64'));
});
