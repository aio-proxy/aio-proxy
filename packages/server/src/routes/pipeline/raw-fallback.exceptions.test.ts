import { describe, expect, test } from 'bun:test';

import type { AiSdkProviderInstance, ApiProviderInstance } from '@aio-proxy/core';
import { ConfigSchema, ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import {
  type FakeProvider,
  jsonRequest,
  REQUESTED_MODEL,
  rawProvider,
  settleRecording,
} from '../../../__tests__/pipeline-helpers';
import { materializeProviders } from '../../provider-runtime';
import { attemptsOf, pipeline } from './test-support';

describe('shared protocol routing pipeline raw exception logging', () => {
  test('falls back after a raw network throw', async () => {
    const cause = Object.assign(new Error('cause-message-sentinel'), { code: 'ECONNREFUSED' });
    const failure = Object.assign(new Error('exception-message-sentinel'), {
      code: 'ConnectionRefused',
      cause,
      errno: -61,
      syscall: 'connect',
    });
    const primary = rawProvider({
      id: 'primary',
      invoke: async () => {
        throw failure;
      },
    });
    const backup = rawProvider({ id: 'backup' });
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    expect(await response.json()).toEqual({ provider: 'backup' });
    await settleRecording(harness.recording);
    expect(primary.calls.raw).toHaveLength(1);
    expect(backup.calls.raw).toHaveLength(1);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: 'failure', providerId: 'primary', statusCode: 502 },
      { outcome: 'success', providerId: 'backup', statusCode: 200 },
    ]);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        event: 'request.provider_attempt_failed',
        attemptIndex: 0,
        providerId: 'primary',
        statusCode: 502,
        failureKind: 'exception',
        fallback: true,
        errorType: 'Error',
        exceptionCode: 'ConnectionRefused',
        causeCode: 'ECONNREFUSED',
        errno: -61,
        syscall: 'connect',
      }),
    );
    expect(JSON.stringify(harness.logs)).not.toContain('exception-message-sentinel');
    expect(JSON.stringify(harness.logs)).not.toContain('cause-message-sentinel');
  });

  test('safe exception logging never invokes code accessors', async () => {
    let getterCalls = 0;
    const failure = new Error('exception-message-sentinel');
    Object.defineProperty(failure, 'code', {
      get() {
        getterCalls += 1;
        return 'accessor-code-sentinel';
      },
    });
    const primary = rawProvider({
      id: 'primary',
      invoke: async () => {
        throw failure;
      },
    });
    const harness = pipeline([primary, rawProvider({ id: 'backup' })]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    expect(await response.json()).toEqual({ provider: 'backup' });
    await settleRecording(harness.recording);
    expect(getterCalls).toBe(0);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        event: 'request.provider_attempt_failed',
        attemptIndex: 0,
        providerId: 'primary',
        failureKind: 'exception',
      }),
    );
    expect(JSON.stringify(harness.logs)).not.toContain('exception-message-sentinel');
    expect(JSON.stringify(harness.logs)).not.toContain('accessor-code-sentinel');
  });

  test('transform exceptions send nothing, log safe coordinates, and fall back', async () => {
    const config = ConfigSchema.parse({
      providers: {
        broken: {
          alias: { [REQUESTED_MODEL]: { model: 'broken-model' } },
          baseURL: 'https://broken.example.test/v1',
          kind: ProviderKind.Api,
          models: ['broken-model'],
          protocol: ProviderProtocol.OpenAICompatible,
          transforms: {
            request: [
              {
                name: 'broken-rule',
                update: [
                  {
                    $set: {
                      'request.headers': {
                        $setField: {
                          field: 'x-broken',
                          input: '$request.headers',
                          value: { $add: [{ $literal: 'secret-operand' }, 1] },
                        },
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
        backup: {
          alias: { [REQUESTED_MODEL]: { model: 'backup-model' } },
          baseURL: 'https://backup.example.test/v1',
          kind: ProviderKind.Api,
          models: ['backup-model'],
          protocol: ProviderProtocol.OpenAICompatible,
        },
      },
    });
    const providerIds = ['broken', 'backup'] as const;
    const baseCalls = new Map(providerIds.map((providerId) => [providerId, [] as Request[]]));
    let fetchIndex = 0;
    const runtime = materializeProviders(config, {
      createProxyFetch() {
        const providerId = providerIds[fetchIndex++]!;
        return (async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          baseCalls.get(providerId)!.push(request);
          return Response.json({ provider: providerId });
        }) as typeof globalThis.fetch;
      },
      createApiProvider(provider, options) {
        const passthrough = (request: Request) => options.fetch(request);
        return {
          ...provider,
          endpointTransports: [{ protocol: provider.protocol, passthrough }],
          passthrough,
        } satisfies ApiProviderInstance;
      },
      bridgeApiProvider(provider) {
        return {
          enabled: true,
          id: `${provider.id}:bridge`,
          invoke: () => new ReadableStream(),
          kind: ProviderKind.AiSdk,
        } satisfies AiSdkProviderInstance;
      },
    });
    const fixtures: FakeProvider[] = runtime.providers.map((provider) => ({
      provider,
      calls: { ensure: 0, model: [], raw: [] },
    }));
    const harness = pipeline(fixtures);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));

    expect(await response.json()).toEqual({ provider: 'backup' });
    await settleRecording(harness.recording);
    expect(baseCalls.get('broken')).toHaveLength(0);
    expect(baseCalls.get('backup')).toHaveLength(1);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        event: 'request.provider_attempt_failed',
        providerId: 'broken',
        failureKind: 'exception',
        fallback: true,
        exceptionCode: 'REQUEST_TRANSFORM_EVALUATION_FAILED',
        transformRuleIndex: 0,
        transformRuleName: 'broken-rule',
        transformStageIndex: 0,
      }),
    );
    expect(JSON.stringify(harness.logs)).not.toContain('secret-operand');
  });
});
