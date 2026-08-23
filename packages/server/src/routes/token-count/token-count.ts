import {
  assertImageInputSupported,
  type ModelInvocation,
  type ProtocolAdapter,
  RequestBodyTooLargeError,
  type RouterCandidate,
  RouterModelNotFoundError,
  UnsupportedContentEncodingError,
} from '@aio-proxy/core';
import type { LogicalRequestContext, ProtocolId, TokenCountInput } from '@aio-proxy/plugin-sdk';
import { context } from '@opentelemetry/api';

import type { LogicalSessionResolution } from '../../logical-session-store';
import { observeInboundRequest, withAttemptLogContext, withRequestLogContext } from '../../request-logging';
import { attributeName, type RequestTraceSession } from '../../request-tracing';
import { isInboundAbort } from '../../route-observation';
import type { ProviderRouteSource, RuntimeProviderInstance } from '../../runtime';
import { hasInvalidOrOversizedContentLength, resolveSupportedEffortsForDimensions } from '../pipeline';
import { prioritizeAffinity } from '../pipeline/affinity';
import { candidateSelectionSource } from '../pipeline/attempt-base';
import { failureTerminal } from '../pipeline/failure';
import { cancelRetainedRequestBody } from '../pipeline/request';
import { estimateInputTokens } from './estimate';
import { attemptRawCount } from './raw';
import {
  recordLocalEstimate,
  recordSkippedCandidate,
  startAttemptSpan,
  throwIfCountAborted,
  toCountAttempt,
} from './shared';

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
    inboundRequest: rawRequest,
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
        try {
          return await handleTokenCountInContext(options, session);
        } catch (error) {
          if (
            (rawRequest.signal.aborted && error === rawRequest.signal.reason) ||
            isInboundAbort(error, rawRequest.signal)
          ) {
            session.finish({ outcome: 'cancelled' });
            throw rawRequest.signal.reason;
          }
          session.finish({ outcome: 'failure', errorCode: 'internal_error' });
          throw error;
        }
      },
    ),
  );
}

async function handleTokenCountInContext<TRequest, TContext>(
  options: HandleTokenCountOptions<TRequest, TContext>,
  session: RequestTraceSession,
): Promise<Response> {
  const { adapter, context, format, source } = options;
  let { rawRequest } = options;
  try {
    rawRequest = observeInboundRequest(rawRequest, adapter.protocol);
  } catch (error) {
    await cancelRetainedRequestBody(rawRequest, error);
    throw error;
  }
  if (hasInvalidOrOversizedContentLength(rawRequest)) {
    await cancelRetainedRequestBody(rawRequest, new RequestBodyTooLargeError('Request body too large'));
    return finishRejected(session, adapter.errors.tooLarge(), 'request_too_large');
  }

  let request: TRequest;
  let invocation: ModelInvocation;
  try {
    request = await adapter.parse(rawRequest, context);
    invocation = adapter.modelInvocation(request, context);
  } catch (error) {
    await cancelRetainedRequestBody(rawRequest, error);
    if (error instanceof RequestBodyTooLargeError) {
      return finishRejected(session, adapter.errors.tooLarge(), 'request_too_large');
    }
    if (error instanceof UnsupportedContentEncodingError) {
      return finishRejected(session, adapter.errors.unsupportedContentEncoding(), 'unsupported_content_encoding');
    }
    const mapped = adapter.errors.requestError(error);
    if (mapped !== undefined) {
      return finishRejected(session, mapped, mapped.status === 501 ? 'unsupported_feature' : 'invalid_request');
    }
    throw error;
  }

  try {
    const requestedModel = adapter.model(request, context);
    const resolution = source.logicalSessionStore.begin({
      requestedModelId: requestedModel,
      requestId: session.requestId,
      hints: adapter.session?.(request, context) ?? { candidates: [], transcript: request },
      headers: rawRequest.headers,
    });
    session.identify({ requestedModelId: requestedModel, resolution, mutateSessionState: false });
    if (resolution.responseStatus === 'ambiguous') {
      return finishRejected(session, adapter.errors.previousResponseConflict(), 'previous_response_conflict');
    }
    const lease = source.acquireProviderSnapshot();
    try {
      const candidates = lease.snapshot.router.resolve(requestedModel, adapter.dimensions(request, context), {
        session: resolution.context.session,
      });
      const affinityOrdered =
        resolution.affinity?.active === true
          ? prioritizeAffinity(candidates, resolution.affinity.providerId)
          : candidates;
      const ordered = prioritizeAffinity(affinityOrdered, resolution.responseOwner?.providerId);
      return await countCandidates({
        adapter,
        candidates: ordered,
        context,
        logicalRequest: resolution.context,
        format,
        invocation,
        rawRequest,
        request,
        resolution,
        session,
      });
    } catch (error) {
      if (error instanceof RouterModelNotFoundError) {
        return finishRejected(session, adapter.errors.modelNotFound(error.message), 'model_not_found');
      }
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
function finishRejected(session: RequestTraceSession, response: Response, errorCode: string): Response {
  session.finish({ outcome: 'failure', finalHttpStatus: response.status, errorCode, clientResponse: response });
  return response;
}

type CountCandidatesOptions<TRequest, TContext> = {
  readonly adapter: ProtocolAdapter<TRequest, TContext>;
  readonly candidates: readonly RouterCandidate<RuntimeProviderInstance>[];
  readonly context: TContext;
  readonly logicalRequest: LogicalRequestContext;
  readonly format: (inputTokens: number) => unknown;
  readonly invocation: ModelInvocation;
  readonly rawRequest: Request;
  readonly request: TRequest;
  readonly resolution: LogicalSessionResolution;
  readonly session: RequestTraceSession;
};

async function countCandidates<TRequest, TContext>({
  adapter,
  candidates,
  context,
  logicalRequest,
  format,
  invocation,
  rawRequest,
  request,
  resolution,
  session,
}: CountCandidatesOptions<TRequest, TContext>): Promise<Response> {
  throwIfCountAborted(session, rawRequest.signal);

  // The same dimensions bag routing resolved with; when it carries no effort,
  // capability resolution is a no-op and is skipped per candidate.
  const dimensions = adapter.dimensions(request, context);

  for (const [attemptIndex, candidate] of candidates.entries()) {
    const attempt = toCountAttempt(candidate, candidateSelectionSource(candidate, resolution));
    const rawResult = await attemptRawCount({
      adapter,
      candidate,
      attempt,
      attemptIndex,
      rawRequest,
      request,
      context,
      logicalRequest,
      session,
    });
    if (rawResult.kind === 'return') return rawResult.response;
    if (rawResult.kind === 'next') continue;
    // 'fallthrough' → this candidate has no raw transport; try its tokenCount path below.
    const provider = candidate.provider;
    const count = provider.tokenCount;
    if (count === undefined) {
      recordSkippedCandidate(session, attempt, attemptIndex, 'no_capability');
      continue;
    }
    const targetProtocol = provider.model?.targetProtocol?.(candidate.modelId);
    // Clamp adaptive effort against this candidate's real capabilities, exactly
    // as the generation path does; otherwise an unsupported level (e.g. xhigh)
    // survives and the provider's own count throws, silently falling back to a
    // local estimate. The lookup is skipped when the request carries no effort.
    const supportedEfforts = await resolveSupportedEffortsForDimensions(dimensions, candidate.modelId);
    const candidateInvocation = adapter.modelInvocationForTarget(invocation, targetProtocol, supportedEfforts);
    try {
      assertImageInputSupported(candidateInvocation.messages, targetProtocol);
    } catch (error) {
      if (adapter.errors.modelUnsupported?.(error) === undefined) throw error;
      recordSkippedCandidate(session, attempt, attemptIndex, 'image_unsupported');
      continue;
    }
    if (lacksProviderTool(provider, candidateInvocation)) {
      recordSkippedCandidate(session, attempt, attemptIndex, 'missing_tool');
      continue;
    }
    throwIfCountAborted(session, rawRequest.signal);
    const attemptSpan = startAttemptSpan(session, attempt, attemptIndex);
    let inputTokens: number;
    try {
      const result = await withAttemptLogContext(
        { attemptIndex, providerId: provider.id, modelId: candidate.modelId },
        () =>
          count.countTokens({
            protocol: adapter.protocol,
            modelId: candidate.modelId,
            request: rawRequest.clone(),
            context: logicalRequest,
            invocation: candidateInvocation,
          } satisfies TokenCountInput),
      );
      rawRequest.signal.throwIfAborted();
      if (!Number.isInteger(result.inputTokens) || result.inputTokens < 0) {
        throw new TypeError('Provider token count must be a non-negative integer');
      }
      inputTokens = result.inputTokens;
    } catch (error) {
      if (
        (rawRequest.signal.aborted && error === rawRequest.signal.reason) ||
        isInboundAbort(error, rawRequest.signal)
      ) {
        attemptSpan.end({ outcome: 'cancelled' });
        session.finish({ outcome: 'cancelled', finalProviderId: provider.id, finalModelId: candidate.modelId });
        throw rawRequest.signal.reason;
      }
      if (rawRequest.signal.aborted) {
        attemptSpan.end({ outcome: 'failure' });
        throw error;
      }
      const mapped = adapter.errors.provider(error);
      attemptSpan.end(failureTerminal(mapped?.status));
      if (mapped === undefined) throw error;
      continue;
    }
    attemptSpan.span.setAttribute(attributeName.httpStatusCode, 200);
    attemptSpan.end();
    const response = Response.json(format(inputTokens));
    session.finish({
      outcome: 'success',
      finalProviderId: provider.id,
      finalModelId: candidate.modelId,
      finalHttpStatus: 200,
      clientResponse: response,
    });
    return response;
  }

  throwIfCountAborted(session, rawRequest.signal);
  recordLocalEstimate(session);
  const estimate = estimateInputTokens(adapter.protocol as ProtocolId, invocation);
  const response = Response.json(format(estimate));
  session.finish({ outcome: 'success', finalHttpStatus: 200, clientResponse: response });
  return response;
}

function lacksProviderTool(provider: RuntimeProviderInstance, invocation: ModelInvocation): boolean {
  return invocation.providerTools?.some((tool) => provider.model?.supportsProviderTool?.(tool.type) !== true) === true;
}
