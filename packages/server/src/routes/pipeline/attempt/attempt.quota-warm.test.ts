import { expect, test } from 'bun:test';

import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import {
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

const runWith = async (fixture: FakeProvider, warmed: string[]) => {
  const adapter = defineProtocolAdapter(ProviderProtocol.OpenAICompatible);
  const route = defineProviderRouteSource([fixture]);
  const response = await handleProtocolRequest({
    adapter,
    context: createProtocolContext(),
    rawRequest: jsonRequest({ model: REQUESTED_MODEL }),
    source: { ...route.source, warmProviderQuota: (providerId: string) => warmed.push(providerId) },
  });
  expect(response.status).toBe(200);
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
