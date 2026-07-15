import {
  type ModelEgressContext,
  type ModelInvocation,
  type ProtocolAdapter,
  RequestBodyTooLargeError,
  RouterModelNotFoundError,
  type RouterResolution,
} from "@aio-proxy/core";
import type { ProviderProtocol } from "@aio-proxy/types";
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
  readonly deferRelease: () => void;
  readonly release: () => void;
};

export async function handleProtocolRequest<TRequest, TContext>({
  adapter,
  context,
  rawRequest,
  source,
}: HandleProtocolRequestOptions<TRequest, TContext>): Promise<Response> {
  if (hasInvalidOrOversizedContentLength(rawRequest)) {
    return adapter.errors.tooLarge();
  }

  let request: TRequest;
  try {
    request = await adapter.parse(rawRequest, context);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return adapter.errors.tooLarge();
    const mapped = adapter.errors.requestError(error);
    if (mapped !== undefined) return mapped;
    throw error;
  }

  const requestedModel = adapter.model(request, context);
  const lease = source.acquireProviderSnapshot();
  let deferred = false;
  const deferRelease = () => {
    deferred = true;
  };
  try {
    const candidates = lease.snapshot.router.resolve(requestedModel, adapter.variant(request, context));
    return await attemptCandidates({
      adapter,
      candidates,
      context,
      deferRelease,
      rawRequest,
      release: lease.release,
      request,
      requestedModel,
      source,
    });
  } catch (error) {
    if (error instanceof RouterModelNotFoundError) {
      return adapter.errors.modelNotFound(error.message);
    }
    throw error;
  } finally {
    if (!deferred) lease.release();
  }
}

async function attemptCandidates<TRequest, TContext>({
  adapter,
  candidates,
  context,
  deferRelease,
  rawRequest,
  release,
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
      const raw = provider.raw?.resolve({ protocol: adapter.protocol, modelId: candidate.modelId });
      if (raw !== undefined) {
        const upstream = await adapter.rawRequest(rawRequest, request, candidate.modelId, context);
        const response = await raw.invoke(upstream);
        if (!(response instanceof Response)) throw new TypeError("Provider raw transport must return a Response");
        if (hasNext && shouldFallbackStatus(response.status)) {
          session.attempt(failedAttempt(provider, candidate.modelId, response.status, startedAt, adapter.protocol));
          lastFailure = response;
          try {
            await response.body?.cancel();
          } catch {}
          continue;
        }
        if (response.status < 200 || response.status >= 400) {
          session.finish(finalFailure(provider, candidate.modelId, response.status, startedAt, adapter.protocol));
          const retained = retainResponseBody(response, release);
          if (retained !== response) deferRelease();
          return retained;
        }
        const captured = source.usageCapture.passthrough({
          response,
          protocol: adapter.protocol,
          providerId: provider.id,
          modelId: candidate.modelId,
        });
        session.finishFrom(
          attemptBase(provider, candidate.modelId, startedAt, adapter.protocol),
          terminalCompletion(captured.completion, rawRequest.signal).finally(release),
        );
        deferRelease();
        return captured.value;
      }

      const model = provider.model;
      if (model !== undefined) {
        if (invocation === undefined) {
          try {
            invocation = adapter.modelInvocation(request, context);
          } catch (error) {
            const mapped = adapter.errors.requestError(error);
            if (mapped === undefined) throw error;
            session.finish(finalFailure(provider, candidate.modelId, mapped.status, startedAt));
            return mapped;
          }
        }
        await model.ensureAvailable?.();
        const captured = source.usageCapture.stream({
          providerId: provider.id,
          modelId: candidate.modelId,
          stream: model.invoke({
            messages: invocation.messages,
            modelId: candidate.modelId,
            signal: rawRequest.signal,
            ...(invocation.settings === undefined ? {} : { settings: invocation.settings }),
            ...(invocation.tools === undefined ? {} : { tools: invocation.tools }),
          }),
        });
        const egressContext = { modelId: candidate.modelId } satisfies ModelEgressContext;

        if (adapter.wantsStream(request, context)) {
          const stream = await preflightStream(captured.value);
          let response: Response;
          try {
            response = new Response(adapter.modelSse(stream, egressContext), SSE_RESPONSE_INIT);
          } catch (error) {
            try {
              await stream.cancel(error);
            } catch {}
            throw error;
          }
          session.finishFrom(
            attemptBase(provider, candidate.modelId, startedAt),
            terminalCompletion(captured.completion, rawRequest.signal).finally(release),
          );
          deferRelease();
          return response;
        }

        const value = await adapter.modelJson(captured.value, egressContext);
        const response = Response.json(value);
        session.finishFrom(
          attemptBase(provider, candidate.modelId, startedAt),
          terminalCompletion(captured.completion, rawRequest.signal),
        );
        return response;
      }

      // The capability union guarantees this is a raw-only provider whose
      // resolver does not support the inbound protocol/model combination.
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

export function hasInvalidOrOversizedContentLength(request: Request): boolean {
  const contentLength = request.headers.get("content-length");
  return contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES);
}

function attemptBase(
  provider: RuntimeProviderInstance,
  modelId: string,
  startedAt: number,
  protocol?: ProviderProtocol,
): Omit<RequestAttemptInput, "outcome" | "statusCode" | "errorCode"> {
  return {
    providerId: provider.id,
    modelId,
    providerKind: provider.kind,
    ...(protocol === undefined ? {} : { protocol }),
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}

function failedAttempt(
  provider: RuntimeProviderInstance,
  modelId: string,
  statusCode: number,
  startedAt: number,
  protocol?: ProviderProtocol,
): RequestAttemptInput {
  return {
    ...attemptBase(provider, modelId, startedAt, protocol),
    outcome: "failure",
    statusCode,
  };
}

function finalFailure(
  provider: RuntimeProviderInstance,
  modelId: string,
  statusCode: number,
  startedAt: number,
  protocol?: ProviderProtocol,
): RequestFinishInput {
  return {
    outcome: "failure",
    finalProviderId: provider.id,
    finalModelId: modelId,
    finalStatusCode: statusCode,
    attempt: failedAttempt(provider, modelId, statusCode, startedAt, protocol),
  };
}

function shouldFallbackStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retainResponseBody(response: Response, release: () => void): Response {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    reader.releaseLock();
    release();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          settle();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        settle();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        settle();
      }
    },
  });
  return new Response(body, { headers: response.headers, status: response.status, statusText: response.statusText });
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
  let first: Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>>;
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
