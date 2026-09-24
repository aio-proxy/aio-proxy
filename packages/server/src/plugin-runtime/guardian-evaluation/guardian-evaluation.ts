import { EvaluationDistributionError, type RouterCandidate, typeSafeSystemOneAdapter } from '@aio-proxy/core';
import { withRequestId } from '@aio-proxy/logger';
import type { LogicalRequestContext } from '@aio-proxy/plugin-sdk';
import type { RouterModelPolicy } from '@aio-proxy/types';
import { trace } from '@opentelemetry/api';
import { isPlainObject } from 'es-toolkit/predicate';

const unitInterval = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

import { currentRequestTraceRootContext, withAttemptLogContext, withRequestLogContext } from '../../request-logging';
import { attributeName } from '../../request-tracing';
import { createAttemptResponseObservation, withAttemptResponseObservation } from '../../response-observation';
import { attemptBase, candidateConfigPrice, candidateRoutingTrace } from '../../routes/pipeline/attempt-base';
import { createAttemptEmitter } from '../../routes/pipeline/attempt/emit';
import { selectEvaluationTransport } from '../../routes/pipeline/attempt/evaluation';
import { publicSlug } from '../../routes/pipeline/public-slug';
import { cancelRetainedRequestBody } from '../../routes/pipeline/request';
import type { ProviderRouteSource, RuntimeProviderInstance } from '../../runtime';
import { logServerEvent, type GuardianEvaluationUnavailableLog } from '../../server-log';
import { withoutCallerCredentialsOnRequest } from '../../server/api-key-auth';
import { MAX_PASSTHROUGH_JSON_BYTES, type UsageCompletion } from '../../usage-capture';

export type GuardianSystemOneBody = {
  readonly model: string;
  readonly state: { readonly input: readonly unknown[]; readonly pending_action: Record<string, unknown> };
  readonly questions: Readonly<
    Record<
      string,
      {
        readonly type: 'choice';
        readonly instructions: string;
        readonly criteria: Readonly<Record<string, string | null>>;
      }
    >
  >;
};
export type GuardianEvaluate = (input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly body: GuardianSystemOneBody;
  readonly signal: AbortSignal;
  readonly logicalRequest: LogicalRequestContext;
}) => Promise<unknown>;
type Reason = GuardianEvaluationUnavailableLog['errorCode'];
export class GuardianEvaluationUnavailable extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
    this.name = 'GuardianEvaluationUnavailable';
  }
}
export function createGuardianEvaluate(
  getSource: () => ProviderRouteSource,
  sourceProviderId: string,
): GuardianEvaluate {
  return async ({ providerId, modelId, body, signal, logicalRequest }) => {
    signal.throwIfAborted();
    const source = getSource();
    const lease = source.acquireProviderSnapshot();
    try {
      let matches: RouterCandidate<RuntimeProviderInstance>[];
      try {
        matches = lease.snapshot.router.resolve(`${providerId}/${modelId}`);
      } catch {
        throw new GuardianEvaluationUnavailable('target_unavailable');
      }
      const candidate = matches[0];
      if (
        matches.length !== 1 ||
        candidate?.provider.id !== providerId ||
        candidate.selectionSource !== 'provider_qualified' ||
        !candidate.provider.enabled
      )
        throw new GuardianEvaluationUnavailable('target_unavailable');
      if (candidate.provider.id === sourceProviderId) throw new GuardianEvaluationUnavailable('recursive_target');
      return await dispatchPrivateEvaluation({
        candidate,
        body,
        signal,
        logicalRequest,
        source,
        routerModels: lease.snapshot.config?.router.models,
      });
    } catch (error) {
      logServerEvent(source.logger, {
        event: 'guardian.evaluation.unavailable',
        requestId: logicalRequest.requestId,
        targetProviderId: providerId,
        targetModelId: modelId,
        errorCode: error instanceof GuardianEvaluationUnavailable ? error.reason : 'transport_failed',
      });
      throw error;
    } finally {
      lease.release();
    }
  };
}

// Abort also disposes a late raw response when an upstream ignores the signal.
function abortable<T>(operation: () => Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new GuardianEvaluationUnavailable('transport_failed'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then((value) => {
        if (signal.aborted) late?.(value);
        else resolve(value);
      }, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
async function cancel(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new GuardianEvaluationUnavailable('invalid_response');
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  let cancellation: Promise<void> | undefined;
  const cancelReader = () => (cancellation ??= reader.cancel().catch(() => {}));
  const abort = () => {
    void cancelReader();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const part = await abortable(() => reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_PASSTHROUGH_JSON_BYTES) throw new GuardianEvaluationUnavailable('response_too_large');
      text += decoder.decode(part.value, { stream: true });
    }
    signal.throwIfAborted();
    const result: unknown = JSON.parse(text + decoder.decode());
    validateResponse(result);
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
    await cancelReader();
    reader.releaseLock();
  }
}

function validateResponse(result: unknown): void {
  if (!isPlainObject(result) || !isPlainObject(result['answers']))
    throw new GuardianEvaluationUnavailable('invalid_response');
  for (const answer of Object.values(result['answers'])) {
    if (!isPlainObject(answer)) throw new GuardianEvaluationUnavailable('invalid_response');
    if (answer['type'] === 'choice' || answer['type'] === 'score') {
      if (
        !isPlainObject(answer['probabilities']) ||
        Object.values(answer['probabilities']).some((value) => !unitInterval(value))
      )
        throw new GuardianEvaluationUnavailable('invalid_response');
    }
  }
}

export async function dispatchPrivateEvaluation(input: {
  readonly candidate: RouterCandidate<RuntimeProviderInstance>;
  readonly body: GuardianSystemOneBody;
  readonly signal: AbortSignal;
  readonly logicalRequest: LogicalRequestContext;
  readonly source: ProviderRouteSource;
  readonly routerModels: Readonly<Record<string, RouterModelPolicy>> | undefined;
}): Promise<unknown> {
  const { candidate, body, signal, logicalRequest, source, routerModels } = input;
  signal.throwIfAborted();
  const internalId = crypto.randomUUID();
  const parentContext = currentRequestTraceRootContext();
  const parent = parentContext === undefined ? undefined : trace.getSpanContext(parentContext);
  const headers: Record<string, string> =
    parent === undefined ? {} : { traceparent: `00-${parent.traceId}-${parent.spanId}-01` };
  const session = withRequestId(internalId, () =>
    source.requestRecorder.begin({
      inboundRequest: new Request('http://aio-proxy.invalid/v1/systemone', { method: 'POST', headers }),
      inboundProtocol: typeSafeSystemOneAdapter.protocol,
      httpRoute: '/v1/systemone',
    }),
  );
  trace.getSpan(session.rootContext)?.setAttribute(attributeName.guardianParentRequestId, logicalRequest.requestId);
  return withRequestLogContext(
    { requestId: internalId, debug: false, logger: source.logger, rootContext: session.rootContext },
    async () => {
      const startedAt = performance.now();
      const observation = createAttemptResponseObservation({ startedAt });
      const emitter = createAttemptEmitter({ session, capability: 'evaluation' });
      const ids = { providerId: candidate.provider.id, modelId: candidate.modelId };
      let settled = false;
      const attempt = emitter.startAttempt(
        attemptBase(candidate.provider, candidate.modelId, startedAt, {
          ...candidateRoutingTrace(candidate, candidate.selectionSource),
          sourceProtocol: typeSafeSystemOneAdapter.protocol,
          selectionReason: 'weight',
        }),
        0,
      );
      const settle = async (completion: Promise<UsageCompletion>, response: Response) => {
        settled = true;
        const finished = emitter.settleSuccess(attempt, observation, completion, ids, response);
        session.finishFrom(finished);
        await abortable(() => finished, signal);
      };
      try {
        const rawRequest = new Request('http://aio-proxy.invalid/v1/systemone', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
        const request = await typeSafeSystemOneAdapter.parse(rawRequest, {});
        const selected = selectEvaluationTransport({
          candidate,
          protocol: typeSafeSystemOneAdapter.protocol,
          requestPath: '/v1/systemone',
        });
        const requestedModelId = `${candidate.provider.id}/${body.model}`;
        const configPrice = candidateConfigPrice(
          routerModels,
          publicSlug(requestedModelId, candidate),
          candidate.provider.id,
          candidate.provider.upstreamMetadata?.[candidate.modelId]?.cost,
        );
        const usageOptions = { ...ids, requestedModelId, ...(configPrice === undefined ? {} : { configPrice }) };
        if (selected.kind === 'unsupported') throw new GuardianEvaluationUnavailable('unsupported');
        const observed = <T>(operation: () => Promise<T>): Promise<T> => {
          observation.markTransportUnavailable();
          return withAttemptResponseObservation(observation, () =>
            withAttemptLogContext(
              {
                ...ids,
                requestedModelId,
                attemptIndex: 0,
                sourceProtocol: typeSafeSystemOneAdapter.protocol,
                ...(selected.kind === 'raw'
                  ? {
                      targetProtocol: typeSafeSystemOneAdapter.protocol,
                      ...(selected.transport.urlTemplate === undefined
                        ? {}
                        : { urlTemplate: selected.transport.urlTemplate }),
                    }
                  : {}),
              },
              () => attempt.run(operation),
            ),
          );
        };
        attempt.span.setAttribute(attributeName.transport, selected.kind === 'raw' ? 'raw' : 'ai_sdk');
        if (selected.kind === 'raw')
          attempt.span.setAttribute(attributeName.targetProtocol, typeSafeSystemOneAdapter.protocol);
        if (selected.kind === 'raw') {
          const upstream = withoutCallerCredentialsOnRequest(
            await typeSafeSystemOneAdapter.rawRequest(rawRequest, request, candidate.modelId, {}),
          );
          const response = await abortable(
            () => observed(() => selected.transport.invoke(upstream, logicalRequest, { upstreamStream: false })),
            signal,
            cancel,
          ).finally(() => {
            void cancelRetainedRequestBody(upstream, 'evaluation settled');
          });
          if (!response.ok) {
            await cancel(response);
            throw new GuardianEvaluationUnavailable('transport_failed');
          }
          const captured = source.usageCapture.passthrough({
            ...usageOptions,
            response,
            protocol: typeSafeSystemOneAdapter.protocol,
            observation,
          });
          try {
            return await readJson(captured.value, signal);
          } finally {
            await settle(captured.completion, captured.value);
          }
        }
        const discovered = await abortable(() => selected.transport.discover(), signal);
        if (discovered.kind !== 'supported') throw new GuardianEvaluationUnavailable('unsupported');
        const result = await abortable(
          () =>
            observed(() =>
              discovered.evaluate(typeSafeSystemOneAdapter.evaluationInvocation(request, {}), {
                modelId: candidate.modelId,
                signal,
              }),
            ),
          signal,
        );
        const completion = source.usageCapture.evaluation({ ...usageOptions, usage: result.usage });
        try {
          const value = typeSafeSystemOneAdapter.evaluationJson(result, { responseModelId: body.model });
          validateResponse(value);
          signal.throwIfAborted();
          return value;
        } finally {
          await settle(completion, new Response(null, { status: 200 }));
        }
      } catch (error) {
        if (!settled) {
          emitter.endAttempt(attempt, observation, { outcome: signal.aborted ? 'cancelled' : 'failure' });
          session.finish({
            outcome: signal.aborted ? 'cancelled' : 'failure',
            finalProviderId: ids.providerId,
            finalModelId: ids.modelId,
          });
        }
        if (error instanceof GuardianEvaluationUnavailable) throw error;
        if (error instanceof EvaluationDistributionError || error instanceof SyntaxError)
          throw new GuardianEvaluationUnavailable('invalid_response');
        throw new GuardianEvaluationUnavailable('transport_failed');
      }
    },
  );
}
