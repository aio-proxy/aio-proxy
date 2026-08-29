import { expect, spyOn, test } from 'bun:test';

import type { CredentialPort, ModelCatalog } from '@aio-proxy/plugin-sdk';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

import { AgentClientMessageSchema, AgentServerMessageSchema, InteractionUpdateSchema } from '../gen/agent_pb';
import type { CursorCredential } from '../schema';
import type { CursorH2Stream, CursorTransport } from '../wire/transport';
import { createCursorRuntime } from './runtime';

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

test('discovered model metadata reaches Cursor model details and requested model', async () => {
  const writes: Uint8Array[] = [];
  const turnEnded = create(AgentServerMessageSchema, {
    message: {
      case: 'interactionUpdate',
      value: create(InteractionUpdateSchema, { message: { case: 'turnEnded', value: {} } } as never),
    },
  });
  const metadataTransport: CursorTransport = {
    openRun: () =>
      Promise.resolve({
        write: (frame) => writes.push(frame),
        end: () => {},
        close: () => {},
        frames: (async function* () {
          yield { flags: 0, payload: toBinary(AgentServerMessageSchema, turnEnded) };
        })(),
        trailers: Promise.resolve({ 'grpc-status': '0' }),
      }),
    unary: () => Promise.reject(new Error('unused')),
  };
  const metadataCatalog: ModelCatalog = {
    ...catalog,
    language: [
      {
        id: 'wire-model',
        displayName: 'Display Model',
        extra: { displayModelId: 'display-model', maxMode: true },
      },
    ],
  };
  const result = await createCursorRuntime(
    { credentials, options: {}, catalog: metadataCatalog, fetch: globalThis.fetch },
    { transport: metadataTransport },
  );
  const response = await result.provider.languageModel('wire-model').doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  });
  const reader = response.stream.getReader();
  while (!(await reader.read()).done) {}

  const client = fromBinary(AgentClientMessageSchema, writes[0]!.subarray(5));
  if (client.message.case !== 'runRequest') throw new Error('expected run request');
  expect(client.message.value.modelDetails).toMatchObject({
    modelId: 'wire-model',
    displayModelId: 'display-model',
    maxMode: true,
  });
  expect(client.message.value.requestedModel).toMatchObject({ modelId: 'wire-model', maxMode: true });
});
