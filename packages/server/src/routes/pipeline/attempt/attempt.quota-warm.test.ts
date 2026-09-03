import { expect, test } from 'bun:test';

import { APICallError } from '@ai-sdk/provider';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import {
  cancellableTextStream,
  createProtocolContext,
  defineProtocolAdapter,
  defineProviderRouteSource,
  type FakeProvider,
  jsonRequest,
  modelProvider,
  REQUESTED_MODEL,
  textStream,
} from '../../../../__tests__/pipeline-helpers';
import { handleProtocolRequest } from '../index';

const asOAuth = (fixture: FakeProvider): FakeProvider => ({
  ...fixture,
  provider: {
    ...fixture.provider,
    capability: 'default',
    kind: ProviderKind.OAuth,
    plugin: '@aio-proxy/plugin-kimi-code',
  },
});

const send = async (fixture: FakeProvider, warmed: string[], body: Record<string, unknown> = {}) => {
  const adapter = defineProtocolAdapter(ProviderProtocol.OpenAICompatible);
  const route = defineProviderRouteSource([fixture]);
  return await handleProtocolRequest({
    adapter,
    context: createProtocolContext(),
    rawRequest: jsonRequest({ model: REQUESTED_MODEL, ...body }),
    source: { ...route.source, warmProviderQuota: (providerId: string) => warmed.push(providerId) },
  });
};

const runWith = async (fixture: FakeProvider, warmed: string[], expectedStatus = 200) => {
  const response = await send(fixture, warmed);
  expect(response.status).toBe(expectedStatus);
  await response.text();
};

test('a successful attempt warms that OAuth provider quota exactly once', async () => {
  const warmed: string[] = [];
  await runWith(asOAuth(modelProvider({ id: 'kimi', invoke: () => textStream('ok') })), warmed);

  expect(warmed).toEqual(['kimi']);
});

test('a non-OAuth provider is never warmed', async () => {
  const warmed: string[] = [];
  await runWith(modelProvider({ id: 'plain', invoke: () => textStream('ok') }), warmed);

  expect(warmed).toEqual([]);
});

test('a terminal failure does not warm the quota', async () => {
  const warmed: string[] = [];
  await runWith(
    asOAuth(
      modelProvider({
        id: 'kimi',
        invoke: () => {
          throw new APICallError({
            message: 'quota exhausted',
            url: 'https://kimi.example.test',
            requestBodyValues: {},
            statusCode: 402,
            isRetryable: false,
          });
        },
      }),
    ),
    warmed,
    502,
  );

  expect(warmed).toEqual([]);
});

test('a streamed attempt warms only once the body has been delivered', async () => {
  // The attempt returns as soon as the `Response` exists, which for a stream is before upstream has
  // accounted the tokens. Warming there would cache the pre-request balance and then hold it behind the
  // server's read cooldown, so the whole point of the warm is lost.
  const warmed: string[] = [];
  const response = await send(asOAuth(modelProvider({ id: 'kimi', invoke: () => textStream('ok') })), warmed, {
    stream: true,
  });

  expect(response.status).toBe(200);
  expect(warmed).toEqual([]);

  await response.text();
  expect(warmed).toEqual(['kimi']);
});

test('a stream the client abandons still warms for the tokens already spent', async () => {
  const warmed: string[] = [];
  const response = await send(
    asOAuth(modelProvider({ id: 'kimi', invoke: () => cancellableTextStream('ok', () => {}) })),
    warmed,
    { stream: true },
  );

  expect(response.status).toBe(200);
  await response.body?.cancel(new Error('client went away'));
  expect(warmed).toEqual(['kimi']);
});
