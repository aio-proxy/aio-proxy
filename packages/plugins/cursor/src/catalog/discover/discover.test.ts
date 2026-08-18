import { expect, test } from 'bun:test';

import { create, toBinary } from '@bufbuild/protobuf';

import { GetUsableModelsResponseSchema } from '../../gen/agent_pb';
import { AvailableModelsResponseSchema } from '../../gen/aiserver_pb';
import { CURSOR_AVAILABLE_MODELS_PATH, CURSOR_GET_USABLE_MODELS_PATH } from '../../wire';
import { frameConnectMessage } from '../../wire/frame';
import { CursorCatalogError, discoverCursorModels, initialCursorCatalogFallback } from './discover';

const framed = (ids: string[]) =>
  frameConnectMessage(
    toBinary(
      GetUsableModelsResponseSchema,
      create(GetUsableModelsResponseSchema, { models: ids.map((id) => ({ modelId: id })) }),
    ),
  );
const framedUsable = framed;

const framedAvailable = () =>
  frameConnectMessage(
    toBinary(
      AvailableModelsResponseSchema,
      create(AvailableModelsResponseSchema, {
        models: [
          {
            name: 'claude-opus-4-8',
            variants: [
              {
                legacySlug: 'claude-opus-4-8-medium',
                isDefaultNonMaxConfig: true,
              },
            ],
          },
        ],
      }),
    ),
  );

const transportWith = (status: number, body: Uint8Array) => ({
  openRun: () => Promise.reject(new Error('unused')),
  unary: ({ path }: { path: string }) =>
    path === CURSOR_GET_USABLE_MODELS_PATH
      ? Promise.resolve({ status, body })
      : Promise.reject(new Error(`unexpected path: ${path}`)),
});

test('returns non-empty language models on success', async () => {
  const catalog = await discoverCursorModels({
    accessToken: 't',
    transport: transportWith(200, framed(['claude-4.5-sonnet'])) as never,
  });
  expect(catalog.language.map((m) => m.id)).toContain('claude-4.5-sonnet');
});

test('preserves discovered display model ID and max mode metadata', async () => {
  const body = frameConnectMessage(
    toBinary(
      GetUsableModelsResponseSchema,
      create(GetUsableModelsResponseSchema, {
        models: [
          {
            modelId: 'wire-model',
            displayModelId: 'display-model',
            displayName: 'Display Model',
            maxMode: true,
          },
        ],
      }),
    ),
  );
  const catalog = await discoverCursorModels({
    accessToken: 't',
    transport: transportWith(200, body) as never,
  });

  expect(catalog.language).toEqual([
    {
      id: 'wire-model',
      displayName: 'Display Model',
      metadata: { displayModelId: 'display-model', maxMode: true },
    },
  ]);
});

test('401 is non-retryable and yields no fallback', async () => {
  const error = await discoverCursorModels({
    accessToken: 't',
    transport: transportWith(401, new Uint8Array()) as never,
  }).catch((e) => e);
  expect(error).toBeInstanceOf(CursorCatalogError);
  expect((error as CursorCatalogError).retryable).toBe(false);
  expect(initialCursorCatalogFallback(error)).toBeUndefined();
});

test('503 is retryable and falls back to the curated catalog', async () => {
  const error = await discoverCursorModels({
    accessToken: 't',
    transport: transportWith(503, new Uint8Array()) as never,
  }).catch((e) => e);
  expect((error as CursorCatalogError).retryable).toBe(true);
  expect(initialCursorCatalogFallback(error)?.language.length ?? 0).toBeGreaterThan(0);
});

test('an empty model directory is non-retryable', async () => {
  const error = await discoverCursorModels({
    accessToken: 't',
    transport: transportWith(200, framed([])) as never,
  }).catch((e) => e);
  expect((error as CursorCatalogError).retryable).toBe(false);
});

test('attaches cursorFamilies when AvailableModels succeeds', async () => {
  const transport = {
    openRun: () => Promise.reject(new Error('unused')),
    unary: async ({ path }: { path: string }) => {
      if (path === CURSOR_GET_USABLE_MODELS_PATH) {
        return { status: 200, body: framedUsable(['claude-opus-4-8-medium']) };
      }
      if (path === CURSOR_AVAILABLE_MODELS_PATH) {
        return { status: 200, body: framedAvailable() };
      }
      return { status: 404, body: new Uint8Array() };
    },
  };
  const catalog = await discoverCursorModels({ accessToken: 't', transport: transport as never });
  expect(catalog.language.map((m) => m.id)).toContain('claude-opus-4-8-medium');
  expect(catalog.metadata).toEqual({
    cursorFamilies: [
      { name: 'claude-opus-4-8', variants: [{ slug: 'claude-opus-4-8-medium', isDefaultNonMax: true }] },
    ],
  });
});

test('AvailableModels failure does not drop GetUsableModels', async () => {
  const transport = {
    openRun: () => Promise.reject(new Error('unused')),
    unary: async ({ path }: { path: string }) => {
      if (path === CURSOR_GET_USABLE_MODELS_PATH) {
        return { status: 200, body: framedUsable(['claude-opus-4-8-medium']) };
      }
      return { status: 503, body: new Uint8Array() };
    },
  };
  const catalog = await discoverCursorModels({ accessToken: 't', transport: transport as never });
  expect(catalog.language.map((m) => m.id)).toContain('claude-opus-4-8-medium');
  expect(catalog.metadata).toBeUndefined();
});
