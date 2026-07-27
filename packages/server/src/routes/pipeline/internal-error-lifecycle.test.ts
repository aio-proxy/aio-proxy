import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { defineProtocolAdapter, jsonRequest, REQUESTED_MODEL, rawProvider } from '../../../__tests__/pipeline-helpers';
import { pipeline } from './test-support';

describe('shared protocol pipeline internal-error lifecycle', () => {
  test('classifies only a real inbound parse abort as cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = new DOMException('client disconnected', 'AbortError');
    const aborted = pipeline([rawProvider({ id: 'raw' })], {
      adapter: defineProtocolAdapter(ProviderProtocol.OpenAICompatible, { parseError: abortError }),
    });

    await expect(aborted.run(jsonRequest({ model: REQUESTED_MODEL }, { signal: controller.signal }))).rejects.toBe(
      abortError,
    );

    expect(aborted.recording.finals).toEqual([{ outcome: 'cancelled' }]);
    expect(aborted.logs).toEqual([]);

    const failure = new Error('unexpected parse failure');
    const failed = pipeline([rawProvider({ id: 'raw' })], {
      adapter: defineProtocolAdapter(ProviderProtocol.OpenAICompatible, { parseError: failure }),
    });

    await expect(failed.run(jsonRequest({ model: REQUESTED_MODEL }, { signal: controller.signal }))).rejects.toBe(
      failure,
    );

    expect(failed.recording.finals).toEqual([{ outcome: 'failure', errorCode: 'internal_error' }]);
    expect(failed.logs).toEqual([
      expect.objectContaining({ event: 'request.failed', errorCode: 'internal_error', errorType: 'Error' }),
    ]);
  });

  test('finishes a pending session before rethrowing an unmapped error', async () => {
    const failure = new Error('unexpected parse failure');
    const provider = rawProvider({ id: 'raw' });
    const harness = pipeline([provider], {
      adapter: defineProtocolAdapter(ProviderProtocol.OpenAICompatible, { parseError: failure }),
    });

    await expect(harness.run(jsonRequest({ model: REQUESTED_MODEL }))).rejects.toBe(failure);

    expect(harness.recording.begins).toEqual([{ inboundProtocol: ProviderProtocol.OpenAICompatible }]);
    expect(harness.recording.identities).toEqual([]);
    expect(harness.recording.attempts).toEqual([]);
    expect(harness.recording.finals).toEqual([{ outcome: 'failure', errorCode: 'internal_error' }]);
    expect(harness.logs).toEqual([
      {
        event: 'request.failed',
        requestId: 'request-1',
        inboundProtocol: ProviderProtocol.OpenAICompatible,
        path: '/v1/test',
        errorCode: 'internal_error',
        errorType: 'Error',
      },
    ]);
    expect(provider.calls.raw).toEqual([]);
  });

  test('preserves and cleans up a protected error without rereading protocol', async () => {
    const first = new Error('unexpected parse failure');
    const later = new Error('protocol reread failed');
    const baseAdapter = defineProtocolAdapter(ProviderProtocol.OpenAICompatible, { parseError: first });
    let protocolReads = 0;
    const adapter = {
      ...baseAdapter,
      get protocol() {
        protocolReads += 1;
        if (protocolReads > 2) throw later;
        return baseAdapter.protocol;
      },
    };
    const provider = rawProvider({ id: 'raw' });
    const harness = pipeline([provider], { adapter, debugLogging: true });
    const request = jsonRequest({ model: REQUESTED_MODEL });

    await expect(harness.run(request)).rejects.toBe(first);

    expect(protocolReads).toBe(1);
    expect(harness.context.parseCalls).toBe(1);
    expect(harness.recording.identities).toEqual([]);
    expect(harness.recording.attempts).toEqual([]);
    expect(harness.recording.finals).toEqual([{ outcome: 'failure', errorCode: 'internal_error' }]);
    expect(request.bodyUsed).toBe(true);
    expect(provider.calls.raw).toEqual([]);
  });

  test('preserves the current attempt when an unmapped provider error is rethrown', async () => {
    const failure = Object.freeze({ kind: 'unexpected-provider-failure' });
    const provider = rawProvider({
      id: 'raw',
      invoke: async () => {
        throw failure;
      },
    });
    const harness = pipeline([provider]);

    await expect(harness.run(jsonRequest({ model: REQUESTED_MODEL }))).rejects.toBe(failure);

    expect(harness.recording.attempts).toEqual([
      expect.objectContaining({
        providerId: 'raw',
        modelId: 'raw-model',
        outcome: 'failure',
      }),
    ]);
    expect(harness.recording.finals).toEqual([{ outcome: 'failure', errorCode: 'internal_error' }]);
    expect(harness.logs).toEqual([
      {
        event: 'request.provider_attempt_failed',
        requestId: 'request-1',
        inboundProtocol: ProviderProtocol.OpenAICompatible,
        requestedModelId: REQUESTED_MODEL,
        path: '/v1/test',
        attemptIndex: 0,
        providerId: 'raw',
        providerKind: 'api',
        modelId: 'raw-model',
        durationMs: expect.any(Number),
        failureKind: 'exception',
        fallback: false,
        errorType: 'Object',
      },
      {
        event: 'request.failed',
        requestId: 'request-1',
        inboundProtocol: ProviderProtocol.OpenAICompatible,
        requestedModelId: REQUESTED_MODEL,
        path: '/v1/test',
        errorCode: 'internal_error',
        errorType: 'Object',
      },
    ]);
  });
});
