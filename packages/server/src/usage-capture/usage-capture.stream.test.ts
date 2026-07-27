import { describe, expect, test } from 'bun:test';

import type { TextStreamPart, ToolSet } from '@aio-proxy/core';

import { createUsageCapture } from './index';
import { drain, settle } from './test-support';

describe('usage capture stream', () => {
  test('model stream reads stay bounded by downstream demand', async () => {
    let pulls = 0;
    let index = 0;
    const parts = [
      { type: 'text-delta', id: 'text-1', text: 'one' },
      { type: 'text-delta', id: 'text-1', text: 'two' },
      { type: 'text-delta', id: 'text-1', text: 'three' },
    ] as const satisfies readonly TextStreamPart<ToolSet>[];
    const source = new ReadableStream<TextStreamPart<ToolSet>>({
      pull(controller) {
        pulls += 1;
        const part = parts[index];
        index += 1;
        if (part === undefined) controller.close();
        else controller.enqueue(part);
      },
    });
    await settle();
    const beforeCapture = pulls;
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      stream: source,
    });

    await settle();
    expect(pulls).toBeLessThan(parts.length);
    expect(pulls).toBeLessThanOrEqual(beforeCapture + 1);
    const reader = captured.value.getReader();
    for (const part of parts) {
      const before = pulls;
      expect(await reader.read()).toEqual({ done: false, value: part });
      await settle();
      expect(pulls).toBeLessThanOrEqual(before + 1);
    }
    await reader.cancel();
  });

  test('a stream that sends data then errors is failure and preserves the error', async () => {
    const expected = new Error('upstream broke');
    const capture = createUsageCapture();
    const captured = capture.stream({
      providerId: 'provider',
      modelId: 'model',
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'hello' });
          controller.error(expected);
        },
      }),
    });

    await expect(drain(captured.value)).rejects.toBe(expected);
    await expect(captured.completion).resolves.toEqual({ outcome: 'failure' });
  });

  test('an upstream AbortError is cancelled and remains visible to the consumer', async () => {
    const expected = new Error('upstream aborted');
    expected.name = 'AbortError';
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'hello' });
          controller.error(expected);
        },
      }),
    });

    await expect(drain(captured.value)).rejects.toBe(expected);
    await expect(captured.completion).resolves.toEqual({ outcome: 'cancelled' });
  });
});
