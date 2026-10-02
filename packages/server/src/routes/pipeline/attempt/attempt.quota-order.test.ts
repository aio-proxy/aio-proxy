import { expect, test } from 'bun:test';

import { openAIResponsesAdapter } from '@aio-proxy/core';
import type { OAuthQuotaItem } from '@aio-proxy/plugin-sdk';
import { ConfigSchema, ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import {
  createProtocolContext,
  defineProtocolAdapter,
  defineProviderRouteSource,
  type FakeProvider,
  jsonRequest,
  modelProvider,
  REQUESTED_MODEL,
  settleRecording,
  textStream,
} from '../../../../__tests__/pipeline-helpers';
import { LogicalSessionStore } from '../../../logical-session-store';
import type { OAuthQuotaCacheStatus } from '../../../plugin-quota';
import type { ProviderRouteSource } from '../../../runtime';
import { handleProtocolRequest } from '../index';

const DAY = 24 * 60 * 60_000;

const subscription = (id: string): FakeProvider => {
  const fixture = modelProvider({ id, invoke: () => textStream(id) });
  return {
    ...fixture,
    provider: {
      ...fixture.provider,
      capability: 'default',
      kind: ProviderKind.OAuth,
      plugin: '@aio-proxy/plugin-kimi-code',
    },
  };
};

const weekly = (resetIn: number): OAuthQuotaCacheStatus => {
  const item: OAuthQuotaItem = {
    id: 'weekly',
    displayName: 'Weekly',
    remainingRatio: 0.5,
    resetsAt: Date.now() + resetIn,
    windowMinutes: 7 * 24 * 60,
    scope: 'account',
  };
  return { kind: 'ready', entry: { snapshot: { items: [item] }, sampledAt: Date.now(), stale: false } };
};

// `late` is listed first and the draw is pinned, so without the policy it is tried first.
function setup(selection: 'weighted' | 'quota-reset' | undefined, overrides: Partial<ProviderRouteSource> = {}) {
  const late = subscription('late');
  const soon = subscription('soon');
  const route = defineProviderRouteSource([late, soon], undefined, undefined, {
    config: ConfigSchema.parse({
      router: {
        ...(selection === undefined ? {} : { selection }),
        models: { [REQUESTED_MODEL]: { providers: { late: { weight: 1000 }, soon: { weight: 1 } } } },
      },
      providers: {},
    }),
    random: () => 0,
  });
  const quota: Readonly<Record<string, OAuthQuotaCacheStatus>> = { late: weekly(6 * DAY), soon: weekly(DAY) };
  const source: ProviderRouteSource = {
    ...route.source,
    quotaStatus: (providerId) => quota[providerId] ?? { kind: 'none' },
    ...overrides,
  };
  const send = async (rawRequest: Request = jsonRequest({ model: REQUESTED_MODEL }), responses = false) => {
    const response = responses
      ? await handleProtocolRequest({ adapter: openAIResponsesAdapter, context: {}, rawRequest, source })
      : await handleProtocolRequest({
          adapter: defineProtocolAdapter(ProviderProtocol.OpenAICompatible),
          context: createProtocolContext(),
          rawRequest,
          source,
        });
    await response.text();
    await settleRecording(route.recording);
    return response;
  };
  return { late, soon, route, send };
}

test('policy on: the subscription whose allowance expires first serves', async () => {
  const { late, soon, route, send } = setup('quota-reset');

  expect((await send()).status).toBe(200);
  expect(soon.calls.model).toHaveLength(1);
  expect(late.calls.model).toHaveLength(0);
  expect(route.recording.attempts[0]).toEqual(
    expect.objectContaining({ providerId: 'soon', selectionSource: 'quota_reset' }),
  );
});

test('policy off: the weighted draw decides, as today', async () => {
  for (const selection of ['weighted', undefined] as const) {
    const { late, soon, route, send } = setup(selection);

    expect((await send()).status).toBe(200);
    expect(late.calls.model).toHaveLength(1);
    expect(soon.calls.model).toHaveLength(0);
    expect(route.recording.attempts[0]?.selectionSource).toBe('weighted_random');
  }
});

test('response owner still wins under the policy', async () => {
  const { late, soon, route, send } = setup('quota-reset', {
    logicalSessionStore: new LogicalSessionStore({
      repository: {
        resolveResponse: () => ({
          status: 'owned',
          owner: { identity: { source: 'body-session', id: 'session-1' }, providerId: 'late' },
        }),
        findAffinity: () => ({ providerId: 'late', revision: 1, active: true }),
      },
    }),
  });

  const response = await send(
    new Request('https://proxy.test/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: REQUESTED_MODEL, input: 'next', previous_response_id: 'resp-1' }),
    }),
    true,
  );

  expect(response.status).toBe(200);
  expect(late.calls.model).toHaveLength(1);
  expect(soon.calls.model).toHaveLength(0);
  expect(route.recording.attempts[0]).toEqual(
    expect.objectContaining({ providerId: 'late', selectionSource: 'response_owner' }),
  );
});

test('session affinity alone still wins under the quota-reset policy', async () => {
  const { late, soon, route, send } = setup('quota-reset', {
    logicalSessionStore: new LogicalSessionStore({
      repository: {
        resolveResponse: () => undefined,
        findAffinity: () => ({ providerId: 'late', revision: 1, active: true }),
      },
    }),
  });

  const response = await send(
    new Request('https://proxy.test/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: REQUESTED_MODEL, input: 'next', prompt_cache_key: 'session-1' }),
    }),
    true,
  );

  expect(response.status).toBe(200);
  expect(late.calls.model).toHaveLength(1);
  expect(soon.calls.model).toHaveLength(0);
  expect(route.recording.attempts).toEqual([
    expect.objectContaining({ providerId: 'late', selectionSource: 'session_affinity' }),
  ]);
});

test('a provider-qualified request keeps its public slug under the policy', async () => {
  const { late, route, send } = setup('quota-reset');

  expect((await send(jsonRequest({ model: `late/${REQUESTED_MODEL}` }))).status).toBe(200);
  expect(late.calls.model).toHaveLength(1);
  expect(route.recording.attempts[0]).toEqual(
    expect.objectContaining({ providerId: 'late', selectionSource: 'provider_qualified' }),
  );
});
