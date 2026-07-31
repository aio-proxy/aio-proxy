import { type TextStreamPart, type ToolSet } from '@aio-proxy/core';
import type { UsageRow } from '@aio-proxy/types';

import { isAbortError } from '../route-observation';
import type { ServerLogSink } from '../server-log';
import { normalizeAiSdkUsage } from './pricing';
import {
  type Captured,
  deferred,
  observeContentAt,
  type StreamUsageOptions,
  ttftProperty,
  type UsageCompletion,
  usageProperty,
} from './shared';
import { finalizeUsage } from './usage-validation';

export function streamCapture(
  { stream, providerId, modelId, requestedModelId, startedAt, observation }: StreamUsageOptions,
  logger: ServerLogSink | undefined,
): Captured<ReadableStream<TextStreamPart<ToolSet>>> {
  const terminal = deferred<UsageCompletion>();
  const reader = stream.getReader();
  let cancelled = false;
  let aborted = false;
  let finished = false;
  let finishUsage: UsageRow | undefined;
  let firstTokenAt: number | undefined;
  let released = false;
  const releaseReader = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };

  const value = new ReadableStream<TextStreamPart<ToolSet>>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          releaseReader();
          if (cancelled) return;
          controller.close();
          terminal.resolve(
            aborted
              ? { outcome: 'cancelled', ...ttftProperty(startedAt, firstTokenAt) }
              : finished
                ? {
                    outcome: 'success',
                    ...usageProperty(
                      await finalizeUsage({
                        usage: finishUsage,
                        accounting: { source: 'ai-sdk' },
                        ...(requestedModelId === undefined ? {} : { requestedModelId }),
                        ...(logger === undefined ? {} : { logger }),
                      }),
                    ),
                    ...ttftProperty(startedAt, firstTokenAt),
                  }
                : { outcome: 'failure', ...ttftProperty(startedAt, firstTokenAt) },
          );
          return;
        }
        if (next.value.type === 'finish') {
          finished = true;
          finishUsage = normalizeAiSdkUsage(next.value, providerId, modelId);
        } else if (next.value.type === 'abort') {
          aborted = true;
        } else if (next.value.type === 'text-delta' || next.value.type === 'reasoning-delta') {
          const contentAt = observeContentAt(observation);
          firstTokenAt ??= contentAt;
        }
        controller.enqueue(next.value);
      } catch (error) {
        releaseReader();
        if (cancelled || isAbortError(error)) {
          terminal.resolve({ outcome: 'cancelled', ...ttftProperty(startedAt, firstTokenAt) });
        } else {
          terminal.resolve({ outcome: 'failure', ...ttftProperty(startedAt, firstTokenAt) });
        }
        if (!cancelled) {
          controller.error(error);
        }
      }
    },
    async cancel(reason) {
      cancelled = true;
      terminal.resolve({ outcome: 'cancelled', ...ttftProperty(startedAt, firstTokenAt) });
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
    },
  });

  return { value, completion: terminal.promise };
}
