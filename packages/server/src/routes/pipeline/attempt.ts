import type { ModelEgressContext, ModelInvocation, ProtocolAdapter, RouterResolution } from "@aio-proxy/core";
import type { ProviderProtocol } from "@aio-proxy/types";
import type { RequestAttemptInput } from "../../request-recorder";
import { isInboundAbort, terminalCompletion } from "../../route-observation";
import type { ProviderRouteSource, RuntimeProviderInstance } from "../../runtime";
import { failedAttempt, finalFailure, shouldFallbackStatus } from "./failure";
import { createSseResponse, preflightStream, retainResponseBody } from "./stream";

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

export async function attemptCandidates<TRequest, TContext>({
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
          session.attempt(
            failedAttempt(attemptBase(provider, candidate.modelId, startedAt, adapter.protocol), response.status),
          );
          lastFailure = response;
          try {
            await response.body?.cancel();
          } catch {}
          continue;
        }
        if (response.status < 200 || response.status >= 400) {
          session.finish(
            finalFailure(attemptBase(provider, candidate.modelId, startedAt, adapter.protocol), response.status),
          );
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
            session.finish(finalFailure(attemptBase(provider, candidate.modelId, startedAt), mapped.status));
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
            response = createSseResponse(adapter.modelSse(stream, egressContext));
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

      const unsupported = adapter.errors.unsupported("transform_dispatch");
      if (hasNext) {
        session.attempt(failedAttempt(attemptBase(provider, candidate.modelId, startedAt), unsupported.status));
        lastFailure = unsupported;
        continue;
      }
      session.finish(finalFailure(attemptBase(provider, candidate.modelId, startedAt), unsupported.status));
      return unsupported;
    } catch (error) {
      const mapped = adapter.errors.provider(error);
      if (mapped === undefined) {
        const attempt = { ...attemptBase(provider, candidate.modelId, startedAt), outcome: "failure" as const };
        session.finish({ outcome: "failure", finalProviderId: provider.id, finalModelId: candidate.modelId, attempt });
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
