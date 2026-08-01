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
  // Trace settlement (usage/timing/outcome) and transport lifecycle (reader) are
  // tracked separately: an AI SDK `finish` part settles the trace early, but the
  // transport stays live until EOF/cancel/idle. Conflating them let a cancel
  // after `finish` overwrite a success, and disabled the idle timer post-finish.
  let traceSettled = false;
  let transportClosed = false;
  let idleAborted = false;
  const releaseReader = () => {
    if (transportClosed) return;
    transportClosed = true;
    reader.releaseLock();
  };
  const settleTrace = (completion: UsageCompletion): void => {
    if (traceSettled) return;
    traceSettled = true;
    terminal.resolve(completion);
  };
  const idle = createIdleTimer(idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS, () => {
    if (transportClosed) return;
    idleAborted = true;
    // The trace may already be settled (finish part seen); only fill in a failure
    // outcome if it is not, but always tear down the stalled transport.
    settleTrace({ outcome: 'failure', errorCode: 'stream_idle_timeout', ...ttftProperty(startedAt, firstTokenAt) });
    void reader.cancel(new Error('stream_idle_timeout')).catch(() => {});
    releaseReader();
  });
  const complete = async (): Promise<void> => {
    if (traceSettled) return;
    // Decide the trace outcome synchronously (before the await) so a cancel or
    // idle fire racing the async usage lookup cannot overwrite it.
    traceSettled = true;
    idle.clear();
    const usage = await finalizeUsage({
      usage: finishUsage,
      accounting: { source: 'ai-sdk' },
      ...(requestedModelId === undefined ? {} : { requestedModelId }),
      ...(logger === undefined ? {} : { logger }),
    });
    terminal.resolve({
      outcome: 'success',
      ...usageProperty(usage),
      ...ttftProperty(startedAt, firstTokenAt),
    });
  };

  const value = new ReadableStream<TextStreamPart<ToolSet>>({
    async pull(controller) {
      try {
        // Arm only around the pending upstream read so the timeout measures
        // upstream stalls, not time spent waiting for downstream (client) demand.
        idle.arm();
        const next = await reader.read();
        idle.clear();
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
            settleTrace({ outcome: 'cancelled', ...ttftProperty(startedAt, firstTokenAt) });
          } else if (finished) {
            await complete();
          } else {
            settleTrace({ outcome: 'failure', ...ttftProperty(startedAt, firstTokenAt) });
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
      } catch (error) {
        idle.clear();
        releaseReader();
        if (cancelled || isAbortError(error)) {
          settleTrace({ outcome: 'cancelled', ...ttftProperty(startedAt, firstTokenAt) });
        } else {
          settleTrace({ outcome: 'failure', ...ttftProperty(startedAt, firstTokenAt) });
        }
        if (!cancelled) {
          controller.error(error);
        }
      }
    },
    async cancel(reason) {
      idle.clear();
      cancelled = true;
      // A cancel after the trace already settled (e.g. client disconnects just
      // after the finish part) must not overwrite the recorded outcome.
      settleTrace({ outcome: 'cancelled', ...ttftProperty(startedAt, firstTokenAt) });
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
    },
  });

  // The idle timer is armed per-read inside pull, not here: it must measure only
  // the pending upstream read window, never idle client demand between pulls.
  return { value, completion: terminal.promise };
}
