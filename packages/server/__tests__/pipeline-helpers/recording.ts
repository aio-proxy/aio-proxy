import type { StoredSpan, TraceCompletion } from '@aio-proxy/core/db';
import type { ProviderProtocol } from '@aio-proxy/types';

import {
  attributeName,
  createRequestTraceRecorder,
  type RequestTraceRecorder,
  type RequestTraceWriteStore,
  spanName,
} from '../../src/request-tracing';
import type { Recording, RecordedAttempt, RecordedFinal } from './types';

// Wraps the real RequestTraceRecorder with an in-memory trace store, then
// projects each completed trace back into the legacy {begins, identities,
// attempts, finals} shapes the pipeline tests assert against. This keeps the
// tests behavior-level while exercising the production recorder + span buffer.
export function createRecording(): Recording & { readonly recorder: RequestTraceRecorder } {
  const begins: Recording['begins'] = [];
  const identities: Recording['identities'] = [];
  const attempts: RecordedAttempt[] = [];
  const finals: RecordedFinal[] = [];
  const waiters: { readonly target: number; readonly resolve: () => void }[] = [];

  const store: RequestTraceWriteStore = {
    startRoot() {},
    prune() {},
    complete(completion) {
      const projected = projectAttempts(completion.spans);
      for (const attempt of projected) attempts.push(attempt);
      finals.push(projectFinal(completion, projected));
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index]!;
        if (finals.length < waiter.target) continue;
        waiters.splice(index, 1);
        waiter.resolve();
      }
      return true;
    },
  };
  const real = createRequestTraceRecorder({ store });

  const recorder: RequestTraceRecorder = {
    begin(input) {
      const session = real.begin(input);
      begins.push({ inboundProtocol: input.inboundProtocol });
      return {
        ...session,
        requestId: `request-${begins.length}`,
        identify(identity) {
          identities.push({ requestedModelId: identity.requestedModelId });
          session.identify(identity);
        },
      };
    },
  };
  return {
    attempts,
    begins,
    finals,
    identities,
    recorder,
    settle() {
      const target = begins.length;
      if (finals.length >= target) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ target, resolve }));
    },
  };
}

function projectAttempts(spans: readonly StoredSpan[]): RecordedAttempt[] {
  return spans.filter((span) => span.name === spanName.attempt).map(projectAttempt);
}

function projectAttempt(span: StoredSpan): RecordedAttempt {
  const attrs = span.attributes;
  const protocol = str(attrs, attributeName.targetProtocol) as ProviderProtocol | undefined;
  const providerWeight = num(attrs, attributeName.providerWeight);
  const transport = str(attrs, attributeName.transport) as RecordedAttempt['transport'];
  const sourceProtocol = str(attrs, attributeName.sourceProtocol) as ProviderProtocol | undefined;
  const selectionReason = str(attrs, attributeName.selectionReason) as RecordedAttempt['selectionReason'];
  const statusCode = num(attrs, attributeName.httpStatusCode);
  const errorCode = str(attrs, attributeName.errorCode);
  const stream = bool(attrs, attributeName.stream);
  const ttftMs = num(attrs, attributeName.ttftMs);
  const transportObservation = str(
    attrs,
    attributeName.transportObservation,
  ) as RecordedAttempt['transportObservation'];
  const upstreamHeadersMs = num(attrs, attributeName.upstreamHeadersMs);
  const firstUpstreamByteMs = num(attrs, attributeName.firstUpstreamByteMs);
  const firstSseEventMs = num(attrs, attributeName.firstSseEventMs);
  const contentGapP95Ms = num(attrs, attributeName.contentGapP95Ms);
  const maxSseFramesPerRead = num(attrs, attributeName.maxSseFramesPerRead);
  const contentEncoding = str(attrs, attributeName.contentEncoding) as RecordedAttempt['contentEncoding'];
  return {
    providerId: str(attrs, attributeName.providerId) ?? '',
    modelId: str(attrs, attributeName.genAiResponseModel) ?? '',
    providerKind: (str(attrs, attributeName.providerKind) ?? '') as RecordedAttempt['providerKind'],
    durationMs: Math.max(0, span.endedAt.getTime() - span.startedAt.getTime()),
    outcome: (str(attrs, attributeName.terminationReason) ?? 'success') as RecordedAttempt['outcome'],
    ...(providerWeight === undefined ? {} : { providerWeight }),
    ...(transport === undefined ? {} : { transport }),
    ...(sourceProtocol === undefined ? {} : { sourceProtocol }),
    ...(protocol === undefined ? {} : { targetProtocol: protocol }),
    ...(selectionReason === undefined ? {} : { selectionReason }),
    ...(protocol === undefined ? {} : { protocol }),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(stream === undefined ? {} : { stream }),
    ...(ttftMs === undefined ? {} : { ttftMs }),
    ...(transportObservation === undefined ? {} : { transportObservation }),
    ...(upstreamHeadersMs === undefined ? {} : { upstreamHeadersMs }),
    ...(firstUpstreamByteMs === undefined ? {} : { firstUpstreamByteMs }),
    ...(firstSseEventMs === undefined ? {} : { firstSseEventMs }),
    ...(contentGapP95Ms === undefined ? {} : { contentGapP95Ms }),
    ...(maxSseFramesPerRead === undefined ? {} : { maxSseFramesPerRead }),
    ...(contentEncoding === undefined ? {} : { contentEncoding }),
  };
}

function projectFinal(completion: TraceCompletion, projected: readonly RecordedAttempt[]): RecordedFinal {
  const { summary } = completion;
  const outcome: RecordedFinal['outcome'] =
    summary.terminationReason === 'failure' || summary.errorCode !== undefined
      ? 'failure'
      : summary.terminationReason === 'cancelled'
        ? 'cancelled'
        : 'success';
  const last = projected.at(-1);
  const attachAttempt =
    summary.finalProviderId !== undefined &&
    summary.finalHttpStatus !== undefined &&
    last?.providerId === summary.finalProviderId;
  return {
    outcome,
    ...(summary.finalProviderId === undefined ? {} : { finalProviderId: summary.finalProviderId }),
    ...(summary.finalModelId === undefined ? {} : { finalModelId: summary.finalModelId }),
    ...(completion.sessionState?.responseId === undefined ? {} : { responseId: completion.sessionState.responseId }),
    ...(summary.finalHttpStatus === undefined ? {} : { finalStatusCode: summary.finalHttpStatus }),
    ...(summary.errorCode === undefined ? {} : { errorCode: summary.errorCode }),
    ...(summary.usage === undefined ? {} : { usage: summary.usage }),
    ...(attachAttempt && last !== undefined ? { attempt: last } : {}),
  };
}

function str(attrs: Record<string, unknown>, key: string): string | undefined {
  const value = attrs[key];
  return typeof value === 'string' ? value : undefined;
}

function num(attrs: Record<string, unknown>, key: string): number | undefined {
  const value = attrs[key];
  return typeof value === 'number' ? value : undefined;
}

function bool(attrs: Record<string, unknown>, key: string): boolean | undefined {
  const value = attrs[key];
  return typeof value === 'boolean' ? value : undefined;
}
