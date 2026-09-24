import { expect, spyOn, test } from 'bun:test';

import type { TraceCompletion } from '@aio-proxy/core/db';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { withRequestLogContext } from '../../../../request-logging';
import { attributeName, createRequestTraceRecorder, getTraceRuntime } from '../../../../request-tracing';
import { toExportableSpan } from '../../../../request-tracing/otel-export/safe-span';
import { createAttemptResponseObservation } from '../../../../response-observation';
import type { AttemptInfo } from '../../attempt-base';
import { failureTerminal } from '../../failure';
import { createAttemptEmitter } from './emit';

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

test('a failed attempt span carries provider TTFT in seconds under the standard key', () => {
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
  const emitter = createAttemptEmitter({ session, capability: 'language' });
  const observation = createAttemptResponseObservation({ startedAt: 100, now: () => 100 });
  observation.observeFetchStart();
  observation.observeResponse(new Response('body'), { controlledStream: false });
  observation.observeContent(160);

  emitter.emitAttempt(base, 0, observation, failureTerminal(502, 'upstream_error'));
  session.finish({ outcome: 'failure', finalHttpStatus: 502, errorCode: 'upstream_error' });

  const attempt = completions[0]?.spans.find((span) => span.spanId !== session.rootSpanId);
  expect(attempt?.attributes[attributeName.genAiTimeToFirstChunk]).toBe(0.06);
  expect(attempt?.attributes[attributeName.attemptTtftMs]).toBeUndefined();
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
  const emitter = createAttemptEmitter({ session, capability: 'evaluation' });
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 0 });

  emitter.emitAttempt(base, 0, observation, failureTerminal(502, 'upstream_error'));
  session.finish({ outcome: 'failure', finalHttpStatus: 502, errorCode: 'upstream_error' });

  const attempt = completions[0]?.spans.find((span) => span.spanId !== session.rootSpanId);
  expect(attempt?.name).toBe(`evaluation ${base.modelId}`);
  expect(attempt?.attributes[attributeName.genAiOperationName]).toBe('evaluation');
});

test('a generic provider does not derive gen_ai.provider.name from its target protocol', () => {
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
  const emitter = createAttemptEmitter({ session, capability: 'language' });
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 0 });

  emitter.emitAttempt(
    { ...base, targetProtocol: ProviderProtocol.OpenAICompatible },
    0,
    observation,
    failureTerminal(502, 'upstream_error'),
  );
  session.finish({ outcome: 'failure', finalHttpStatus: 502, errorCode: 'upstream_error' });

  const attempt = completions[0]?.spans.find((span) => span.spanId !== session.rootSpanId);
  expect(attempt?.attributes[attributeName.genAiProviderName]).toBeUndefined();
  expect(attempt?.attributes[attributeName.targetProtocol]).toBe(ProviderProtocol.OpenAICompatible);
});

test('an explicitly named runtime attaches gen_ai.provider.name independently of protocol', () => {
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
  const emitter = createAttemptEmitter({ session, capability: 'evaluation' });
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 0 });

  emitter.emitAttempt(
    { ...base, genAiProviderName: 'openrouter', targetProtocol: ProviderProtocol.OpenAICompatible } as AttemptInfo & {
      readonly genAiProviderName: string;
    },
    0,
    observation,
    failureTerminal(502, 'upstream_error'),
  );
  session.finish({ outcome: 'failure', finalHttpStatus: 502, errorCode: 'upstream_error' });

  const attempt = completions[0]?.spans.find((span) => span.spanId !== session.rootSpanId);
  expect(attempt?.attributes[attributeName.genAiProviderName]).toBe('openrouter');
  expect(attempt?.attributes[attributeName.targetProtocol]).toBe(ProviderProtocol.OpenAICompatible);
});

test('an unambiguous observed endpoint is attached to the provider inference span', () => {
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
  const emitter = createAttemptEmitter({ session, capability: 'language' });
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 0 });
  observation.observeFetchStart({ serverAddress: 'provider.test', serverPort: 8443 });

  emitter.emitAttempt(base, 0, observation, failureTerminal(502, 'upstream_error'));
  session.finish({ outcome: 'failure', finalHttpStatus: 502, errorCode: 'upstream_error' });

  const attempt = completions[0]?.spans.find((span) => span.spanId !== session.rootSpanId);
  expect(attempt?.attributes[attributeName.serverAddress]).toBe('provider.test');
  expect(attempt?.attributes[attributeName.serverPort]).toBe(8443);
});

test('sensitive attempts omit identifier-shaped response models from persistence and export', () => {
  const sentinel = 'private-evaluator-sentinel';
  const completions: TraceCompletion[] = [];
  const exported: unknown[] = [];
  const exportSpan = spyOn(getTraceRuntime().exporter, 'onEnd').mockImplementation((span) => {
    exported.push(toExportableSpan(span));
  });
  const recorder = createRequestTraceRecorder({
    store: {
      startRoot() {},
      prune() {},
      recover() {},
      complete(value) {
        completions.push(value);
        return true;
      },
    },
  });
  try {
    withRequestLogContext({ requestId: 'private-request', debug: true, capturePayload: false, logger() {} }, () => {
      const session = recorder.begin({
        inboundRequest: new Request('http://localhost'),
        inboundProtocol: 'openai-response',
      });
      const emitter = createAttemptEmitter({ session, capability: 'language' });
      const attempt = emitter.startAttempt(base, 0);
      emitter.endAttempt(
        attempt,
        createAttemptResponseObservation({ startedAt: 0 }),
        { outcome: 'success' },
        { responseModelId: sentinel },
      );
      session.finish({ outcome: 'success', finalProviderId: base.providerId, finalModelId: base.modelId });
    });
    expect(JSON.stringify(completions)).not.toContain(sentinel);
    expect(JSON.stringify(exported)).not.toContain(sentinel);
    expect(completions[0]?.summary.finalProviderId).toBe(base.providerId);
  } finally {
    exportSpan.mockRestore();
  }
});
