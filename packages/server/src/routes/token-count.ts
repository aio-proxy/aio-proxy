import {
  assertImageInputSupported,
  type ModelInvocation,
  type ProtocolAdapter,
  RequestBodyTooLargeError,
  RouterModelNotFoundError,
  type RouterResolution,
  UnsupportedContentEncodingError,
} from '@aio-proxy/core';
import type { LogicalRequestContext, TokenCountInput } from '@aio-proxy/plugin-sdk';
import { context } from '@opentelemetry/api';

import { observeInboundRequest, withAttemptLogContext, withRequestLogContext } from '../request-logging';
import { attributeName, type RequestTraceSession, spanName } from '../request-tracing';
import type { ProviderRouteSource, RuntimeProviderInstance } from '../runtime';
import { hasInvalidOrOversizedContentLength } from './pipeline';
import { failureTerminal } from './pipeline/failure';
import { cancelRetainedRequestBody } from './pipeline/request';
import { type OpenSpan, startPipelineSpan } from './pipeline/tracing';

export type HandleTokenCountOptions<TRequest, TContext> = {
  readonly adapter: ProtocolAdapter<TRequest, TContext>;
  readonly context: TContext;
  readonly format: (inputTokens: number) => unknown;
  readonly rawRequest: Request;
  readonly source: ProviderRouteSource;
};

export async function handleTokenCount<TRequest, TContext>(
  options: HandleTokenCountOptions<TRequest, TContext>,
): Promise<Response> {
  const { adapter, rawRequest, source } = options;
  const session = source.requestRecorder.begin({
    headers: rawRequest.headers,
    inboundProtocol: adapter.protocol,
    operation: 'token_count',
  });
  return await context.with(session.rootContext, () =>
    withRequestLogContext(
      {
        requestId: session.requestId,
        debug: source.debugLogging === true,
        logger: source.logger,
      },
      async () => {
        const observedRequest = observeInboundRequest(rawRequest, adapter.protocol);
        return await handleTokenCountInContext({ ...options, rawRequest: observedRequest }, session);
      },
    ),
  );
}

async function handleTokenCountInContext<TRequest, TContext>(
  { adapter, context, format, rawRequest, source }: HandleTokenCountOptions<TRequest, TContext>,
  session: RequestTraceSession,
): Promise<Response> {
  if (hasInvalidOrOversizedContentLength(rawRequest)) {
    await cancelRetainedRequestBody(rawRequest, new RequestBodyTooLargeError('Request body too large'));
    return finishRejected(session, adapter.errors.tooLarge());
  }

  let request: TRequest;
  let invocation: ModelInvocation;
  try {
    request = await adapter.parse(rawRequest, context);
    invocation = adapter.modelInvocation(request, context);
  } catch (error) {
    await cancelRetainedRequestBody(rawRequest, error);
    if (error instanceof RequestBodyTooLargeError) return finishRejected(session, adapter.errors.tooLarge());
    if (error instanceof UnsupportedContentEncodingError) {
      return finishRejected(session, adapter.errors.unsupportedContentEncoding());
    }
    const mapped = adapter.errors.requestError(error);
    if (mapped !== undefined) return finishRejected(session, mapped);
    throw error;
  }

  try {
    const requestedModel = adapter.model(request, context);
    const resolution = source.logicalSessionStore.begin({
      requestedModelId: requestedModel,
      hints: adapter.session?.(request, context) ?? { candidates: [], transcript: request },
      headers: rawRequest.headers,
    });
    session.identify({ requestedModelId: requestedModel, resolution, mutateSessionState: false });
    const lease = source.acquireProviderSnapshot();
    try {
      const candidates = lease.snapshot.router.resolve(requestedModel, adapter.variant(request, context));
      return await countCandidates({
        adapter,
        candidates,
        context: resolution.context,
        format,
        invocation,
        rawRequest,
        request,
        session,
      });
    } catch (error) {
      if (error instanceof RouterModelNotFoundError) return adapter.errors.modelNotFound(error.message);
      throw error;
    } finally {
      lease.release();
    }
  } finally {
    void cancelRetainedRequestBody(rawRequest, 'request body no longer needed');
  }
}

// Client errors (oversized body, unparseable request, unsupported encoding)
// return before any provider attempt. begin() already persisted a running root,
// so finish it as a terminal failure instead of leaving it running forever.
function finishRejected(session: RequestTraceSession, response: Response): Response {
  session.finish({ outcome: 'failure', finalHttpStatus: response.status });
  return response;
}

type CountCandidatesOptions<TRequest, TContext> = {
  readonly adapter: ProtocolAdapter<TRequest, TContext>;
  readonly candidates: readonly RouterResolution<RuntimeProviderInstance>[];
  readonly context: LogicalRequestContext;
  readonly format: (inputTokens: number) => unknown;
  readonly invocation: ModelInvocation;
  readonly rawRequest: Request;
  readonly request: TRequest;
  readonly session: RequestTraceSession;
};

type CountAttempt = {
  readonly providerId: string;
  readonly modelId: string;
  readonly providerKind: RuntimeProviderInstance['kind'];
};

async function countCandidates<TRequest, TContext>({
  adapter,
  candidates,
  context,
  format,
  invocation,
  rawRequest,
  request,
  session,
}: CountCandidatesOptions<TRequest, TContext>): Promise<Response> {
  throwIfCountAborted(session, rawRequest.signal);

  for (const [attemptIndex, candidate] of candidates.entries()) {
    const provider = candidate.provider;
    const count = provider.tokenCount;
    if (count === undefined) continue;
    const targetProtocol = provider.model?.targetProtocol?.(candidate.modelId);
    const candidateInvocation = adapter.modelInvocationForTarget(invocation, targetProtocol);
    try {
      assertImageInputSupported(candidateInvocation.messages, targetProtocol);
    } catch (error) {
      if (adapter.errors.modelUnsupported?.(error) === undefined) throw error;
      continue;
    }
    if (lacksProviderTool(provider, candidateInvocation)) continue;
    throwIfCountAborted(session, rawRequest.signal);
    const attempt: CountAttempt = { providerId: provider.id, modelId: candidate.modelId, providerKind: provider.kind };
    try {
      const result = await withAttemptLogContext(
        { attemptIndex, providerId: provider.id, modelId: candidate.modelId },
        () =>
          count.countTokens({
            protocol: adapter.protocol,
            modelId: candidate.modelId,
            request: rawRequest.clone(),
            context,
            invocation: candidateInvocation,
          } satisfies TokenCountInput),
      );
      rawRequest.signal.throwIfAborted();
      if (!Number.isInteger(result.inputTokens) || result.inputTokens < 0) {
        throw new TypeError('Provider token count must be a non-negative integer');
      }
      startAttemptSpan(session, attempt, attemptIndex, 200).end();
      session.finish({
        outcome: 'success',
        finalProviderId: provider.id,
        finalModelId: candidate.modelId,
        finalHttpStatus: 200,
      });
      return Response.json(format(result.inputTokens));
    } catch (error) {
      if (rawRequest.signal.aborted) {
        startAttemptSpan(session, attempt, attemptIndex).end({ outcome: 'cancelled' });
        session.finish({ outcome: 'cancelled', finalProviderId: provider.id, finalModelId: candidate.modelId });
        throw rawRequest.signal.reason;
      }
      const mapped = adapter.errors.provider(error);
      startAttemptSpan(session, attempt, attemptIndex).end(failureTerminal(mapped?.status));
    }
  }

  throwIfCountAborted(session, rawRequest.signal);
  const estimate = Math.max(1, Math.ceil(JSON.stringify(request).length / 64));
  session.finish({ outcome: 'success', finalHttpStatus: 200 });
  return Response.json(format(estimate), { headers: { 'x-aio-proxy-token-count-estimated': 'true' } });
}

function lacksProviderTool(provider: RuntimeProviderInstance, invocation: ModelInvocation): boolean {
  return invocation.providerTools?.some((tool) => provider.model?.supportsProviderTool?.(tool.type) !== true) === true;
}

function startAttemptSpan(
  session: RequestTraceSession,
  attempt: CountAttempt,
  index: number,
  httpStatus?: number,
): OpenSpan {
  return startPipelineSpan(session.rootContext, spanName.attempt, {
    attributes: {
      [attributeName.attemptIndex]: index,
      [attributeName.providerId]: attempt.providerId,
      [attributeName.providerKind]: attempt.providerKind,
      [attributeName.genAiResponseModel]: attempt.modelId,
      ...(httpStatus === undefined ? {} : { [attributeName.httpStatusCode]: httpStatus }),
    },
  });
}

function throwIfCountAborted(session: RequestTraceSession, signal: AbortSignal): void {
  try {
    signal.throwIfAborted();
  } catch (error) {
    session.finish({ outcome: 'cancelled' });
    throw error;
  }
}
