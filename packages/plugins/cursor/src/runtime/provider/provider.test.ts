import { expect, spyOn, test } from 'bun:test';

import type { CredentialPort, ModelCatalog } from '@aio-proxy/plugin-sdk';

import { createCursorRuntime } from '..';
import type { CursorCredential } from '../../schema';
import type { CursorH2Stream, CursorTransport } from '../../wire/transport';

const catalog: ModelCatalog = {
  language: [{ id: 'claude-4.5-sonnet', displayName: 'Claude 4.5 Sonnet' }],
  image: [],
  embedding: [],
  speech: [],
  transcription: [],
  reranking: [],
};

const credential: CursorCredential = {
  accessToken: 'tok',
  refreshToken: 'r',
  expiresAt: Number.MAX_SAFE_INTEGER,
  subject: 'user-1',
};
const credentials: CredentialPort<CursorCredential> = {
  read: () => Promise.resolve({ value: credential, revision: 0 }),
  refresh: () => Promise.resolve({ status: 'updated', snapshot: { value: credential, revision: 1 } }),
};

const transport: CursorTransport = {
  openRun: () => {
    const stream: CursorH2Stream = {
      write: () => {},
      end: () => {},
      close: () => {},
      frames: (async function* () {})(),
      trailers: Promise.resolve({ 'grpc-status': '0' }),
    };
    return Promise.resolve(stream);
  },
  unary: () => Promise.reject(new Error('unused')),
};

test('createCursorRuntime returns a v4 provider and rejects unsupported surfaces', async () => {
  const result = await createCursorRuntime(
    { credentials, options: {}, catalog, fetch: globalThis.fetch },
    { transport },
  );
  expect(result.provider.specificationVersion).toBe('v4');
  expect(result.raw).toBeUndefined();
  expect(result.tokenCount).toBeUndefined();
  expect(() => result.provider.embeddingModel('x')).toThrow(/embedding/i);
  expect(() => result.provider.languageModel('missing')).toThrow(/missing/);
  expect(result.provider.languageModel('claude-4.5-sonnet').provider).toBe('cursor-oauth');
});

test('credential refresh uses the runtime context fetch as control traffic', async () => {
  const stale = { ...credential, expiresAt: 0 };
  const refreshable: CredentialPort<CursorCredential> = {
    read: () => Promise.resolve({ value: stale, revision: 0 }),
    refresh: async (revision, exchange) => {
      const exchanged = await exchange({ value: stale, revision }, new AbortController().signal);
      return { status: 'updated', snapshot: { value: exchanged.value, revision: revision + 1 } };
    },
  };
  const requests: RequestInit[] = [];
  const globalFetch = spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json({ accessToken: 'global-fetch-must-not-be-used' }),
  );
  try {
    const result = await createCursorRuntime(
      {
        credentials: refreshable,
        options: {},
        catalog,
        fetch: async (_input, init) => {
          requests.push(init ?? {});
          return Response.json({ accessToken: 'refreshed' });
        },
      },
      { transport },
    );
    await result.provider.languageModel('claude-4.5-sonnet').doStream({ prompt: [] });
    expect(requests).toEqual([expect.objectContaining({ aioProxy: { traffic: 'control' } })]);
  } finally {
    globalFetch.mockRestore();
  }
});
