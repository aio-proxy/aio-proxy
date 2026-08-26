import { expect, test } from 'bun:test';

import { APICallError } from '@ai-sdk/provider';
import {
  AiSdkProviderError,
  anthropicMessagesAdapter,
  geminiGenerateContentAdapter,
  openAIResponsesAdapter,
} from '@aio-proxy/core';
import { ProviderProtocol } from '@aio-proxy/types';
import { asSchema, RetryError } from 'ai';

import { handleProtocolRequest } from '.';
import {
  defineProviderRouteSource,
  errorStream,
  modelProvider,
  REQUESTED_MODEL,
  rawProvider,
  retryConfig,
  settleRecording,
  textStream,
  withSnapshotConfigs,
} from '../../../__tests__/pipeline-helpers';
import { LogicalSessionStore } from '../../logical-session-store';

test('converts portable reasoning and uses the model candidate', async () => {
  const model = modelProvider({ id: 'model', invoke: () => textStream('model response') });
  const raw = rawProvider({ id: 'raw', protocol: ProviderProtocol.OpenAIResponse });
  const route = defineProviderRouteSource([model, raw]);
  const rawRequest = new Request('https://proxy.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: REQUESTED_MODEL,
      input: [{ type: 'reasoning', id: 'rs_1', summary: [] }],
    }),
  });

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest,
    source: route.source,
  });
  expect(await response.json()).toMatchObject({ output_text: 'model response', status: 'completed' });
  await settleRecording(route.recording);
  expect(model.calls.model).toHaveLength(1);
  expect(raw.calls.raw).toHaveLength(0);
  expect(
    route.recording.attempts.map(({ errorCode, outcome, providerId, statusCode }) => ({
      errorCode,
      outcome,
      providerId,
      statusCode,
    })),
  ).toEqual([{ errorCode: undefined, outcome: 'success', providerId: 'model', statusCode: undefined }]);
});

test('preserves exact raw bytes before model fallback drops safe hosted-search history', async () => {
  const sensitiveQuery = 'private-search-marker';
  const sensitiveGrammar = 'private-grammar-marker';
  const rawText =
    '{  "tools" : [{"type":"custom","name":"apply_patch","format":{"type":"grammar","syntax":"lark","definition":"private-grammar-marker"}}], "input" : [{"type":"web_search_call","status":"completed","action":{"type":"search","query":"private-search-marker"}},{"role":"assistant","content":"Prior answer."},{"role":"user","content":"Continue."}], "seed":9007199254740993, "model" : "requested-model" }';
  const originalBytes = new TextEncoder().encode(rawText);
  const raw = rawProvider({
    id: 'raw',
    modelId: 'requested-model',
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async (request) => {
      expect(new Uint8Array(await request.clone().arrayBuffer())).toEqual(originalBytes);
      return Response.json({ error: 'unsupported request' }, { status: 422 });
    },
  });
  const model = modelProvider({
    id: 'model',
    modelId: 'requested-model',
    invoke: () => textStream('model response'),
  });
  const alias = { 'requested-model': { model: 'requested-model', preserve: false } } as const;
  const route = defineProviderRouteSource([
    { ...raw, provider: { ...raw.provider, alias } },
    { ...model, provider: { ...model.provider, alias } },
  ]);
  const rawRequest = new Request('https://proxy.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: originalBytes,
  });
  const adapter = {
    ...openAIResponsesAdapter,
    modelInvocation(
      request: Parameters<typeof openAIResponsesAdapter.modelInvocation>[0],
      context: Parameters<typeof openAIResponsesAdapter.modelInvocation>[1],
    ) {
      // The oversized seed is a raw-byte canary, not one of the compatibility
      // features under test; exclude that unsupported extension at the model boundary.
      const { seed: _seed, ...modelRequest } = request;
      return openAIResponsesAdapter.modelInvocation(modelRequest, context);
    },
  };

  const response = await handleProtocolRequest({
    adapter,
    context: {},
    rawRequest,
    source: route.source,
  });
  await settleRecording(route.recording);

  expect(response.status).toBe(200);
  expect(raw.calls.raw).toHaveLength(1);
  expect(model.calls.model).toHaveLength(1);
  expect(model.calls.model[0]?.messages).toEqual([
    { role: 'assistant', content: 'Prior answer.' },
    { role: 'user', content: 'Continue.' },
  ]);
  const applyPatch = model.calls.model[0]?.tools?.apply_patch;
  expect(applyPatch).toMatchObject({ type: 'function' });
  if (applyPatch?.type !== 'function') throw new TypeError('Expected apply_patch function tool');
  expect(await asSchema(applyPatch.inputSchema).jsonSchema).toEqual({
    type: 'object',
    properties: { input: { type: 'string' } },
    required: ['input'],
    additionalProperties: false,
  });

  const downgradeEvents = route.logs.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && entry.event === 'request.feature_downgraded',
  );
  expect(downgradeEvents).toEqual([
    {
      event: 'request.feature_downgraded',
      requestId: 'request-1',
      inboundProtocol: ProviderProtocol.OpenAIResponse,
      requestedModelId: 'requested-model',
      path: '/v1/responses',
      feature: 'web_search_call',
      action: 'dropped',
      reason: 'completed_without_results_or_sources',
      inputIndex: 0,
      providerId: 'model',
      modelId: 'requested-model',
      attemptIndex: 1,
    },
  ]);
  const serializedDowngrades = JSON.stringify(downgradeEvents);
  expect(serializedDowngrades).not.toContain(sensitiveQuery);
  expect(serializedDowngrades).not.toContain(sensitiveGrammar);
});

test('rejects an item reference before invoking a model', async () => {
  const first = modelProvider({ id: 'first', invoke: () => textStream('model response') });
  const second = modelProvider({ id: 'second', invoke: () => textStream('unused') });
  const route = defineProviderRouteSource([first, second]);
  let materializations = 0;
  const adapter = {
    ...openAIResponsesAdapter,
    modelInvocation(
      request: Parameters<typeof openAIResponsesAdapter.modelInvocation>[0],
      context: Parameters<typeof openAIResponsesAdapter.modelInvocation>[1],
    ) {
      materializations += 1;
      return openAIResponsesAdapter.modelInvocation(request, context);
    },
  };
  const rawRequest = new Request('https://proxy.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: REQUESTED_MODEL, input: [{ type: 'item_reference', id: 'item_1' }] }),
  });

  const response = await handleProtocolRequest({ adapter, context: {}, rawRequest, source: route.source });

  expect(response.status).toBe(501);
  expect(materializations).toBe(1);
  expect(first.calls.model).toHaveLength(0);
  expect(second.calls.model).toHaveLength(0);
  expect(
    route.recording.attempts.map(({ errorCode, outcome, providerId, statusCode }) => ({
      errorCode,
      outcome,
      providerId,
      statusCode,
    })),
  ).toEqual([
    { errorCode: 'unsupported_feature', outcome: 'failure', providerId: 'first', statusCode: 501 },
    { errorCode: 'unsupported_feature', outcome: 'failure', providerId: 'second', statusCode: 501 },
  ]);
  expect(route.recording.finals[0]).toEqual(
    expect.objectContaining({ errorCode: 'unsupported_feature', outcome: 'failure' }),
  );
});

test('skips a Gemini candidate for a remote tool-result image and invokes the next target', async () => {
  const gemini = modelProvider({
    id: 'gemini',
    targetProtocol: ProviderProtocol.Gemini,
    invoke: () => textStream('must not run'),
  });
  const anthropic = modelProvider({
    id: 'anthropic',
    targetProtocol: ProviderProtocol.Anthropic,
    invoke: () => textStream('fallback response'),
  });
  const route = defineProviderRouteSource([gemini, anthropic]);
  const rawRequest = new Request('https://proxy.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: REQUESTED_MODEL,
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'inspect', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: [{ type: 'input_image', image_url: 'https://example.test/image.png' }],
        },
      ],
    }),
  });

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest,
    source: route.source,
  });
  await settleRecording(route.recording);

  expect(response.status).toBe(200);
  expect(gemini.calls.model).toHaveLength(0);
  expect(anthropic.calls.model).toHaveLength(1);
  expect(anthropic.calls.model[0]?.messages[1]).toMatchObject({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call_1',
        toolName: 'inspect',
        output: {
          type: 'content',
          value: [
            {
              type: 'file',
              mediaType: 'image/png',
              data: { type: 'url', url: new URL('https://example.test/image.png') },
              providerOptions: {
                aioProxy: { toolImage: true, trust: expect.any(String) },
              },
            },
          ],
        },
      },
    ],
  });
  expect(
    route.recording.attempts.map(({ errorCode, outcome, providerId }) => ({ errorCode, outcome, providerId })),
  ).toEqual([
    { errorCode: 'unsupported_feature', outcome: 'failure', providerId: 'gemini' },
    { errorCode: undefined, outcome: 'success', providerId: 'anthropic' },
  ]);
});

test('skips a Gemini candidate when a user image URL has no MIME subtype', async () => {
  const gemini = modelProvider({
    id: 'gemini',
    targetProtocol: ProviderProtocol.Gemini,
    invoke: () => textStream('must not run'),
  });
  const anthropic = modelProvider({
    id: 'anthropic',
    targetProtocol: ProviderProtocol.Anthropic,
    invoke: () => textStream('fallback response'),
  });
  const route = defineProviderRouteSource([gemini, anthropic]);
  const rawRequest = new Request('https://proxy.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: REQUESTED_MODEL,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: 'https://example.test/media?id=123' }],
        },
      ],
    }),
  });

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest,
    source: route.source,
  });
  await settleRecording(route.recording);

  expect(response.status).toBe(200);
  expect(gemini.calls.model).toHaveLength(0);
  expect(anthropic.calls.model).toHaveLength(1);
  expect(anthropic.calls.model[0]?.messages).toMatchObject([
    {
      role: 'user',
      content: [
        {
          type: 'file',
          mediaType: 'image',
          data: { type: 'url', url: new URL('https://example.test/media?id=123') },
        },
      ],
    },
  ]);
});

test('falls back after an OpenAI-compatible endpoint rejects the CPA extension', async () => {
  const compatible = modelProvider({
    id: 'compatible',
    targetProtocol: ProviderProtocol.OpenAICompatible,
    invoke: () => errorStream(new Error('compatible endpoint rejected tool image content')),
  });
  const responses = modelProvider({
    id: 'responses',
    targetProtocol: ProviderProtocol.OpenAIResponse,
    invoke: () => textStream('fallback response'),
  });
  const route = defineProviderRouteSource([compatible, responses]);
  const rawRequest = new Request('https://proxy.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: REQUESTED_MODEL,
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'inspect', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }],
        },
      ],
    }),
  });

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest,
    source: route.source,
  });
  await settleRecording(route.recording);

  expect(response.status).toBe(200);
  expect(compatible.calls.model).toHaveLength(1);
  expect(responses.calls.model).toHaveLength(1);
  expect(route.recording.attempts.map(({ outcome, providerId }) => ({ outcome, providerId }))).toEqual([
    { outcome: 'failure', providerId: 'compatible' },
    { outcome: 'success', providerId: 'responses' },
  ]);
});

test('fails fast on invalid function arguments without trying raw', async () => {
  const model = modelProvider({ id: 'model', invoke: () => textStream('not called') });
  const raw = rawProvider({ id: 'raw', protocol: ProviderProtocol.OpenAIResponse });
  const route = defineProviderRouteSource([model, raw]);
  const rawRequest = new Request('https://proxy.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: REQUESTED_MODEL,
      input: [{ type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{' }],
    }),
  });

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest,
    source: route.source,
  });

  expect(response.status).toBe(400);
  expect(raw.calls.raw).toHaveLength(0);
  expect(
    route.recording.attempts.map(({ errorCode, providerId, statusCode }) => ({ errorCode, providerId, statusCode })),
  ).toEqual([{ errorCode: 'invalid_request', providerId: 'model', statusCode: 400 }]);
  expect(route.recording.finals[0]).toEqual(expect.objectContaining({ errorCode: 'invalid_request' }));
});

// --- Provider cooldown on 429 (write / skip / synthesize) ---

function responsesRequest(extra: Record<string, unknown> = {}): Request {
  return new Request('https://proxy.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: REQUESTED_MODEL, input: 'ping', ...extra }),
  });
}

function rawRateLimited(id: string, retryAfter: string) {
  return rawProvider({
    id,
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: () => Response.json({ error: id }, { status: 429, headers: { 'retry-after': retryAfter } }),
  });
}

test('skips a cooled provider and falls back to the backup without a second call', async () => {
  const primary = rawRateLimited('primary', '30');
  const backup = rawProvider({ id: 'backup', protocol: ProviderProtocol.OpenAIResponse });
  const route = defineProviderRouteSource([primary, backup]);
  const source = withSnapshotConfigs(route.source, retryConfig());

  const first = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: responsesRequest(),
    source,
  });
  expect(first.status).toBe(200);
  expect(primary.calls.raw).toHaveLength(1);
  expect(backup.calls.raw).toHaveLength(1);

  const second = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: responsesRequest(),
    source,
  });
  expect(second.status).toBe(200);
  expect(primary.calls.raw).toHaveLength(1); // still 1 — cooled, skipped
  expect(backup.calls.raw).toHaveLength(2);
});

test('synthesizes a 429 when the only provider is cooled, without hitting upstream', async () => {
  const only = rawRateLimited('only', '30');
  const route = defineProviderRouteSource([only]);
  const source = withSnapshotConfigs(route.source, retryConfig());

  const first = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: responsesRequest(),
    source,
  });
  expect(first.status).toBe(429);
  expect(only.calls.raw).toHaveLength(1);

  const second = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: responsesRequest(),
    source,
  });
  expect(second.status).toBe(429);
  expect(only.calls.raw).toHaveLength(1); // not called again — synthesized
  expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);
});

test('all-cooled synthesized Retry-After reflects the shortest remaining window', async () => {
  const long = rawRateLimited('long', '30');
  const short = rawRateLimited('short', '5');
  const route = defineProviderRouteSource([long, short]);
  const source = withSnapshotConfigs(route.source, retryConfig());

  // First request cools both: `long` falls back (30s), `short` returns terminal 429 (5s).
  const first = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: responsesRequest(),
    source,
  });
  expect(first.status).toBe(429);
  expect(long.calls.raw).toHaveLength(1);
  expect(short.calls.raw).toHaveLength(1);

  const second = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: responsesRequest(),
    source,
  });
  expect(second.status).toBe(429);
  expect(long.calls.raw).toHaveLength(1);
  expect(short.calls.raw).toHaveLength(1);
  const retryAfter = Number(second.headers.get('retry-after'));
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(5); // shortest (short=5s) wins, not long=30s
});

test('all-cooled synthesis uses protocol-native bodies per adapter', async () => {
  const openai = rawRateLimited('openai', '10');
  const openaiRoute = defineProviderRouteSource([openai]);
  const openaiSource = withSnapshotConfigs(openaiRoute.source, retryConfig());
  await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: responsesRequest(),
    source: openaiSource,
  });
  const openaiSynth = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: responsesRequest(),
    source: openaiSource,
  });
  expect(openaiSynth.status).toBe(429);
  expect(await openaiSynth.json()).toEqual({
    error: {
      code: 'rate_limit_exceeded',
      message: 'All providers for this model are cooling down',
      type: 'rate_limit_error',
    },
  });

  const anthropic = rawProvider({
    id: 'anthropic',
    protocol: ProviderProtocol.Anthropic,
    invoke: () => Response.json({ error: 'anthropic' }, { status: 429, headers: { 'retry-after': '10' } }),
  });
  const anthropicRoute = defineProviderRouteSource([anthropic]);
  const anthropicSource = withSnapshotConfigs(anthropicRoute.source, retryConfig());
  const anthropicBody = () =>
    new Request('https://proxy.test/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: REQUESTED_MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
  await handleProtocolRequest({
    adapter: anthropicMessagesAdapter,
    context: {},
    rawRequest: anthropicBody(),
    source: anthropicSource,
  });
  const anthropicSynth = await handleProtocolRequest({
    adapter: anthropicMessagesAdapter,
    context: {},
    rawRequest: anthropicBody(),
    source: anthropicSource,
  });
  expect(anthropicSynth.status).toBe(429);
  expect(await anthropicSynth.json()).toEqual({
    type: 'error',
    error: { type: 'rate_limit_error', message: 'All providers for this model are cooling down' },
  });

  const gemini = rawProvider({
    id: 'gemini',
    protocol: ProviderProtocol.Gemini,
    invoke: () => Response.json({ error: 'gemini' }, { status: 429, headers: { 'retry-after': '10' } }),
  });
  const geminiRoute = defineProviderRouteSource([gemini]);
  const geminiSource = withSnapshotConfigs(geminiRoute.source, retryConfig());
  const geminiBody = () =>
    new Request(`https://proxy.test/v1beta/models/${REQUESTED_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    });
  const geminiCtx = { model: REQUESTED_MODEL, stream: false };
  await handleProtocolRequest({
    adapter: geminiGenerateContentAdapter,
    context: geminiCtx,
    rawRequest: geminiBody(),
    source: geminiSource,
  });
  const geminiSynth = await handleProtocolRequest({
    adapter: geminiGenerateContentAdapter,
    context: geminiCtx,
    rawRequest: geminiBody(),
    source: geminiSource,
  });
  expect(geminiSynth.status).toBe(429);
  expect(await geminiSynth.json()).toEqual({
    error: { code: 429, message: 'All providers for this model are cooling down', status: 'RESOURCE_EXHAUSTED' },
  });
});

test('cools the pair on a wrapped AI-SDK 429 exception through the real error chain', async () => {
  const wrapped = new AiSdkProviderError(
    'p',
    new RetryError({
      message: 'failed',
      reason: 'maxRetriesExceeded',
      errors: [
        new APICallError({
          message: 'limited',
          url: 'https://u.test',
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { 'retry-after': '30' },
        }),
      ],
    }),
  );
  const model = modelProvider({ id: 'model', invoke: () => errorStream(wrapped) });
  const route = defineProviderRouteSource([model]);
  const source = withSnapshotConfigs(route.source, retryConfig());

  const first = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: responsesRequest(),
    source,
  });
  expect(first.status).not.toBe(200);
  expect(model.calls.model).toHaveLength(1);

  const second = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: responsesRequest(),
    source,
  });
  expect(second.status).toBe(429); // cooled -> synthesized
  expect(model.calls.model).toHaveLength(1); // provider not invoked again
});

test('all-cooled finalizes as a request-level 429 with no attempt spans', async () => {
  const only = rawRateLimited('only', '30');
  const route = defineProviderRouteSource([only]);
  const source = withSnapshotConfigs(route.source, retryConfig());

  await handleProtocolRequest({ adapter: openAIResponsesAdapter, context: {}, rawRequest: responsesRequest(), source });
  await settleRecording(route.recording);
  const attemptsAfterFirst = route.recording.attempts.length;

  await handleProtocolRequest({ adapter: openAIResponsesAdapter, context: {}, rawRequest: responsesRequest(), source });
  await settleRecording(route.recording);

  const synthFinal = route.recording.finals.at(-1);
  expect(synthFinal).toEqual(
    expect.objectContaining({ outcome: 'failure', finalStatusCode: 429, errorCode: 'rate_limited' }),
  );
  expect(synthFinal?.finalProviderId).toBeUndefined();
  expect(synthFinal?.finalModelId).toBeUndefined();
  expect(synthFinal?.attempt).toBeUndefined();
  expect(route.recording.attempts).toHaveLength(attemptsAfterFirst); // synthesis added no attempt span
});

test('skips a cooled affinity-bound candidate in favor of the next live candidate', async () => {
  const bound = rawRateLimited('bound', '30');
  const other = rawProvider({ id: 'other', protocol: ProviderProtocol.OpenAIResponse });
  const route = defineProviderRouteSource([bound, other]);
  const source = {
    ...withSnapshotConfigs(route.source, retryConfig()),
    logicalSessionStore: new LogicalSessionStore({
      repository: {
        resolveResponse: () => undefined,
        findAffinity: () => ({ providerId: 'bound', revision: 1, active: true }),
      },
    }),
  };

  const first = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: responsesRequest({ prompt_cache_key: 'session-1' }),
    source,
  });
  expect(first.status).toBe(200); // bound 429s, falls back to other
  expect(bound.calls.raw).toHaveLength(1);
  expect(other.calls.raw).toHaveLength(1);

  const second = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: responsesRequest({ prompt_cache_key: 'session-1' }),
    source,
  });
  expect(second.status).toBe(200);
  expect(bound.calls.raw).toHaveLength(1); // affinity target cooled -> skipped despite affinity
  expect(other.calls.raw).toHaveLength(2);
});

test('re-selects a provider after its cooldown expires', async () => {
  const provider = rawRateLimited('flappy', '1');
  const route = defineProviderRouteSource([provider]);
  const source = withSnapshotConfigs(route.source, retryConfig());

  const first = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: responsesRequest(),
    source,
  });
  expect(first.status).toBe(429);
  expect(provider.calls.raw).toHaveLength(1);

  const second = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: responsesRequest(),
    source,
  });
  expect(second.status).toBe(429);
  expect(provider.calls.raw).toHaveLength(1); // still cooled -> synthesized

  // Real delay: the cooldown TTL is enforced by lru-cache against its own
  // internal clock, which fake timers cannot advance. A short 1s window keeps
  // this deterministic enough while exercising genuine expiry re-entry.
  await Bun.sleep(1_100);

  const third = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: responsesRequest(),
    source,
  });
  expect(third.status).toBe(429);
  expect(provider.calls.raw).toHaveLength(2); // cooldown expired -> selected again
});
