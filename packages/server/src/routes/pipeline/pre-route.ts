import type { PrivateEvaluation, ResponsesPreRouteWrap } from '@aio-proxy/core';
import type { LogicalRequestContext } from '@aio-proxy/plugin-sdk';

import type { InferenceSpan } from './inference-span';
import { cancelRetainedRequestBody } from './request';

export async function invokeResponsesPreRoute(input: {
  readonly hook: ResponsesPreRouteWrap;
  readonly request: Request;
  readonly logicalRequest: LogicalRequestContext;
  readonly evaluate: PrivateEvaluation;
  readonly signal: AbortSignal;
}): Promise<Response | undefined> {
  input.signal.throwIfAborted();
  const clone = input.request.clone();
  let response: Response | undefined;
  try {
    response = await input.hook({ evaluate: input.evaluate })(clone, input.logicalRequest);
    input.signal.throwIfAborted();
    return response;
  } catch (error) {
    if (input.signal.aborted) {
      void response?.body?.cancel(input.signal.reason).catch(() => undefined);
      throw error;
    }
    return undefined;
  } finally {
    // Do not await tee cancellation: the untouched ingress branch is still
    // owned by the normal route-miss response path.
    void cancelRetainedRequestBody(clone, input.signal.reason ?? 'pre-route settled');
  }
}

export function completePreRouteResponse(input: {
  readonly inference: InferenceSpan;
  readonly response: Response;
  readonly signal: AbortSignal;
  readonly release: () => void;
  readonly deferRelease: () => void;
}): Response {
  input.signal.throwIfAborted();
  const contentType = input.response.headers.get('content-type')?.toLowerCase() ?? '';
  const stream = contentType.includes('text/event-stream') && input.response.body !== null;
  if (!stream || input.response.body === null) {
    input.inference.session.finish({
      outcome: 'success',
      finalHttpStatus: input.response.status,
      clientResponse: input.response,
    });
    return input.response;
  }

  const reader = input.response.body.getReader();
  let settled = false;
  let abortListener: (() => void) | undefined;
  let resolveCompletion!: (value: { readonly outcome: 'success' | 'failure' | 'cancelled' }) => void;
  const completion = new Promise<{ readonly outcome: 'success' | 'failure' | 'cancelled' }>((resolve) => {
    resolveCompletion = resolve;
  });
  const settle = (outcome: 'success' | 'failure' | 'cancelled') => {
    if (settled) return;
    settled = true;
    if (abortListener !== undefined) input.signal.removeEventListener('abort', abortListener);
    resolveCompletion({ outcome });
  };
  abortListener = () => {
    void reader.cancel(input.signal.reason).catch(() => undefined);
    settle('cancelled');
  };
  input.signal.addEventListener('abort', abortListener, { once: true });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          settle('success');
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        settle(input.signal.aborted ? 'cancelled' : 'failure');
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        settle(input.signal.aborted ? 'cancelled' : 'failure');
      }
    },
  });
  input.deferRelease();
  input.inference.session.finishFrom(
    completion.then((terminal) => {
      input.release();
      return {
        outcome: terminal.outcome,
        finalHttpStatus: input.response.status,
        ...(terminal.outcome === 'success' ? { clientResponse: input.response } : {}),
      };
    }),
  );
  return new Response(body, {
    headers: input.response.headers,
    status: input.response.status,
    statusText: input.response.statusText,
  });
}
