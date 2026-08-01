import { expect, test } from 'bun:test';

import { create, toBinary } from '@bufbuild/protobuf';

import { GetUsableModelsResponseSchema } from '../gen/agent_pb';
import { frameConnectMessage } from '../wire/frame';
import { CursorCatalogError, discoverCursorModels, initialCursorCatalogFallback } from './discover';

const framed = (ids: string[]) =>
  frameConnectMessage(
    toBinary(
      GetUsableModelsResponseSchema,
      create(GetUsableModelsResponseSchema, { models: ids.map((id) => ({ modelId: id })) }),
    ),
  );

const transportWith = (status: number, body: Uint8Array) => ({
  openRun: () => Promise.reject(new Error('unused')),
  unary: () => Promise.resolve({ status, body }),
});

test('returns non-empty language models on success', async () => {
  const catalog = await discoverCursorModels({
    accessToken: 't',
    transport: transportWith(200, framed(['claude-4.5-sonnet'])) as never,
  });
  expect(catalog.language.map((m) => m.id)).toContain('claude-4.5-sonnet');
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
