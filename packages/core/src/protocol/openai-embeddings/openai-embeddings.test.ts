import { expect, test } from 'bun:test';

import { EmbeddingConvertUnsupportedError } from '../../error';
import { parseOpenAIEmbeddings } from '../../ingress/openai-embeddings';
import { openAIEmbeddingsAdapter } from './openai-embeddings';

test('rawRequest rewrites body model and forwards token-id input bytes otherwise', async () => {
  const body = { model: 'alias', input: [1, 2, 3] };
  const raw = new Request('https://x/v1/embeddings', { method: 'POST', body: JSON.stringify(body) });
  const request = parseOpenAIEmbeddings(body);
  const forwarded = await openAIEmbeddingsAdapter.rawRequest(raw, request, 'text-embedding-3-small', {});
  expect(await forwarded.json()).toEqual({ model: 'text-embedding-3-small', input: [1, 2, 3] });
});

test('embeddingInvocation maps string[] and dimensions/user onto openai and openaiCompatible', () => {
  const invocation = openAIEmbeddingsAdapter.embeddingInvocation(
    parseOpenAIEmbeddings({ model: 'm', input: ['a', 'b'], dimensions: 8, user: 'u' }),
    {},
  );
  expect(invocation.values).toEqual([
    {
      value: 'a',
      providerOptions: { openai: { dimensions: 8, user: 'u' }, openaiCompatible: { dimensions: 8, user: 'u' } },
    },
    {
      value: 'b',
      providerOptions: { openai: { dimensions: 8, user: 'u' }, openaiCompatible: { dimensions: 8, user: 'u' } },
    },
  ]);
});

test('embeddingInvocation rejects token-id input for convert', () => {
  expect(() =>
    openAIEmbeddingsAdapter.embeddingInvocation(parseOpenAIEmbeddings({ model: 'm', input: [1, 2] }), {}),
  ).toThrow(EmbeddingConvertUnsupportedError);
});

test('embeddingInvocation sets encodingFormat from encoding_format', () => {
  const invocation = openAIEmbeddingsAdapter.embeddingInvocation(
    parseOpenAIEmbeddings({ model: 'm', input: 'a', encoding_format: 'base64' }),
    {},
  );
  expect(invocation.encodingFormat).toBe('base64');
  expect(invocation.values).toEqual([{ value: 'a' }]);
});
