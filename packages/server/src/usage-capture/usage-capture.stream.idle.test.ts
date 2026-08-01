import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { type TextStreamPart, type ToolSet } from '@aio-proxy/core';

import { createUsageCapture } from './index';
import { clearPriceCatalog, seedPriceCatalog } from './test-support';

describe('stream capture idle timeout', () => {
  beforeEach(async () => {
    await seedPriceCatalog([]);
  });

  afterEach(() => {
    clearPriceCatalog();
  });

  test('stalled AI SDK stream resolves failure with stream_idle_timeout and cancels upstream', async () => {
    let cancelled = false;
    const stalling = new ReadableStream<TextStreamPart<ToolSet>>({
      start(controller) {
        controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'hi' } as TextStreamPart<ToolSet>);
      },
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      stream: stalling,
      idleTimeoutMs: 40,
    });

    const reader = captured.value.getReader();
    await reader.read();

    await expect(captured.completion).resolves.toEqual({ outcome: 'failure', errorCode: 'stream_idle_timeout' });
    expect(cancelled).toBe(true);
  });
});
