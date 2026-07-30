import { describe, expect, test } from 'bun:test';

import type { TextStreamPart, ToolSet } from '@aio-proxy/core';

import { createAttemptResponseObservation } from '../response-observation';
import { createUsageCapture } from './index';
import { drain, settle } from './test-support';

describe('usage capture stream', () => {
  test('model capture records every content delta and ignores metadata and tool deltas', async () => {
    const times = [100, 105];
    const observation = createAttemptResponseObservation({ startedAt: 90, now: () => times.shift() ?? 105 });
    const stream = new ReadableStream<TextStreamPart<ToolSet>>({
      start(controller) {
        controller.enqueue({ type: 'tool-input-delta', id: 'tool-1', delta: '{' });
        controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'a' });
        controller.enqueue({ type: 'reasoning-delta', id: 'reasoning-1', text: 'b' });
        controller.close();
      },
    });
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      startedAt: 90,
      observation,
      stream,
    });

    await drain(captured.value);

    expect(observation.snapshot().contentGapP95Ms).toBe(5);
  });

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
