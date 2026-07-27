import { expect, test } from 'bun:test';

import { geminiGenerateContentAdapter } from '@aio-proxy/core';

import { LogicalSessionStore } from '../logical-session-store';
import { createGeminiGenerateContentRoutes } from './gemini-generate-content';
import {
  anthropicRequest,
  configOrderedProviders,
  countFixture,
  counter,
  geminiContext,
  geminiRequest,
  openAIResponsesRequest,
  provider,
  requestedModel,
} from './token-count.test-support';

test('uses routing order and falls through candidates without count support', async () => {
  const calls: string[] = [];
  const fixture = countFixture([
    provider({ id: 'unsupported' }),
    provider({
      id: 'real',
      tokenCount: async () => {
        calls.push('real');
        return { inputTokens: 42 };
      },
    }),
  ]);

  const response = await fixture.anthropic();

  expect(await response.json()).toEqual({ input_tokens: 42 });
  expect(response.headers.has('x-aio-proxy-token-count-estimated')).toBe(false);
  expect(calls).toEqual(['real']);
  expect(fixture.recording.attempts).toEqual([
    expect.objectContaining({ outcome: 'success', providerId: 'real', statusCode: 200 }),
  ]);
  expect(fixture.releases()).toBe(1);
});

test('opens the attempt span before the counter runs so the provider attempt gets real duration', async () => {
  const fixture = countFixture([
    provider({
      id: 'slow',
      tokenCount: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { inputTokens: 7 };
      },
    }),
  ]);

  expect(await (await fixture.anthropic()).json()).toEqual({ input_tokens: 7 });
  // The span must cover the ~20ms counter; a near-zero span would mean it was
  // opened only after countTokens resolved.
  expect(fixture.recording.attempts[0]?.durationMs).toBeGreaterThanOrEqual(10);
});

test('uses descending Provider weight before lower configured candidates', async () => {
  const calls: string[] = [];
  const fixture = countFixture(
    configOrderedProviders([
      { provider: provider({ id: 'low', tokenCount: counter('low', 22, calls) }), weight: 1 },
      { provider: provider({ id: 'high', tokenCount: counter('high', 11, calls) }), weight: 10 },
    ]),
  );

  expect(await (await fixture.gemini()).json()).toEqual({ totalTokens: 11 });
  expect(calls).toEqual(['high']);
});

test('preserves config order for equal Provider weights', async () => {
  const calls: string[] = [];
  const fixture = countFixture(
    configOrderedProviders([
      { provider: provider({ id: 'first', tokenCount: counter('first', 11, calls) }), weight: 5 },
      { provider: provider({ id: 'second', tokenCount: counter('second', 22, calls) }), weight: 5 },
    ]),
  );

  expect(await (await fixture.gemini()).json()).toEqual({ totalTokens: 11 });
  expect(calls).toEqual(['first']);
});

test('uses active session affinity before Provider weight', async () => {
  const calls: string[] = [];
  const fixture = countFixture(
    configOrderedProviders([
      { provider: provider({ id: 'weighted', tokenCount: counter('weighted', 11, calls) }), weight: 10 },
      { provider: provider({ id: 'affinity', tokenCount: counter('affinity', 22, calls) }), weight: 1 },
    ]),
    {
      logicalSessionStore: new LogicalSessionStore({
        repository: {
          resolveResponse: () => undefined,
          findAffinity: () => ({ providerId: 'affinity', revision: 1, active: true }),
        },
      }),
    },
  );

  expect(await (await fixture.anthropic(anthropicRequest({ session_id: 'session-1' }))).json()).toEqual({
    input_tokens: 22,
  });
  expect(calls).toEqual(['affinity']);
});

test('prioritizes the response owner ahead of ordinary session affinity', async () => {
  const calls: string[] = [];
  const fixture = countFixture(
    configOrderedProviders([
      { provider: provider({ id: 'weighted', tokenCount: counter('weighted', 11, calls) }), weight: 10 },
      { provider: provider({ id: 'affinity', tokenCount: counter('affinity', 22, calls) }), weight: 5 },
      { provider: provider({ id: 'owner', tokenCount: counter('owner', 33, calls) }), weight: 1 },
    ]),
    {
      logicalSessionStore: new LogicalSessionStore({
        repository: {
          resolveResponse: () => ({
            status: 'owned',
            owner: { identity: { source: 'body-session', id: 'session-1' }, providerId: 'owner' },
          }),
          findAffinity: () => ({ providerId: 'affinity', revision: 1, active: true }),
        },
      }),
    },
  );

  expect(
    await (await fixture.openAIResponses(openAIResponsesRequest({ previous_response_id: 'resp-1' }))).json(),
  ).toEqual({ input_tokens: 33 });
  expect(calls).toEqual(['owner']);
});

test('rejects an ambiguous previous response before token counting', async () => {
  const calls: string[] = [];
  const fixture = countFixture([provider({ id: 'unsafe', tokenCount: counter('unsafe', 11, calls) })], {
    logicalSessionStore: new LogicalSessionStore({
      repository: {
        resolveResponse: () => ({ status: 'ambiguous' }),
        findAffinity: () => undefined,
      },
    }),
  });

  const response = await fixture.openAIResponses(openAIResponsesRequest({ previous_response_id: 'resp-1' }));

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'previous_response_conflict' } });
  expect(calls).toEqual([]);
  expect(fixture.recording.finals).toEqual([
    expect.objectContaining({ outcome: 'failure', finalStatusCode: 409, errorCode: 'previous_response_conflict' }),
  ]);
  expect(fixture.releases()).toBe(0);
});

test('records failed and invalid counters before succeeding', async () => {
  const bodies: string[] = [];
  const fixture = countFixture([
    provider({
      id: 'failed',
      tokenCount: async ({ request }) => {
        bodies.push(await request.text());
        throw new Error('counter unavailable');
      },
    }),
    provider({ id: 'invalid', tokenCount: async () => ({ inputTokens: 1.5 }) }),
    provider({
      id: 'real',
      tokenCount: async ({ request }) => {
        bodies.push(await request.text());
        return { inputTokens: 7 };
      },
    }),
  ]);

  expect(await (await fixture.anthropic()).json()).toEqual({ input_tokens: 7 });
  expect(bodies).toEqual([
    expect.stringContaining('"model":"count-model"'),
    expect.stringContaining('"model":"count-model"'),
  ]);
  expect(fixture.recording.attempts).toEqual([
    expect.objectContaining({ outcome: 'failure', providerId: 'failed', statusCode: 500 }),
    expect.objectContaining({ outcome: 'failure', providerId: 'invalid', statusCode: 500 }),
    expect.objectContaining({ outcome: 'success', providerId: 'real', statusCode: 200 }),
  ]);
});

test('returns a standard estimate with the estimate header after real attempts fail', async () => {
  const rawRequest = geminiRequest();
  const parsed = await geminiGenerateContentAdapter.parse(rawRequest.clone(), geminiContext());
  const expected = Math.max(1, Math.ceil(JSON.stringify(parsed).length / 64));
  const fixture = countFixture([
    provider({
      id: 'failed',
      tokenCount: async () => {
        throw new Error('counter unavailable');
      },
    }),
  ]);

  const response = await fixture.gemini(rawRequest);

  expect(await response.json()).toEqual({ totalTokens: expected });
  expect(response.headers.get('x-aio-proxy-token-count-estimated')).toBe('true');
  expect(fixture.recording.finals).toEqual([expect.objectContaining({ outcome: 'success' })]);
});

test('skips provider-tool-incompatible counters before invoking them', async () => {
  let unsupportedCalls = 0;
  const fixture = countFixture([
    provider({
      id: 'unsupported',
      supportsProviderTool: false,
      tokenCount: async () => {
        unsupportedCalls += 1;
        return { inputTokens: 1 };
      },
    }),
    provider({ id: 'capable', supportsProviderTool: true, tokenCount: async () => ({ inputTokens: 9 }) }),
  ]);

  const response = await fixture.anthropic(
    anthropicRequest({
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
    }),
  );

  expect(await response.json()).toEqual({ input_tokens: 9 });
  expect(unsupportedCalls).toBe(0);
});

test('maps model-not-found and releases the snapshot lease', async () => {
  const fixture = countFixture([]);

  const response = await fixture.anthropic();

  expect(response.status).toBe(404);
  expect(fixture.recording.begins).toHaveLength(1);
  // model-not-found now finishes the running root as a terminal failure.
  expect(fixture.recording.finals).toEqual([
    expect.objectContaining({ outcome: 'failure', finalStatusCode: 404, errorCode: 'model_not_found' }),
  ]);
  expect(fixture.releases()).toBe(1);
});

test('routes Gemini countTokens and preserves a provider-qualified model resource', async () => {
  const modelIds: string[] = [];
  const fixture = countFixture([
    provider({
      id: 'gemini',
      tokenCount: async ({ modelId }) => {
        modelIds.push(modelId);
        return { inputTokens: 17 };
      },
    }),
  ]);

  const response = await createGeminiGenerateContentRoutes(fixture.source).request(
    `/v1beta/models/gemini/${requestedModel}:countTokens`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: await geminiRequest().text() },
  );

  expect(await response.json()).toEqual({ totalTokens: 17 });
  expect(modelIds).toEqual(['gemini-wire']);
});
