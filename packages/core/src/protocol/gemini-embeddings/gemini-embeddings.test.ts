import { expect, test } from 'bun:test';

import { parseGeminiBatchEmbedContents, parseGeminiEmbedContent } from '../../ingress/gemini-embeddings';
import { geminiEmbeddingsAdapter } from './gemini-embeddings';

test('single embed raw always writes body model even when the client omitted it', async () => {
  const raw = new Request('https://x/v1beta/models/alias:embedContent', {
    method: 'POST',
    body: JSON.stringify({ content: { parts: [{ text: 'hi' }] } }),
  });
  const request = parseGeminiEmbedContent({ content: { parts: [{ text: 'hi' }] } });
  const forwarded = await geminiEmbeddingsAdapter.rawRequest(raw, request, 'gemini-embedding-001', {
    model: 'alias',
    action: 'embedContent',
  });
  expect(new URL(forwarded.url).pathname).toBe('/v1beta/models/gemini-embedding-001:embedContent');
  expect(await forwarded.json()).toMatchObject({ model: 'models/gemini-embedding-001' });
});

test('batch raw rewrites every requests[i].model including omitted and leftover aliases', async () => {
  const raw = new Request('https://x/v1beta/models/alias:batchEmbedContents', {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ content: { parts: [{ text: 'a' }] } }, { model: 'models/old', content: { parts: [{ text: 'b' }] } }],
    }),
  });
  const request = parseGeminiBatchEmbedContents(JSON.parse(await raw.clone().text()));
  const forwarded = await geminiEmbeddingsAdapter.rawRequest(raw, request, 'gemini-embedding-001', {
    model: 'alias',
    action: 'batchEmbedContents',
  });
  const body = await forwarded.json();
  expect(body.requests[0].model).toBe('models/gemini-embedding-001');
  expect(body.requests[1].model).toBe('models/gemini-embedding-001');
});

test('maps TASK_TYPE_UNSPECIFIED to omitted and keeps title/autoTruncate for 501 grouping', () => {
  const invocation = geminiEmbeddingsAdapter.embeddingInvocation(
    parseGeminiEmbedContent({
      content: { parts: [{ text: 'hi' }] },
      embedContentConfig: { taskType: 'TASK_TYPE_UNSPECIFIED', title: 'Doc', autoTruncate: true },
    }),
    { model: 'm', action: 'embedContent' },
  );
  expect(invocation.values[0]?.providerOptions?.google).toEqual({ title: 'Doc', autoTruncate: true });
});

test('prefers embedContentConfig over legacy aliases and fills only the missing three', () => {
  const invocation = geminiEmbeddingsAdapter.embeddingInvocation(
    parseGeminiEmbedContent({
      content: { parts: [{ text: 'hi' }] },
      embedContentConfig: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: 4 },
      taskType: 'RETRIEVAL_DOCUMENT',
      title: 'Legacy',
      outputDimensionality: 8,
    }),
    { model: 'm', action: 'embedContent' },
  );
  expect(invocation.values[0]?.providerOptions).toEqual({
    google: { taskType: 'RETRIEVAL_QUERY', title: 'Legacy', outputDimensionality: 4 },
    openai: { dimensions: 4 },
    openaiCompatible: { dimensions: 4 },
  });
});

test('joins text parts with no separator and maps outputDimensionality onto google and openai namespaces', () => {
  const invocation = geminiEmbeddingsAdapter.embeddingInvocation(
    parseGeminiEmbedContent({
      content: { parts: [{ text: 'hel' }, { text: 'lo' }] },
      taskType: 'RETRIEVAL_DOCUMENT',
      outputDimensionality: 8,
    }),
    { model: 'm', action: 'embedContent' },
  );
  expect(invocation.values).toEqual([
    {
      value: 'hello',
      providerOptions: {
        google: { taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 8 },
        openai: { dimensions: 8 },
        openaiCompatible: { dimensions: 8 },
      },
    },
  ]);
});

test('parse injects context.model for single embed and leaves batch body as-is', async () => {
  const single = await geminiEmbeddingsAdapter.parse(
    new Request('https://x/v1beta/models/alias:embedContent', {
      method: 'POST',
      body: JSON.stringify({ content: { parts: [{ text: 'hi' }] } }),
    }),
    { model: 'alias', action: 'embedContent' },
  );
  expect(single).toMatchObject({ model: 'alias', content: { parts: [{ text: 'hi' }] } });

  const batchBody = {
    requests: [{ content: { parts: [{ text: 'a' }] } }, { model: 'models/old', content: { parts: [{ text: 'b' }] } }],
  };
  const batch = await geminiEmbeddingsAdapter.parse(
    new Request('https://x/v1beta/models/alias:batchEmbedContents', {
      method: 'POST',
      body: JSON.stringify(batchBody),
    }),
    { model: 'alias', action: 'batchEmbedContents' },
  );
  expect(batch).toEqual(parseGeminiBatchEmbedContents(batchBody));
});

test('raw rewrite preserves accepted official config fields on the forwarded body', async () => {
  const body = {
    content: { parts: [{ text: 'hi' }] },
    embedContentConfig: { taskType: 'RETRIEVAL_QUERY', title: 'Doc', outputDimensionality: 16, autoTruncate: false },
  };
  const raw = new Request('https://x/v1beta/models/alias:embedContent', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const forwarded = await geminiEmbeddingsAdapter.rawRequest(
    raw,
    parseGeminiEmbedContent(body),
    'gemini-embedding-001',
    { model: 'alias', action: 'embedContent' },
  );
  expect(await forwarded.json()).toEqual({
    model: 'models/gemini-embedding-001',
    content: { parts: [{ text: 'hi' }] },
    embedContentConfig: { taskType: 'RETRIEVAL_QUERY', title: 'Doc', outputDimensionality: 16, autoTruncate: false },
  });
});
