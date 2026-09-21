import type { InboundCapability } from '@aio-proxy/core';
import { type Attributes, SpanKind } from '@opentelemetry/api';

import { attributeName, type RequestTraceFinishInput, type RequestTraceSession, spanName } from '../../request-tracing';
import { type SpanTerminal, startPipelineSpan } from './tracing';

function inferenceTerminal(input: RequestTraceFinishInput): SpanTerminal {
  return {
    outcome: input.outcome,
    ...(input.outcome === 'failure' && input.errorType !== undefined ? { errorType: input.errorType } : {}),
    ...(input.outcome === 'failure' && input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    ...(input.finalHttpStatus === undefined ? {} : { httpStatus: input.finalHttpStatus }),
  };
}

export type InferenceSpan = {
  // Same session with rootContext swapped for this span's context, so route
  // resolution and every candidate attempt hang under it instead of under root.
  readonly session: RequestTraceSession;
  readonly end: (terminal?: SpanTerminal) => void;
  // Called once per provider attempt so the layer can report how many providers
  // this logical operation went through, and how much of its own duration was
  // burned before the attempt that finally answered.
  readonly noteAttempt: (durationMs: number) => void;
};

// The logical-operation layer: one per request, covering route resolution and
// every candidate attempt including failover.
//
// This is deliberately NOT an inference span. It has no single upstream, so it
// carries neither gen_ai.operation.name nor gen_ai.provider.name — those live on
// the per-provider CLIENT spans underneath. semantic-conventions-genai PR #475:
// "Non-inference spans … MUST NOT be stored under the inference span context key."
//
// gen_ai.request.model is the exception: it says what the caller asked for, which
// is true regardless of which upstream served it, and it is the only way a
// route-resolution failure (no attempt at all) stays retrievable by model.
//
// Failure is decided by how the operation settles, NOT by whether candidates ran
// out: raw.ts can terminate on a non-retryable status while hasNext is still true.
export function startInferenceSpan(
  session: RequestTraceSession,
  capability: InboundCapability,
  requestedModelId: string,
): InferenceSpan {
  const startedAt = performance.now();
  let attemptCount = 0;
  let lastAttemptMs: number | undefined;
  const open = startPipelineSpan(session.rootContext, spanName.inference, {
    kind: SpanKind.INTERNAL,
    attributes: {
      [attributeName.capability]: capability,
      [attributeName.genAiRequestModel]: requestedModelId,
    },
  });

  // This layer's TTFT: from **its own start** to the first chunk, in seconds, so
  // it includes whatever failover burned. Not the same quantity as an attempt
  // span's aio_proxy.attempt.ttft_ms, which starts at that attempt's dispatch.
  const layerAttributes = (input: RequestTraceFinishInput): Attributes => ({
    [attributeName.inferenceAttemptCount]: attemptCount,
    ...(lastAttemptMs === undefined
      ? {}
      : {
          [attributeName.inferenceFailoverMs]: Math.max(0, Math.round(performance.now() - startedAt - lastAttemptMs)),
        }),
    ...(input.firstChunkAt === undefined
      ? {}
      : { [attributeName.genAiTimeToFirstChunk]: Math.max(0, input.firstChunkAt - startedAt) / 1000 }),
    ...(input.finalModelId === undefined ? {} : { [attributeName.genAiResponseModel]: input.finalModelId }),
  });

  // Attributes have to land before end(): setAttributes is discarded once a span
  // is ended, and the buffering processor copies the record out at onEnd.
  // Exception exits call end() rather than finish(); they still need the counts
  // noteAttempt already accumulated.
  const stampLayer = (input: RequestTraceFinishInput = { outcome: 'success' }): void => {
    open.span.setAttributes(layerAttributes(input));
  };
  const settle = (input: RequestTraceFinishInput): void => {
    stampLayer(input);
    open.end(inferenceTerminal(input));
  };
  const end = (terminal?: SpanTerminal): void => {
    stampLayer();
    open.end(terminal);
  };
  return {
    end,
    noteAttempt: (durationMs) => {
      attemptCount += 1;
      lastAttemptMs = durationMs;
    },
    session: {
      ...session,
      rootContext: open.context,
      finish: (input) => {
        settle(input);
        return session.finish(input);
      },
      // Hand the recorder a DERIVED promise rather than the caller's: our
      // callback runs as a link in the chain, not as a co-registered listener,
      // so the ordering is structural instead of depending on registration
      // order. That is what keeps this span alive across a streaming response
      // and still closes it before root.end() runs processor.take(), which
      // drops every span still open.
      finishFrom: (completion) => {
        session.finishFrom(
          completion.then(
            (input) => {
              settle(input);
              return input;
            },
            (error: unknown) => {
              end({ outcome: 'failure' });
              throw error;
            },
          ),
        );
      },
    },
  };
}
