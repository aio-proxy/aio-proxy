import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { createUsageCapture } from './index';

function ssePassthrough(body: string) {
  return createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    protocol: ProviderProtocol.OpenAICompatible,
    providerId: 'provider',
    modelId: 'model',
    startedAt: performance.now(),
  });
}

async function drain(response: Response): Promise<void> {
  await response.text();
}

describe('usage capture passthrough ttft', () => {
  test('records ttft only once a content delta arrives, not on the first byte', async () => {
    const captured = ssePassthrough(
      // Lifecycle/role frame first (no generated content), then a content delta.
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
    );
    await drain(captured.value);
    const completion = await captured.completion;

    expect(completion.outcome).toBe('success');
    const ttftMs = 'ttftMs' in completion ? completion.ttftMs : undefined;
    expect(typeof ttftMs).toBe('number');
    expect(ttftMs).toBeGreaterThanOrEqual(0);
  });

  test('omits ttft when the stream carries no content delta', async () => {
    const captured = ssePassthrough(
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":0,"total_tokens":3}}\n\n',
    );
    await drain(captured.value);
    const completion = await captured.completion;

    expect(completion.outcome).toBe('success');
    expect('ttftMs' in completion ? completion.ttftMs : undefined).toBeUndefined();
  });
});
