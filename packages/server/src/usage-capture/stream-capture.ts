import { type TextStreamPart, type ToolSet } from '@aio-proxy/core';
import type { UsageRow } from '@aio-proxy/types';

import { isAbortError } from '../route-observation';
import type { ServerLogSink } from '../server-log';
import { normalizeAiSdkUsage } from './pricing';
import {
  type Captured,
  createIdleTimer,
  deferred,
  observeContentAt,
  STREAM_IDLE_TIMEOUT_MS,
  type StreamUsageOptions,
  ttftProperty,
  type UsageCompletion,
  usageProperty,
} from './shared';
import { finalizeUsage } from './usage-validation';

export function streamCapture(
  { stream, providerId, modelId, requestedModelId, startedAt, observation, idleTimeoutMs }: StreamUsageOptions,
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
  let completed = false;
  const releaseReader = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  let idleAborted = false;
  const idle = createIdleTimer(idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS, () => {
    if (completed) return;
    completed = true;
    idleAborted = true;
    terminal.resolve({
      outcome: 'failure',
      errorCode: 'stream_idle_timeout',
      ...ttftProperty(startedAt, firstTokenAt),
    });
    void reader.cancel(new Error('stream_idle_timeout')).catch(() => {});
    releaseReader();
  });
  const complete = async (): Promise<void> => {
    if (completed) return;
    completed = true;
    idle.clear();
    terminal.resolve({
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
    });
  };

  const value = new ReadableStream<TextStreamPart<ToolSet>>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          releaseReader();
          if (cancelled) return;
          // An idle timeout cancels the upstream reader, surfacing here as a normal
          // EOF. Terminate the client stream abnormally so a stalled partial
          // response is not mistaken for a clean, complete one. Completion was
          // already resolved (failure) by the idle timer.
          if (idleAborted) {
            controller.error(new Error('stream_idle_timeout'));
            return;
          }
          controller.close();
          if (aborted) {
            terminal.resolve({ outcome: 'cancelled', ...ttftProperty(startedAt, firstTokenAt) });
          } else if (finished) {
            await complete();
          } else {
            terminal.resolve({ outcome: 'failure', ...ttftProperty(startedAt, firstTokenAt) });
          }
          return;
        }
        if (next.value.type === 'finish') {
          finished = true;
          finishUsage = normalizeAiSdkUsage(next.value, providerId, modelId);
          controller.enqueue(next.value);
          void complete();
          return;
        }
        if (next.value.type === 'abort') {
          aborted = true;
        } else if (next.value.type === 'text-delta' || next.value.type === 'reasoning-delta') {
          const contentAt = observeContentAt(observation);
          firstTokenAt ??= contentAt;
        }
        controller.enqueue(next.value);
        idle.arm();
      } catch (error) {
        idle.clear();
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
      idle.clear();
      cancelled = true;
      terminal.resolve({ outcome: 'cancelled', ...ttftProperty(startedAt, firstTokenAt) });
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
    },
  });

  idle.arm();

  return { value, completion: terminal.promise };
}
