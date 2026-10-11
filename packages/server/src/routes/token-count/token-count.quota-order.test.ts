import { expect, test } from 'bun:test';

import { anthropicMessagesAdapter } from '@aio-proxy/core';
import type { OAuthQuotaItem } from '@aio-proxy/plugin-sdk';
import { ConfigSchema, ProviderKind } from '@aio-proxy/types';

import {
  defineProviderRouteSource,
  modelProvider,
  settleRecording,
  textStream,
} from '../../../__tests__/pipeline-helpers';
import type { OAuthQuotaCacheStatus } from '../../plugin-quota';
import { attributeName, spanName } from '../../request-tracing';
import { handleProtocolRequest } from '../pipeline';
import { handleTokenCount } from './token-count';
import { anthropicRequest, countFixture, provider, requestedModel } from './token-count.test-support';

const DAY = 24 * 60 * 60_000;

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

const quota: Readonly<Record<string, OAuthQuotaCacheStatus>> = { late: weekly(6 * DAY), soon: weekly(DAY) };
const quotaStatus = (providerId: string): OAuthQuotaCacheStatus => quota[providerId] ?? { kind: 'none' };

const config = ConfigSchema.parse({
  router: {
    selection: 'quota-reset',
    models: { [requestedModel]: { providers: { late: { weight: 1 }, unknown: { weight: 1 }, soon: { weight: 1 } } } },
  },
  providers: {},
});

const failing = (id: string) => {
  const fixture = modelProvider({
    id,
    modelId: `${id}-wire`,
    invoke: () => {
      throw new Error(`${id} failed`);
    },
  });
  return {
    ...fixture,
    provider: {
      ...fixture.provider,
      kind: ProviderKind.OAuth,
      alias: { [requestedModel]: { model: `${id}-wire`, preserve: false } },
    },
  };
};

// Each candidate but the last is tried and passed over, so both paths reveal their full order.
test('token counting and generation share the full reset order', async () => {
  const count = countFixture(
    [
      provider({ id: 'late' }),
      provider({ id: 'unknown', tokenCount: async () => ({ inputTokens: 7 }) }),
      provider({ id: 'soon' }),
    ],
    { config },
  );
  const countResponse = await handleTokenCount({
    adapter: anthropicMessagesAdapter,
    context: {},
    format: (inputTokens) => ({ input_tokens: inputTokens }),
    rawRequest: anthropicRequest({ session_id: 's0' }),
    source: { ...count.source, quotaStatus },
  });
  expect(await countResponse.json()).toEqual({ input_tokens: 7 });
  const counted = [
    ...count.recording.spans
      .filter((span) => span.name === spanName.candidateSkipped)
      .map((span) => span.attributes[attributeName.providerId]),
    ...count.recording.attempts.map(({ providerId }) => providerId),
  ];

  const unknown = modelProvider({ id: 'unknown', modelId: 'unknown-wire', invoke: () => textStream('ok') });
  const generation = defineProviderRouteSource(
    [
      failing('late'),
      {
        ...unknown,
        provider: { ...unknown.provider, alias: { [requestedModel]: { model: 'unknown-wire', preserve: false } } },
      },
      failing('soon'),
    ],
    undefined,
    undefined,
    { config },
  );
  const generated = await handleProtocolRequest({
    adapter: anthropicMessagesAdapter,
    context: {},
    rawRequest: new Request('https://proxy.test/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: requestedModel,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
        session_id: 's0',
      }),
    }),
    source: { ...generation.source, quotaStatus },
  });
  expect(generated.status).toBe(200);
  await settleRecording(generation.recording);

  expect(counted).toEqual(['soon', 'late', 'unknown']);
  expect(generation.recording.attempts.map(({ providerId }) => providerId)).toEqual(['soon', 'late', 'unknown']);
});
