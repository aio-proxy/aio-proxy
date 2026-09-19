import type { InboundCapability } from '@aio-proxy/core';
import { SpanKind } from '@opentelemetry/api';

import { attributeName, type RequestTraceFinishInput, type RequestTraceSession } from '../../request-tracing';
import { type SpanTerminal, startPipelineSpan } from './tracing';

// Span-name verb per capability. Only `chat` and `embeddings` are registered
// gen_ai.operation.name values, so the other four name the span without
// claiming an attribute value the semantic conventions do not define.
const OPERATION_VERB: Record<InboundCapability, string> = {
  language: 'chat',
  embedding: 'embeddings',
  image: 'image',
  speech: 'speech',
  transcription: 'transcription',
  video: 'video',
};

const GEN_AI_OPERATION: Partial<Record<InboundCapability, string>> = {
  language: 'chat',
  embedding: 'embeddings',
};

function inferenceTerminal(input: RequestTraceFinishInput): SpanTerminal {
  return {
    outcome: input.outcome,
    ...(input.outcome === 'failure' && input.errorType !== undefined ? { errorType: input.errorType } : {}),
    ...(input.outcome === 'failure' && input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    ...(input.finalHttpStatus === undefined ? {} : { httpStatus: input.finalHttpStatus }),
  };
}

export type InferenceSpan = {
  // Same session with rootContext swapped for the inference span's context, so
  // everything the candidate loop opens hangs under it instead of under root.
  readonly session: RequestTraceSession;
  readonly end: (terminal?: SpanTerminal) => void;
};

// The one GENERATION span: exactly one per logical operation, the only span
// allowed to carry gen_ai.* attributes. Failure is decided by how the operation
// settles, NOT by whether candidates ran out.
export function startInferenceSpan(
  session: RequestTraceSession,
  capability: InboundCapability,
  requestedModelId: string,
): InferenceSpan {
  const genAiOperation = GEN_AI_OPERATION[capability];
  const open = startPipelineSpan(session.rootContext, `${OPERATION_VERB[capability]} ${requestedModelId}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      [attributeName.capability]: capability,
      [attributeName.genAiRequestModel]: requestedModelId,
      ...(genAiOperation === undefined ? {} : { [attributeName.genAiOperationName]: genAiOperation }),
    },
  });
  return {
    end: open.end,
    session: {
      ...session,
      rootContext: open.context,
      finish: (input) => {
        open.end(inferenceTerminal(input));
        return session.finish(input);
      },
      // Attaching our callback to the completion BEFORE handing it to the
      // recorder is what keeps this span alive across a streaming response and
      // still closes it before root.end() runs processor.take(), which drops
      // every span still open.
      finishFrom: (completion) => {
        session.finishFrom(
          completion.then(
            (input) => {
              open.end(inferenceTerminal(input));
              return input;
            },
            (error: unknown) => {
              open.end({ outcome: 'failure' });
              throw error;
            },
          ),
        );
      },
    },
  };
}
