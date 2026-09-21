import { expect, test } from 'bun:test';

import type { TraceCompletion } from '@aio-proxy/core/db';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { attributeName, createRequestTraceRecorder } from '../../../../request-tracing';
import { createAttemptResponseObservation } from '../../../../response-observation';
import type { AttemptInfo } from '../../attempt-base';
import { failureTerminal } from '../../failure';
import { createAttemptEmitter, genAiProviderNameFor } from './emit';

const base: AttemptInfo = {
  routingContractVersion: 2,
  providerWeight: 1,
  effectivePriority: 0,
  effectiveWeight: 1,
  prioritySource: 'provider',
  weightSource: 'provider',
  selectionSource: 'weighted_random',
  sourceProtocol: ProviderProtocol.OpenAICompatible,
  selectionReason: 'weight',
  providerId: 'p1',
  modelId: 'gpt-4o',
  providerKind: ProviderKind.Api,
  durationMs: 7,
};

test('a failed attempt span carries the observed time to first content', () => {
  const completions: TraceCompletion[] = [];
  const recorder = createRequestTraceRecorder({
    store: {
      startRoot: () => {},
      complete: (input: TraceCompletion) => {
        completions.push(input);
        return true;
      },
      prune: () => {},
      recover: () => {},
    },
  });
  const session = recorder.begin({
    inboundRequest: new Request('http://localhost'),
    inboundProtocol: 'openai-chat',
  });
  const emitter = createAttemptEmitter({ session, streamRequested: true, capability: 'language' });
  const observation = createAttemptResponseObservation({ startedAt: 100, now: () => 100 });
  observation.observeFetchStart();
  observation.observeResponse(new Response('body'), { controlledStream: false });
  observation.observeContent(160);

  emitter.emitAttempt(base, 0, observation, failureTerminal(502, 'upstream_error'));
  session.finish({ outcome: 'failure', finalHttpStatus: 502, errorCode: 'upstream_error' });

  const attempt = completions[0]?.spans.find((span) => span.spanId !== session.rootSpanId);
  expect(attempt?.attributes[attributeName.attemptTtftMs]).toBe(60);
});

test('an evaluation attempt is named as evaluation, not as chat', () => {
  const completions: TraceCompletion[] = [];
  const recorder = createRequestTraceRecorder({
    store: {
      startRoot: () => {},
      complete: (input: TraceCompletion) => {
        completions.push(input);
        return true;
      },
      prune: () => {},
      recover: () => {},
    },
  });
  const session = recorder.begin({
    inboundRequest: new Request('http://localhost'),
    inboundProtocol: 'typesafe-systemone',
  });
  const emitter = createAttemptEmitter({ session, streamRequested: false, capability: 'evaluation' });
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 0 });

  emitter.emitAttempt(base, 0, observation, failureTerminal(502, 'upstream_error'));
  session.finish({ outcome: 'failure', finalHttpStatus: 502, errorCode: 'upstream_error' });

  const attempt = completions[0]?.spans.find((span) => span.spanId !== session.rootSpanId);
  expect(attempt?.name).toBe(`evaluation ${base.modelId}`);
  expect(attempt?.attributes[attributeName.genAiOperationName]).toBe('evaluation');
});

test('does not label System One as a well-known gen_ai provider', () => {
  // A wrong well-known value would fold evaluation hops into another vendor's series.
  expect(genAiProviderNameFor(ProviderProtocol.TypeSafeSystemOne)).toBeUndefined();
});

test('a known target protocol labels gen_ai.provider.name at span creation', () => {
  const completions: TraceCompletion[] = [];
  const recorder = createRequestTraceRecorder({
    store: {
      startRoot: () => {},
      complete: (input: TraceCompletion) => {
        completions.push(input);
        return true;
      },
      prune: () => {},
      recover: () => {},
    },
  });
  const session = recorder.begin({
    inboundRequest: new Request('http://localhost'),
    inboundProtocol: 'openai-chat',
  });
  const emitter = createAttemptEmitter({ session, streamRequested: false, capability: 'language' });
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 0 });

  emitter.emitAttempt(
    { ...base, targetProtocol: ProviderProtocol.OpenAICompatible },
    0,
    observation,
    failureTerminal(502, 'upstream_error'),
  );
  session.finish({ outcome: 'failure', finalHttpStatus: 502, errorCode: 'upstream_error' });

  const attempt = completions[0]?.spans.find((span) => span.spanId !== session.rootSpanId);
  expect(attempt?.attributes[attributeName.genAiProviderName]).toBe('openai');
  expect(attempt?.attributes[attributeName.targetProtocol]).toBe(ProviderProtocol.OpenAICompatible);
});

test('a known but unnamed target protocol still omits gen_ai.provider.name', () => {
  const completions: TraceCompletion[] = [];
  const recorder = createRequestTraceRecorder({
    store: {
      startRoot: () => {},
      complete: (input: TraceCompletion) => {
        completions.push(input);
        return true;
      },
      prune: () => {},
      recover: () => {},
    },
  });
  const session = recorder.begin({
    inboundRequest: new Request('http://localhost'),
    inboundProtocol: 'typesafe-systemone',
  });
  const emitter = createAttemptEmitter({ session, streamRequested: false, capability: 'evaluation' });
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 0 });

  emitter.emitAttempt(
    { ...base, targetProtocol: ProviderProtocol.TypeSafeSystemOne },
    0,
    observation,
    failureTerminal(502, 'upstream_error'),
  );
  session.finish({ outcome: 'failure', finalHttpStatus: 502, errorCode: 'upstream_error' });

  const attempt = completions[0]?.spans.find((span) => span.spanId !== session.rootSpanId);
  expect(attempt?.attributes[attributeName.genAiProviderName]).toBeUndefined();
  expect(attempt?.attributes[attributeName.targetProtocol]).toBe(ProviderProtocol.TypeSafeSystemOne);
});
