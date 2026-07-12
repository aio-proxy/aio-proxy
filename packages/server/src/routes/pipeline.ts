import {
  type ModelInvocation,
  type ProtocolAdapter,
  RouterModelNotFoundError,
  type RouterResolution,
} from "@aio-proxy/core";
import type { RequestAttemptInput, RequestFinishInput } from "../request-recorder";
import { isInboundAbort, terminalCompletion } from "../route-observation";
import type { ProviderRouteSource, RuntimeProviderInstance } from "../runtime";

const MAX_BODY_BYTES = 8 * 1_024 * 1_024;
const SSE_RESPONSE_INIT = {
  headers: {
    "cache-control": "no-cache",
    "content-type": "text/event-stream; charset=utf-8",
  },
} as const;

export type HandleProtocolRequestOptions<TRequest, TContext> = {
  readonly adapter: ProtocolAdapter<TRequest, TContext>;
  readonly context: TContext;
  readonly rawRequest: Request;
  readonly source: ProviderRouteSource;
};

type AttemptCandidatesOptions<TRequest, TContext> = {
  readonly adapter: ProtocolAdapter<TRequest, TContext>;
  readonly candidates: readonly RouterResolution<RuntimeProviderInstance>[];
  readonly context: TContext;
  readonly rawRequest: Request;
  readonly request: TRequest;
  readonly requestedModel: string;
  readonly source: ProviderRouteSource;
};

export async function handleProtocolRequest<TRequest, TContext>({
  adapter,
  context,
  rawRequest,
  source,
}: HandleProtocolRequestOptions<TRequest, TContext>): Promise<Response> {
  const contentLength = rawRequest.headers.get("content-length");
  if (contentLength !== null && Number.parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return adapter.errors.tooLarge();
  }

  let request: TRequest;
  try {
    request = await adapter.parse(rawRequest, context);
  } catch (error) {
    const mapped = adapter.errors.requestError(error);
    if (mapped !== undefined) return mapped;
    throw error;
  }

  const requestedModel = adapter.model(request, context);
  let candidates: readonly RouterResolution<RuntimeProviderInstance>[];
  try {
    candidates = source.currentProviderSnapshot().router.resolve(requestedModel, adapter.variant(request, context));
  } catch (error) {
    if (error instanceof RouterModelNotFoundError) {
      return adapter.errors.modelNotFound(error.message);
    }
    throw error;
  }

  return attemptCandidates({
    adapter,
    candidates,
    context,
    rawRequest,
    request,
    requestedModel,
    source,
  });
}

async function attemptCandidates<TRequest, TContext>({
  adapter,
  candidates,
  context,
  rawRequest,
  request,
  requestedModel,
  source,
}: AttemptCandidatesOptions<TRequest, TContext>): Promise<Response> {
  const session = source.requestRecorder.begin({
    inboundProtocol: adapter.protocol,
    requestedModelId: requestedModel,
  });
  let invocation: ModelInvocation | undefined;
  let lastFailure: Response | undefined;

  for (const [index, candidate] of candidates.entries()) {
    const provider = candidate.provider;
    const startedAt = performance.now();
    const hasNext = index < candidates.length - 1;
    try {
      if (provider.raw?.protocol === adapter.protocol) {
        const upstream = await adapter.rawRequest(rawRequest, request, candidate.modelId, context);
        const response = await provider.raw.invoke(upstream);
        if (hasNext && shouldFallbackStatus(response.status)) {
          session.attempt(failedAttempt(provider, candidate.modelId, response.status, startedAt));
          lastFailure = response;
          try {
            await response.body?.cancel();
          } catch {}
          continue;
        }
        if (response.status < 200 || response.status >= 400) {
          session.finish(finalFailure(provider, candidate.modelId, response.status, startedAt));
          return response;
        }
        const captured = source.usageCapture.passthrough({
          response,
          protocol: provider.raw.protocol,
          providerId: provider.id,
          modelId: candidate.modelId,
        });
        session.finishFrom(
          attemptBase(provider, candidate.modelId, startedAt),
          terminalCompletion(captured.completion, rawRequest.signal),
        );
        return captured.value;
      }

      if (provider.model !== undefined) {
        if (invocation === undefined) {
          try {
            invocation = adapter.modelInvocation(request, context);
          } catch (error) {
            const mapped = adapter.errors.requestError(error);
            if (mapped === undefined) throw error;
            session.finish({ outcome: "failure", finalStatusCode: mapped.status });
            return mapped;
          }
        }
        await provider.model.ensureAvailable?.();
        const captured = source.usageCapture.stream({
          providerId: provider.id,
          modelId: candidate.modelId,
          stream: provider.model.invoke({
            messages: invocation.messages,
            modelId: candidate.modelId,
            signal: rawRequest.signal,
            ...(invocation.settings === undefined ? {} : { settings: invocation.settings }),
            ...(invocation.tools === undefined ? {} : { tools: invocation.tools }),
          }),
        });

        if (adapter.wantsStream(request, context)) {
          const stream = await preflightStream(captured.value);
          let response: Response;
          try {
            response = new Response(adapter.modelSse(stream), SSE_RESPONSE_INIT);
          } catch (error) {
            try {
              await stream.cancel(error);
            } catch {}
            throw error;
          }
          session.finishFrom(
            attemptBase(provider, candidate.modelId, startedAt),
            terminalCompletion(captured.completion, rawRequest.signal),
          );
          return response;
        }

        const value = await adapter.modelJson(captured.value);
        const response = Response.json(value);
        session.finishFrom(
          attemptBase(provider, candidate.modelId, startedAt),
          terminalCompletion(captured.completion, rawRequest.signal),
        );
        return response;
      }

      const unsupported = adapter.errors.unsupported("transform_dispatch");
      if (hasNext) {
        session.attempt(failedAttempt(provider, candidate.modelId, unsupported.status, startedAt));
        lastFailure = unsupported;
        continue;
      }
      session.finish(finalFailure(provider, candidate.modelId, unsupported.status, startedAt));
      return unsupported;
    } catch (error) {
      const mapped = adapter.errors.provider(error);
      if (mapped === undefined) {
        const attempt = {
          ...attemptBase(provider, candidate.modelId, startedAt),
          outcome: "failure" as const,
        };
        session.finish({
          outcome: "failure",
          finalProviderId: provider.id,
          finalModelId: candidate.modelId,
          attempt,
        });
        throw error;
      }

      const cancelled = isInboundAbort(error, rawRequest.signal);
      const outcome = cancelled ? ("cancelled" as const) : ("failure" as const);
      const attempt = {
        ...attemptBase(provider, candidate.modelId, startedAt),
        outcome,
        statusCode: mapped.status,
      };

      if (!cancelled && hasNext) {
        session.attempt(attempt);
        lastFailure = mapped;
        continue;
      }

      session.finish({
        outcome,
        finalProviderId: provider.id,
        finalModelId: candidate.modelId,
        finalStatusCode: mapped.status,
        attempt,
      });
      return mapped;
    }
  }

  session.finish({ outcome: "failure" });
  return lastFailure ?? adapter.errors.unsupported("transform_dispatch");
}

function attemptBase(
  provider: RuntimeProviderInstance,
  modelId: string,
  startedAt: number,
): Omit<RequestAttemptInput, "outcome" | "statusCode" | "errorCode"> {
  return {
    providerId: provider.id,
    modelId,
    providerKind: provider.kind,
    ...("protocol" in provider ? { protocol: provider.protocol } : {}),
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}

function failedAttempt(
  provider: RuntimeProviderInstance,
  modelId: string,
  statusCode: number,
  startedAt: number,
): RequestAttemptInput {
  return {
    ...attemptBase(provider, modelId, startedAt),
    outcome: "failure",
    statusCode,
  };
}

function finalFailure(
  provider: RuntimeProviderInstance,
  modelId: string,
  statusCode: number,
  startedAt: number,
): RequestFinishInput {
  return {
    outcome: "failure",
    finalProviderId: provider.id,
    finalModelId: modelId,
    finalStatusCode: statusCode,
    attempt: failedAttempt(provider, modelId, statusCode, startedAt),
  };
}

function shouldFallbackStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function preflightStream<T>(stream: ReadableStream<T>): Promise<ReadableStream<T>> {
  const reader = stream.getReader();
  let released = false;
  const releaseReader = () => {
    if (!released) {
      reader.releaseLock();
      released = true;
    }
  };
  let first: ReadableStreamReadResult<T>;
  try {
    first = await reader.read();
  } catch (error) {
    releaseReader();
    throw error;
  }
  if (first.done) {
    releaseReader();
    throw new Error("Upstream model stream ended before the first event");
  }
  let firstPending = true;

  return new ReadableStream<T>({
    async pull(controller) {
      if (firstPending) {
        firstPending = false;
        controller.enqueue(first.value);
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) {
          releaseReader();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        releaseReader();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
    },
  });
}
