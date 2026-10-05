import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import type { TextStreamPart, ToolSet } from '@aio-proxy/core';

import { createLiveMetrics } from '../live-metrics';
import { liveModelKey } from '../live-metrics';
import { createAttemptResponseObservation } from '../response-observation';
import { createUsageCapture } from './index';
import { clearPriceCatalog, drain, finishPart, seedPriceCatalog, settle, textStream } from './test-support';

const KEY = liveModelKey('p', 'm');

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
    const completion = await captured.completion;

    expect(observation.snapshot().contentGapP95Ms).toBe(5);
    expect('ttftMs' in completion ? completion.ttftMs : undefined).toBe(10);
  });

  test('continues when content observation throws', async () => {
    const base = createAttemptResponseObservation({ startedAt: 0 });
    const observation = {
      ...base,
      observeContent: () => {
        throw new Error('observer failed');
      },
    };
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      startedAt: 0,
      observation,
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'hello' });
          controller.close();
        },
      }),
    });

    await expect(drain(captured.value)).resolves.toEqual([{ type: 'text-delta', id: 'text-1', text: 'hello' }]);
    const completion = await captured.completion;
    expect('ttftMs' in completion ? completion.ttftMs : undefined).toEqual(expect.any(Number));
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

describe('stream live throughput', () => {
  beforeEach(() => seedPriceCatalog([]));
  afterEach(() => clearPriceCatalog());

  test.each([true, false, undefined])('records and calibrates only when live is enabled: %s', async (live) => {
    const liveMetrics = createLiveMetrics();
    const record = spyOn(liveMetrics, 'recordContent');
    const calibrate = spyOn(liveMetrics, 'calibrate');
    const finish = {
      type: 'finish',
      finishReason: 'stop',
      rawFinishReason: 'stop',
      totalUsage: {
        inputTokens: 1,
        outputTokens: 3,
        totalTokens: 4,
        inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 1 },
        outputTokenDetails: { reasoningTokens: 1, textTokens: 2 },
      },
    } satisfies TextStreamPart<ToolSet>;
    const captured = createUsageCapture({ liveMetrics }).stream({
      providerId: 'p',
      modelId: 'm',
      ...(live === undefined ? {} : { live }),
      stream: textStream([
        { type: 'text-delta', id: 't', text: 'hello' },
        { type: 'text-delta', id: 't', text: '世界' },
        { type: 'reasoning-delta', id: 'r', text: 'ab' },
        { type: 'tool-input-delta', id: 'tool', delta: 'ignored' },
        finish,
      ]),
    });
    await drain(captured.value);
    expect((await captured.completion).outcome).toBe('success');
    expect(record.mock.calls).toEqual(
      live
        ? [
            [KEY, 5],
            [KEY, 2],
            [KEY, 2],
          ]
        : [],
    );
    expect(calibrate.mock.calls).toEqual(live ? [[KEY, 9, 3]] : []);
  });

  test.each(['failure', 'cancel', 'idle', 'after-finish'] as const)(
    'calibration follows upstream success: %s',
    async (mode) => {
      const liveMetrics = createLiveMetrics();
      const calibrate = spyOn(liveMetrics, 'calibrate');
      let upstream!: ReadableStreamDefaultController<TextStreamPart<ToolSet>>;
      const captured = createUsageCapture({ liveMetrics }).stream({
        providerId: 'p',
        modelId: 'm',
        live: true,
        idleTimeoutMs: 10,
        stream: new ReadableStream({
          start(controller) {
            upstream = controller;
            controller.enqueue({ type: 'text-delta', id: 't', text: 'hello' });
          },
        }),
      });
      const reader = captured.value.getReader();
      await reader.read();
      if (mode === 'after-finish') {
        upstream.enqueue(finishPart());
        await reader.read();
        expect((await captured.completion).outcome).toBe('success');
        await reader.cancel();
        expect(calibrate.mock.calls).toEqual([[KEY, 5, 6]]);
      } else {
        if (mode === 'failure') {
          upstream.error(new Error('upstream failed'));
          await expect(reader.read()).rejects.toThrow('upstream failed');
        }
        if (mode === 'cancel') await reader.cancel();
        if (mode === 'idle') await expect(reader.read()).rejects.toThrow('stream_idle_timeout');
        expect((await captured.completion).outcome).toBe(mode === 'cancel' ? 'cancelled' : 'failure');
        expect(calibrate).not.toHaveBeenCalled();
      }
    },
  );
});
