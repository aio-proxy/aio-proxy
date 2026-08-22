import { describe, expect, test } from 'bun:test';

import { ConfigSchema, ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import {
  defineProtocolAdapter,
  jsonRequest,
  modelProvider,
  REQUESTED_MODEL,
  rawProvider,
  type Recording,
  settleRecording,
  textStream,
} from '../../../__tests__/pipeline-helpers';
import { attemptsOf, pipeline } from './test-support';

const attemptProviderIds = (recording: Recording): string[] => recording.attempts.map(({ providerId }) => providerId);

test('tries the remaining same-priority Provider before a lower tier', async () => {
  const failingA = modelProvider({
    id: 'a',
    invoke: () => {
      throw new Error('a failed');
    },
  });
  const succeedingB = modelProvider({ id: 'b', invoke: () => textStream('b') });
  const lowerC = modelProvider({ id: 'c', invoke: () => textStream('c') });
  const config = ConfigSchema.parse({
    router: {
      models: {
        [REQUESTED_MODEL]: {
          providers: {
            a: { priority: 20, weight: 3 },
            b: { priority: 20, weight: 1 },
            c: { priority: 10, weight: 1 },
          },
        },
      },
    },
    providers: {},
  });
  const harness = pipeline([failingA, succeedingB, lowerC], {
    config,
    random: () => 0,
  });
  await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
  await settleRecording(harness.recording);
  expect(attemptProviderIds(harness.recording)).toEqual(['a', 'b']);
});

test('uses an injected same-tier weight draw before a heavier remaining candidate', async () => {
  const heavy = modelProvider({ id: 'heavy', invoke: () => textStream('heavy') });
  const light = modelProvider({ id: 'light', invoke: () => textStream('light') });
  const config = ConfigSchema.parse({
    router: {
      models: {
        [REQUESTED_MODEL]: {
          providers: {
            heavy: { priority: 20, weight: 3 },
            light: { priority: 20, weight: 1 },
          },
        },
      },
    },
    providers: {},
  });
  const harness = pipeline([heavy, light], { config, random: () => 0.9 });
  await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
  await settleRecording(harness.recording);
  expect(attemptProviderIds(harness.recording)).toEqual(['light']);
});

test('a stable session ignores the injected random source', async () => {
  const first = modelProvider({ id: 'a', invoke: () => textStream('a') });
  const second = modelProvider({ id: 'b', invoke: () => textStream('b') });
  const config = ConfigSchema.parse({
    router: {
      models: {
        [REQUESTED_MODEL]: {
          providers: {
            a: { priority: 20, weight: 3 },
            b: { priority: 20, weight: 1 },
          },
        },
      },
    },
    providers: {},
  });
  const harness = pipeline([first, second], { config, random: () => 0.99 });
  await harness.run(
    new Request('http://localhost/v1/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json', session_id: 'session-1' },
      body: JSON.stringify({ model: REQUESTED_MODEL }),
    }),
  );
  await settleRecording(harness.recording);
  expect(attemptProviderIds(harness.recording)).toEqual(['a']);
  expect(harness.recording.attempts[0]).toEqual(
    expect.objectContaining({ selectionSource: 'deterministic_session', attemptIndex: 0 }),
  );
});

test('routes a Provider-qualified model even when effective weight is zero', async () => {
  const zero = modelProvider({ id: 'zero', invoke: () => textStream('zero'), weight: 0 });
  const other = modelProvider({ id: 'other', invoke: () => textStream('other'), weight: 1 });
  const harness = pipeline([zero, other], { random: () => 0 });
  await harness.run(jsonRequest({ model: `zero/${REQUESTED_MODEL}` }));
  await settleRecording(harness.recording);
  expect(attemptProviderIds(harness.recording)).toEqual(['zero']);
  expect(harness.recording.attempts[0]).toEqual(expect.objectContaining({ selectionSource: 'provider_qualified' }));
});

describe('shared protocol routing pipeline capability selection', () => {
  test('prefers same-protocol raw capability when the provider also has model capability', async () => {
    const provider = rawProvider({
      id: 'hybrid',
      invoke: async () => Response.json({ transport: 'raw' }),
      model: { invoke: () => textStream('model') },
    });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    expect(await response.json()).toEqual({ transport: 'raw' });
    await settleRecording(harness.recording);
    expect(provider.calls.raw).toHaveLength(1);
    expect(provider.calls.model).toHaveLength(0);
    expect(harness.context.modelInvocationCalls).toBe(0);
    expect(harness.usage.passthrough).toHaveLength(1);
    expect(harness.usage.stream).toHaveLength(0);
    expect(attemptsOf(harness.recording)).toEqual([{ outcome: 'success', providerId: 'hybrid', statusCode: 200 }]);
    expect(harness.recording.begins).toEqual([{ inboundProtocol: ProviderProtocol.OpenAICompatible }]);
    expect(harness.recording.identities).toEqual([{ requestedModelId: REQUESTED_MODEL }]);
    expect(harness.recording.attempts[0]).toEqual(
      expect.objectContaining({
        durationMs: expect.any(Number),
        modelId: 'hybrid-model',
        providerKind: ProviderKind.Api,
        protocol: ProviderProtocol.OpenAICompatible,
      }),
    );
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({
        finalModelId: 'hybrid-model',
        finalProviderId: 'hybrid',
        finalStatusCode: 200,
        outcome: 'success',
      }),
    );
  });

  test('records the selected candidate when model invocation rejects the request', async () => {
    const primary = modelProvider({ id: 'primary', invoke: () => textStream('unused') });
    const backup = modelProvider({ id: 'backup', invoke: () => textStream('unused') });
    const adapter = defineProtocolAdapter(ProviderProtocol.OpenAICompatible, {
      modelInvocationError: new SyntaxError('invalid invocation'),
    });
    const harness = pipeline([primary, backup], { adapter });

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));

    expect(response.status).toBe(400);
    expect(primary.calls.model).toHaveLength(0);
    expect(backup.calls.model).toHaveLength(0);
    expect(harness.recording.finals).toEqual([
      expect.objectContaining({
        errorCode: 'invalid_request',
        finalModelId: 'primary-model',
        finalProviderId: 'primary',
        finalStatusCode: 400,
        outcome: 'failure',
        attempt: expect.objectContaining({
          errorCode: 'invalid_request',
          modelId: 'primary-model',
          outcome: 'failure',
          providerId: 'primary',
          statusCode: 400,
        }),
      }),
    ]);
    expect(harness.logs).toEqual([
      {
        event: 'request.rejected',
        requestId: 'request-1',
        inboundProtocol: ProviderProtocol.OpenAICompatible,
        requestedModelId: REQUESTED_MODEL,
        path: '/v1/test',
        statusCode: 400,
        errorCode: 'invalid_request',
        errorType: 'SyntaxError',
      },
    ]);
  });

  test.each([false, true])('passes the resolved model to %s model egress', async (stream) => {
    const egress: unknown[] = [];
    const provider = modelProvider({ id: 'model', invoke: () => textStream('model') });
    const adapter = defineProtocolAdapter(ProviderProtocol.OpenAICompatible, {
      onModelEgress: (value) => egress.push(value),
    });
    const harness = pipeline([provider], { adapter });

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream }));
    await response.body?.cancel();

    expect(egress).toEqual([{ modelId: 'model-model' }]);
  });
});
