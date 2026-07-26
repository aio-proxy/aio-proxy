import {
  assertImageInputSupported,
  type ModelEgressContext,
  type ModelInvocation,
  type ProtocolAdapter,
  type RouterResolution,
} from '@aio-proxy/core';

import type { LogicalSessionResolution } from '../../../logical-session-store';
import { withAttemptLogContext } from '../../../request-logging';
import type { RequestTraceSession } from '../../../request-tracing';
import { isInboundAbort, terminalCompletion } from '../../../route-observation';
import type { ProviderRouteSource, RuntimeProviderInstance } from '../../../runtime';
import { prioritizeAffinity } from '../affinity';
import { attemptBase } from '../attempt-base';
import { failureTerminal, finalFailure, shouldFallbackStatus } from '../failure';
import { type AttemptLog, logProviderAttemptFailed, logRequestRejected } from '../logging';
import { createSseResponse, preflightStream, retainResponseBody } from '../stream';
import { attemptLog, createAttemptEmitter } from './emit';

type AttemptCandidatesOptions<TRequest, TContext> = {
  readonly adapter: ProtocolAdapter<TRequest, TContext>;
  readonly candidates: readonly RouterResolution<RuntimeProviderInstance>[];
  readonly context: TContext;
  readonly rawRequest: Request;
  readonly request: TRequest;
  readonly requestedModelId: string;
  readonly session: RequestTraceSession;
  readonly source: ProviderRouteSource;
  readonly deferRelease: () => void;
  readonly resolution: LogicalSessionResolution;
  readonly release: () => void;
};

export async function attemptCandidates<TRequest, TContext>({
  adapter,
  candidates,
  context,
  deferRelease,
  resolution,
  rawRequest,
  release,
  request,
  requestedModelId,
  session,
  source,
}: AttemptCandidatesOptions<TRequest, TContext>): Promise<Response> {
  const logicalRequest = resolution.context;
  const ordered =
    resolution.affinity?.active === true ? prioritizeAffinity(candidates, resolution.affinity.providerId) : candidates;

  let invocation: ModelInvocation | undefined;
  let invocationUnsupported: Response | undefined;
  let lastFailure: Response | undefined;
  const logContext = {
    source,
    requestId: session.requestId,
    rawRequest,
    inboundProtocol: adapter.protocol,
    requestedModelId,
  };
  const logFailure = (
    attemptIndex: number,
    attempt: AttemptLog,
    failureKind: 'response' | 'exception',
    fallback: boolean,
    detail: { readonly response?: Response; readonly error?: unknown } = {},
  ) => logProviderAttemptFailed({ ...logContext, attemptIndex, attempt, failureKind, fallback, ...detail });

  const streamRequested = adapter.wantsStream(request, context);
  const { startAttempt, emitAttempt, settleSuccess } = createAttemptEmitter(session, streamRequested);

  for (const [index, candidate] of ordered.entries()) {
    const provider = candidate.provider;
    const inAttempt = <T>(operation: () => T): T =>
      withAttemptLogContext({ attemptIndex: index, providerId: provider.id, modelId: candidate.modelId }, operation);
    const startedAt = performance.now();
    const hasNext = index < ordered.length - 1;
    const ids = { providerId: provider.id, modelId: candidate.modelId };
    try {
      const raw = provider.raw?.resolve({ protocol: adapter.protocol, modelId: candidate.modelId });
      if (raw !== undefined) {
        const upstream = await adapter.rawRequest(rawRequest, request, candidate.modelId, context);
        const response = await inAttempt(() => raw.invoke(upstream, logicalRequest));
        if (!(response instanceof Response)) throw new TypeError('Provider raw transport must return a Response');
        const fallback = hasNext && shouldFallbackStatus(response.status);
        if (fallback || response.status < 200 || response.status >= 400) {
          const base = attemptBase(provider, candidate.modelId, startedAt, adapter.protocol);
          logFailure(index, attemptLog(base, response.status), 'response', fallback, { response });
          emitAttempt(base, index, failureTerminal(response.status));
          if (fallback) {
            lastFailure = response;
            try {
              void response.body?.cancel().catch(() => undefined);
            } catch {}
            continue;
          }
          session.finish(finalFailure(base, response.status));
          const retained = retainResponseBody(response, release);
          if (retained !== response) deferRelease();
          return retained;
        }
        const captured = source.usageCapture.passthrough({
          response,
          protocol: adapter.protocol,
          providerId: provider.id,
          modelId: candidate.modelId,
          ...(streamRequested ? { startedAt } : {}),
          ...(adapter.session === undefined
            ? {}
            : {
                onResponseId: (responseId: string) =>
                  source.logicalSessionStore.commitResponse(responseId, logicalRequest.session.key),
              }),
        });
        const attemptSpan = startAttempt(
          attemptBase(provider, candidate.modelId, startedAt, adapter.protocol),
          index,
          response.status,
        );
        session.finishFrom(
          settleSuccess(attemptSpan, terminalCompletion(captured.completion, rawRequest.signal).finally(release), ids),
        );
        deferRelease();
        return captured.value;
      }

      const model = provider.model;
      if (model !== undefined) {
        if (invocation === undefined && invocationUnsupported === undefined) {
          try {
            invocation = adapter.modelInvocation(request, context);
          } catch (error) {
            const unsupported = adapter.errors.modelUnsupported?.(error);
            if (unsupported !== undefined) {
              invocationUnsupported = unsupported;
            } else {
              const mapped = adapter.errors.requestError(error);
              if (mapped === undefined) throw error;
              const errorCode = mapped.status === 501 ? 'unsupported_feature' : 'invalid_request';
              const base = attemptBase(provider, candidate.modelId, startedAt);
              emitAttempt(base, index, failureTerminal(mapped.status, errorCode));
              session.finish(finalFailure(base, mapped.status, errorCode));
              logRequestRejected({
                source,
                requestId: session.requestId,
                rawRequest,
                inboundProtocol: adapter.protocol,
                requestedModelId,
                statusCode: mapped.status,
                errorCode,
                error,
              });
              return mapped;
            }
          }
        }
        if (invocationUnsupported !== undefined) {
          const base = attemptBase(provider, candidate.modelId, startedAt);
          emitAttempt(base, index, failureTerminal(invocationUnsupported.status, 'unsupported_feature'));
          if (hasNext) {
            lastFailure = invocationUnsupported;
            continue;
          }
          session.finish(finalFailure(base, invocationUnsupported.status, 'unsupported_feature'));
          return invocationUnsupported;
        }
        if (invocation === undefined) throw new TypeError('Protocol adapter returned no model invocation');
        const targetProtocol = model.targetProtocol?.(candidate.modelId);
        const candidateInvocation = adapter.modelInvocationForTarget(invocation, targetProtocol);
        try {
          assertImageInputSupported(candidateInvocation.messages, targetProtocol);
        } catch (error) {
          const unsupported = adapter.errors.modelUnsupported?.(error);
          if (unsupported === undefined) throw error;
          const base = attemptBase(provider, candidate.modelId, startedAt);
          emitAttempt(base, index, failureTerminal(unsupported.status, 'unsupported_feature'));
          if (hasNext) {
            lastFailure = unsupported;
            continue;
          }
          session.finish(finalFailure(base, unsupported.status, 'unsupported_feature'));
          return unsupported;
        }
        const unsupportedProviderTool = candidateInvocation.providerTools?.find(
          (tool) => model.supportsProviderTool?.(tool.type) !== true,
        );
        if (unsupportedProviderTool !== undefined) {
          const unsupported = adapter.errors.unsupported(unsupportedProviderTool.type);
          const base = attemptBase(provider, candidate.modelId, startedAt);
          emitAttempt(base, index, failureTerminal(unsupported.status));
          if (hasNext) {
            lastFailure = unsupported;
            continue;
          }
          session.finish(finalFailure(base, unsupported.status));
          return unsupported;
        }
        await inAttempt(() => model.ensureAvailable?.());
        const captured = source.usageCapture.stream({
          providerId: provider.id,
          modelId: candidate.modelId,
          ...(streamRequested ? { startedAt } : {}),
          stream: inAttempt(() =>
            model.invoke({
              context: logicalRequest,
              messages: candidateInvocation.messages,
              modelId: candidate.modelId,
              signal: rawRequest.signal,
              ...(candidateInvocation.settings === undefined ? {} : { settings: candidateInvocation.settings }),
              ...(candidateInvocation.tools === undefined ? {} : { tools: candidateInvocation.tools }),
              ...(candidateInvocation.providerTools === undefined
                ? {}
                : { providerTools: candidateInvocation.providerTools }),
            }),
          ),
        });
        const egressContext = {
          modelId: candidate.modelId,
          ...(adapter.session === undefined
            ? {}
            : {
                onResponseId: (responseId: string) =>
                  source.logicalSessionStore.commitResponse(responseId, logicalRequest.session.key),
              }),
        } satisfies ModelEgressContext;

        const base = attemptBase(provider, candidate.modelId, startedAt);
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
          const attemptSpan = startAttempt(base, index);
          session.finishFrom(
            settleSuccess(
              attemptSpan,
              terminalCompletion(captured.completion, rawRequest.signal).finally(release),
              ids,
            ),
          );
          deferRelease();
          return response;
        }

        const value = await adapter.modelJson(captured.value, egressContext);
        const response = Response.json(value);
        const attemptSpan = startAttempt(base, index);
        session.finishFrom(settleSuccess(attemptSpan, terminalCompletion(captured.completion, rawRequest.signal), ids));
        return response;
      }

      const unsupported = adapter.errors.unsupported('transform_dispatch');
      const base = attemptBase(provider, candidate.modelId, startedAt);
      emitAttempt(base, index, failureTerminal(unsupported.status));
      if (hasNext) {
        lastFailure = unsupported;
        continue;
      }
      session.finish(finalFailure(base, unsupported.status));
      return unsupported;
    } catch (error) {
      const mapped = adapter.errors.provider(error);
      const base = attemptBase(provider, candidate.modelId, startedAt);
      if (mapped === undefined) {
        emitAttempt(base, index, { outcome: 'failure' });
        logFailure(index, attemptLog(base), 'exception', false, { error });
        throw error;
      }

      const cancelled = isInboundAbort(error, rawRequest.signal);
      const outcome = cancelled ? ('cancelled' as const) : ('failure' as const);
      const fallback = !cancelled && hasNext;

      if (!cancelled) {
        logFailure(index, attemptLog(base, mapped.status), 'exception', fallback, { error });
      }
      emitAttempt(base, index, { outcome, httpStatus: mapped.status });

      if (fallback) {
        lastFailure = mapped;
        continue;
      }

      session.finish({
        outcome,
        finalProviderId: provider.id,
        finalModelId: candidate.modelId,
        finalHttpStatus: mapped.status,
      });
      return mapped;
    }
  }

  session.finish({ outcome: 'failure' });
  return lastFailure ?? adapter.errors.unsupported('transform_dispatch');
}
