import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { type TextStreamPart, type ToolSet } from '@aio-proxy/core';

import { createUsageCapture } from './index';
import { clearPriceCatalog, finishPart, seedPriceCatalog } from './test-support';

function partsStream(
  parts: readonly TextStreamPart<ToolSet>[],
  gate: Promise<void>,
): ReadableStream<TextStreamPart<ToolSet>> {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index < parts.length) {
        // Gate everything AFTER the first part so the terminal-resolve path is
        // exercised while the stream is still open.
        if (index > 0) await gate;
        controller.enqueue(parts[index]!);
        index += 1;
        return;
      }
      controller.close();
    },
  });
}

const trailingPart = { type: 'text-delta', id: 'text-1', text: 'trailing' } as TextStreamPart<ToolSet>;

describe('stream capture terminal early completion', () => {
  beforeEach(async () => {
    await seedPriceCatalog([]);
  });

  afterEach(() => {
    clearPriceCatalog();
  });

  test('resolves success at finish part before the trailing part is released', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      stream: partsStream([finishPart(), trailingPart], gate),
    });

    const completion = await captured.completion;
    expect(completion.outcome).toBe('success');

    // trailing part still reaches the consumer.
    release?.();
    const reader = captured.value.getReader();
    const collected: TextStreamPart<ToolSet>[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      collected.push(next.value);
    }
    expect(collected.map((p) => p.type)).toEqual(['finish', 'text-delta']);
  });
});
