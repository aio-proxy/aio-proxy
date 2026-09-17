import { attributeName, createRequestTraceRecorder, spanName } from '../../src/request-tracing';
// Wraps the real RequestTraceRecorder with an in-memory trace store, then
// projects each completed trace back into the legacy {begins, identities,
// attempts, finals} shapes the pipeline tests assert against. This keeps the
// tests behavior-level while exercising the production recorder + span buffer.
export function createRecording() {
  const begins = [];
  const identities = [];
  const attempts = [];
  const finals = [];
  const spans = [];
  const waiters = [];
  const store = {
    startRoot() {},
    prune() {},
    complete(completion) {
      for (const span of completion.spans) spans.push(span);
      const projected = projectAttempts(completion.spans);
      for (const attempt of projected) attempts.push(attempt);
      finals.push(projectFinal(completion, projected));
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (finals.length < waiter.target) continue;
        waiters.splice(index, 1);
        waiter.resolve();
      }
      return true;
    },
  };
  const real = createRequestTraceRecorder({ store });
  const recorder = {
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
    spans,
    settle() {
      const target = begins.length;
      if (finals.length >= target) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ target, resolve }));
    },
  };
}
function projectAttempts(spans) {
  return spans.filter((span) => span.name === spanName.attempt).map(projectAttempt);
}
function projectAttempt(span) {
  const attrs = span.attributes;
  const protocol = str(attrs, attributeName.targetProtocol);
  const providerWeight = num(attrs, attributeName.providerWeight);
  const routingContractVersion = num(attrs, attributeName.routingContractVersion);
  const effectivePriority = num(attrs, attributeName.effectivePriority);
  const effectiveWeight = num(attrs, attributeName.effectiveWeight);
  const prioritySource = str(attrs, attributeName.prioritySource);
  const weightSource = str(attrs, attributeName.weightSource);
  const selectionSource = str(attrs, attributeName.selectionSource);
  const transport = str(attrs, attributeName.transport);
  const sourceProtocol = str(attrs, attributeName.sourceProtocol);
  const selectionReason = str(attrs, attributeName.selectionReason);
  const attemptIndex = num(attrs, attributeName.attemptIndex);
  const statusCode = num(attrs, attributeName.httpStatusCode);
  const errorCode = str(attrs, attributeName.errorCode);
  const stream = bool(attrs, attributeName.stream);
  const ttftMs = num(attrs, attributeName.ttftMs);
  const transportObservation = str(attrs, attributeName.transportObservation);
  const upstreamHeadersMs = num(attrs, attributeName.upstreamHeadersMs);
  const firstUpstreamByteMs = num(attrs, attributeName.firstUpstreamByteMs);
  const firstSseEventMs = num(attrs, attributeName.firstSseEventMs);
  const contentGapP95Ms = num(attrs, attributeName.contentGapP95Ms);
  const maxSseFramesPerRead = num(attrs, attributeName.maxSseFramesPerRead);
  const contentEncoding = str(attrs, attributeName.contentEncoding);
  return {
    providerId: str(attrs, attributeName.providerId) ?? '',
    modelId: str(attrs, attributeName.genAiResponseModel) ?? '',
    providerKind: str(attrs, attributeName.providerKind) ?? '',
    durationMs: Math.max(0, span.endedAt.getTime() - span.startedAt.getTime()),
    outcome: str(attrs, attributeName.terminationReason) ?? 'success',
    ...(providerWeight === undefined ? {} : { providerWeight }),
    ...(routingContractVersion === undefined ? {} : { routingContractVersion }),
    ...(effectivePriority === undefined ? {} : { effectivePriority }),
    ...(effectiveWeight === undefined ? {} : { effectiveWeight }),
    ...(prioritySource === undefined ? {} : { prioritySource }),
    ...(weightSource === undefined ? {} : { weightSource }),
    ...(selectionSource === undefined ? {} : { selectionSource }),
    ...(attemptIndex === undefined ? {} : { attemptIndex }),
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
function projectFinal(completion, projected) {
  const { summary } = completion;
  let outcome = 'success';
  if (summary.terminationReason === 'cancelled') outcome = 'cancelled';
  if (summary.terminationReason === 'failure' || summary.errorCode !== undefined) outcome = 'failure';
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
function str(attrs, key) {
  const value = attrs[key];
  return typeof value === 'string' ? value : undefined;
}
function num(attrs, key) {
  const value = attrs[key];
  return typeof value === 'number' ? value : undefined;
}
function bool(attrs, key) {
  const value = attrs[key];
  return typeof value === 'boolean' ? value : undefined;
}
