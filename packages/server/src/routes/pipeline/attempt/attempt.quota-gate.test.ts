import { expect, test } from 'bun:test';

import { APICallError } from '@ai-sdk/provider';
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
import { attributeName, spanName } from '../../../request-tracing';
import type { ProviderRouteSource } from '../../../runtime';
import { handleProtocolRequest } from '../index';

const HOUR = 60 * 60_000;

const subscription = (id: string, invoke = () => textStream(id)): FakeProvider => {
  const fixture = modelProvider({ id, invoke });
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

const exhausted = (resetInMs: number, scope: OAuthQuotaItem['scope'] = 'account'): OAuthQuotaCacheStatus => ({
  kind: 'ready',
  entry: {
    snapshot: {
      items: [{ id: 'weekly', displayName: 'Weekly', remainingRatio: 0, resetsAt: Date.now() + resetInMs, scope }],
    },
    sampledAt: Date.now(),
    stale: false,
  },
});

// Fixtures are listed in descending Provider priority so candidate order, and so the recorded skip
// order, is deterministic.
function setup(
  fixtures: readonly FakeProvider[],
  quota: Readonly<Record<string, OAuthQuotaCacheStatus>>,
  overrides: Partial<ProviderRouteSource> = {},
) {
  const providers = Object.fromEntries(
    fixtures.map((fixture, index) => [fixture.provider.id, { priority: 100 - index, weight: 1 }]),
  );
  const route = defineProviderRouteSource(fixtures, undefined, undefined, {
    config: ConfigSchema.parse({ router: { models: { [REQUESTED_MODEL]: { providers } } }, providers: {} }),
  });
  const warmed: string[] = [];
  const source: ProviderRouteSource = {
    ...route.source,
    quotaStatus: (providerId) => quota[providerId] ?? { kind: 'none' },
    warmProviderQuota: (providerId) => warmed.push(providerId),
    ...overrides,
  };
  const send = async (rawRequest = jsonRequest({ model: REQUESTED_MODEL }), responses = false) => {
    const response = responses
      ? await handleProtocolRequest({ adapter: openAIResponsesAdapter, context: {}, rawRequest, source })
      : await handleProtocolRequest({
          adapter: defineProtocolAdapter(ProviderProtocol.OpenAICompatible),
          context: createProtocolContext(),
          rawRequest,
          source,
        });
    const body = await response.text();
    await settleRecording(route.recording);
    return { response, body };
  };
  const skipped = () =>
    route.recording.spans.find((span) => span.name === spanName.inference)?.attributes[
      attributeName.routeSkippedCandidates
    ];
  return { route, source, warmed, send, skipped };
}

test('skips an exhausted subscription and serves from the next candidate', async () => {
  const a = subscription('sub-a');
  const b = subscription('sub-b');
  const { send, skipped, warmed } = setup([a, b], { 'sub-a': exhausted(HOUR) });

  const { response } = await send();

  expect(response.status).toBe(200);
  expect(a.calls.model).toHaveLength(0);
  expect(b.calls.model).toHaveLength(1);
  // Stored with payload capture off, the default: the span is sensitive and still keeps the reason.
  expect(skipped()).toEqual(['sub-a:quota_exhausted']);
  expect(warmed).toContain('sub-a');
});

test('unknown quota is attempted as today', async () => {
  const a = subscription('sub-a');
  const { send, skipped, warmed } = setup([a], {});

  expect((await send()).response.status).toBe(200);
  expect(a.calls.model).toHaveLength(1);
  expect(skipped()).toBeUndefined();
  // Only the post-success warm: selection must not pre-empt it with a read of the pre-request balance.
  expect(warmed).toEqual(['sub-a']);
});

test('stale quota is attempted as today', async () => {
  const a = subscription('sub-a');
  const stale = exhausted(HOUR);
  const { send } = setup([a], {
    'sub-a': stale.kind === 'ready' ? { kind: 'ready', entry: { ...stale.entry, stale: true } } : stale,
  });

  expect((await send()).response.status).toBe(200);
  expect(a.calls.model).toHaveLength(1);
});

test('a model outside the exhausted window scope is not held', async () => {
  const a = subscription('sub-a');
  const { send } = setup([a], { 'sub-a': exhausted(HOUR, { models: ['other-*'] }) });

  expect((await send()).response.status).toBe(200);
  expect(a.calls.model).toHaveLength(1);
});

test('a non-OAuth provider ignores quota status', async () => {
  const plain = modelProvider({ id: 'plain', invoke: () => textStream('plain') });
  const { send } = setup([plain], { plain: exhausted(HOUR) });

  expect((await send()).response.status).toBe(200);
  expect(plain.calls.model).toHaveLength(1);
});

test('a 429 from a subscription warms its quota so the next request can skip it', async () => {
  const a = subscription('sub-a', () => {
    throw new APICallError({
      message: 'usage limit reached',
      url: 'https://sub-a.example.test',
      requestBodyValues: {},
      statusCode: 429,
      isRetryable: false,
    });
  });
  const b = subscription('sub-b');
  const { send, warmed } = setup([a, b], {});

  expect((await send()).response.status).toBe(200);
  expect(warmed).toContain('sub-a');
});

test('quota exhaustion overrides session affinity and the response owner', async () => {
  const a = subscription('sub-a');
  const b = subscription('sub-b');
  const { send } = setup(
    [b, a],
    { 'sub-a': exhausted(HOUR) },
    {
      logicalSessionStore: new LogicalSessionStore({
        repository: {
          resolveResponse: () => ({
            status: 'owned',
            owner: { identity: { source: 'body-session', id: 'session-1' }, providerId: 'sub-a' },
          }),
          findAffinity: () => ({ providerId: 'sub-a', revision: 1, active: true }),
        },
      }),
    },
  );

  const { response } = await send(
    new Request('https://proxy.test/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: REQUESTED_MODEL, input: 'next', previous_response_id: 'resp-1' }),
    }),
    true,
  );

  expect(response.status).toBe(200);
  expect(a.calls.model).toHaveLength(0);
  expect(b.calls.model).toHaveLength(1);
});

test('all exhausted returns 429 with Retry-After until the earliest reset', async () => {
  const a = subscription('sub-a');
  const b = subscription('sub-b');
  const { send, skipped } = setup([a, b], { 'sub-a': exhausted(90_000), 'sub-b': exhausted(3 * HOUR) });

  const { response } = await send();

  expect(response.status).toBe(429);
  expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(89);
  expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(90);
  expect(a.calls.model).toHaveLength(0);
  expect(b.calls.model).toHaveLength(0);
  expect(skipped()).toEqual(['sub-a:quota_exhausted', 'sub-b:quota_exhausted']);
});

test('cooling and exhausted candidates are both recorded', async () => {
  const a = subscription('sub-a');
  const b = subscription('sub-b');
  const c = subscription('sub-c');
  const { send, skipped, source } = setup([a, b, c], { 'sub-b': exhausted(HOUR) });
  source.cooldown.cool('sub-a', 'sub-a-model', 30_000);

  expect((await send()).response.status).toBe(200);
  expect(c.calls.model).toHaveLength(1);
  expect(skipped()).toEqual(['sub-a:cooldown', 'sub-b:quota_exhausted']);
});
