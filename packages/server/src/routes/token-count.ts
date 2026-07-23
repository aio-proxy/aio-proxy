import type { LogicalRequestContext, TokenCountInput } from "@aio-proxy/plugin-sdk";

import {
  assertImageInputSupported,
  type ModelInvocation,
  type ProtocolAdapter,
  RequestBodyTooLargeError,
  RouterModelNotFoundError,
  type RouterResolution,
  UnsupportedContentEncodingError,
} from "@aio-proxy/core";

import type { RequestAttemptInput, RequestSession } from "../request-recorder";
import type { ProviderRouteSource, RuntimeProviderInstance } from "../runtime";

import { hasInvalidOrOversizedContentLength } from "./pipeline";
import { cancelRetainedRequestBody } from "./pipeline/request";

export type HandleTokenCountOptions<TRequest, TContext> = {
  readonly adapter: ProtocolAdapter<TRequest, TContext>;
  readonly context: TContext;
  readonly format: (inputTokens: number) => unknown;
  readonly rawRequest: Request;
  readonly source: ProviderRouteSource;
};

export async function handleTokenCount<TRequest, TContext>({
  adapter,
  context,
  format,
  rawRequest,
  source,
}: HandleTokenCountOptions<TRequest, TContext>): Promise<Response> {
  if (hasInvalidOrOversizedContentLength(rawRequest)) {
    await cancelRetainedRequestBody(rawRequest, new RequestBodyTooLargeError("Request body too large"));
    return adapter.errors.tooLarge();
  }

  let request: TRequest;
  let invocation: ModelInvocation;
  try {
    request = await adapter.parse(rawRequest, context);
    invocation = adapter.modelInvocation(request, context);
  } catch (error) {
    await cancelRetainedRequestBody(rawRequest, error);
    if (error instanceof RequestBodyTooLargeError) return adapter.errors.tooLarge();
    if (error instanceof UnsupportedContentEncodingError) return adapter.errors.unsupportedContentEncoding();
    const mapped = adapter.errors.requestError(error);
    if (mapped !== undefined) return mapped;
    throw error;
  }

  try {
    const requestedModel = adapter.model(request, context);
    const logicalRequest = source.logicalSessionStore.begin({
      hints: adapter.session?.(request, context) ?? { candidates: [], transcript: request },
      headers: rawRequest.headers,
    });
    const lease = source.acquireProviderSnapshot();
    try {
      const candidates = lease.snapshot.router.resolve(requestedModel, adapter.variant(request, context));
      return await countCandidates({
        adapter,
        candidates,
        context: logicalRequest,
        format,
        invocation,
        rawRequest,
        requestedModel,
        request,
        source,
      });
    } catch (error) {
      if (error instanceof RouterModelNotFoundError) return adapter.errors.modelNotFound(error.message);
      throw error;
    } finally {
      lease.release();
    }
  } finally {
    void cancelRetainedRequestBody(rawRequest, "request body no longer needed");
  }
}

type CountCandidatesOptions<TRequest, TContext> = {
  readonly adapter: ProtocolAdapter<TRequest, TContext>;
  readonly candidates: readonly RouterResolution<RuntimeProviderInstance>[];
  readonly context: LogicalRequestContext;
  readonly format: (inputTokens: number) => unknown;
  readonly invocation: ModelInvocation;
  readonly rawRequest: Request;
  readonly requestedModel: string;
  readonly request: TRequest;
  readonly source: ProviderRouteSource;
};

async function countCandidates<TRequest, TContext>({
  adapter,
  candidates,
  context,
  format,
  invocation,
  rawRequest,
  requestedModel,
  request,
  source,
}: CountCandidatesOptions<TRequest, TContext>): Promise<Response> {
  const session = source.requestRecorder.begin({
    inboundProtocol: adapter.protocol,
    requestedModelId: requestedModel,
  });
  throwIfCountAborted(session, rawRequest.signal);

  for (const candidate of candidates) {
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
    const startedAt = performance.now();
    try {
      const result = await count.countTokens({
        protocol: adapter.protocol,
        modelId: candidate.modelId,
        request: rawRequest.clone(),
        context,
        invocation: candidateInvocation,
      } satisfies TokenCountInput);
      rawRequest.signal.throwIfAborted();
      if (!Number.isInteger(result.inputTokens) || result.inputTokens < 0) {
        throw new TypeError("Provider token count must be a non-negative integer");
      }
      session.finish({
        outcome: "success",
        finalProviderId: provider.id,
        finalModelId: candidate.modelId,
        finalStatusCode: 200,
        attempt: { ...attemptBase(provider, candidate.modelId, startedAt), outcome: "success", statusCode: 200 },
      });
      return Response.json(format(result.inputTokens));
    } catch (error) {
      if (rawRequest.signal.aborted) {
        finishCancelled(session, failedCountAttempt(provider, candidate.modelId, startedAt, undefined));
        throw rawRequest.signal.reason;
      }
      const mapped = adapter.errors.provider(error);
      const attempt = failedCountAttempt(provider, candidate.modelId, startedAt, mapped?.status);
      session.attempt(attempt);
    }
  }

  throwIfCountAborted(session, rawRequest.signal);
  const estimate = Math.max(1, Math.ceil(JSON.stringify(request).length / 64));
  session.finish({ outcome: "success", finalStatusCode: 200 });
  return Response.json(format(estimate), { headers: { "x-aio-proxy-token-count-estimated": "true" } });
}

function lacksProviderTool(provider: RuntimeProviderInstance, invocation: ModelInvocation): boolean {
  return invocation.providerTools?.some((tool) => provider.model?.supportsProviderTool?.(tool.type) !== true) === true;
}

function failedCountAttempt(
  provider: RuntimeProviderInstance,
  modelId: string,
  startedAt: number,
  statusCode: number | undefined,
): RequestAttemptInput {
  return {
    ...attemptBase(provider, modelId, startedAt),
    outcome: "failure",
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}

function finishCancelled(session: RequestSession, attempt: RequestAttemptInput): void {
  session.finish({
    outcome: "cancelled",
    finalProviderId: attempt.providerId,
    finalModelId: attempt.modelId,
    attempt: { ...attempt, outcome: "cancelled" },
  });
}

function throwIfCountAborted(session: RequestSession, signal: AbortSignal): void {
  try {
    signal.throwIfAborted();
  } catch (error) {
    session.finish({ outcome: "cancelled" });
    throw error;
  }
}

function attemptBase(provider: RuntimeProviderInstance, modelId: string, startedAt: number) {
  return {
    providerId: provider.id,
    modelId,
    providerKind: provider.kind,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}
