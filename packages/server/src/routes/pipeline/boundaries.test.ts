import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { jsonRequest, REQUESTED_MODEL, rawProvider } from '../../../__tests__/pipeline-helpers';
import { MAX_BODY_BYTES, pipeline } from './test-support';

describe('shared protocol routing pipeline request guards', () => {
  test('rejects Content-Length above 64 MiB before parse or provider dispatch', async () => {
    const provider = rawProvider({ id: 'raw' });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest('{', { contentLength: MAX_BODY_BYTES + 1 }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: 'too_large', message: 'Request body too large' } });
    expect(harness.context.parseCalls).toBe(0);
    expect(harness.recording.begins).toEqual([{ inboundProtocol: ProviderProtocol.OpenAICompatible }]);
    expect(provider.calls.raw).toEqual([]);
  });

  test('accepts Content-Length at the 64 MiB boundary', async () => {
    const provider = rawProvider({ id: 'raw' });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }, { contentLength: MAX_BODY_BYTES }));

    expect(response.status).toBe(200);
    expect(harness.context.parseCalls).toBe(1);
    expect(provider.calls.raw).toHaveLength(1);
  });

  test('rejects malformed Content-Length before parse or provider dispatch', async () => {
    const provider = rawProvider({ id: 'raw' });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }, { contentLength: 'invalid' }));

    expect(response.status).toBe(413);
    expect(harness.context.parseCalls).toBe(0);
    expect(harness.recording.begins).toEqual([{ inboundProtocol: ProviderProtocol.OpenAICompatible }]);
    expect(provider.calls.raw).toEqual([]);
  });

  test('maps parse errors without beginning a provider attempt', async () => {
    const provider = rawProvider({ id: 'raw' });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest('{'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 'request_error', message: 'Invalid test request' } });
    expect(harness.recording.begins).toEqual([{ inboundProtocol: ProviderProtocol.OpenAICompatible }]);
    expect(provider.calls.raw).toEqual([]);
  });

  test('maps model-not-found without beginning a provider attempt', async () => {
    const provider = rawProvider({ id: 'raw' });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest({ model: 'missing' }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'model_not_found', message: expect.stringContaining('missing') },
    });
    expect(harness.recording.begins).toEqual([{ inboundProtocol: ProviderProtocol.OpenAICompatible }]);
    expect(harness.recording.identities).toEqual([{ requestedModelId: 'missing' }]);
    expect(provider.calls.raw).toEqual([]);
  });
});
