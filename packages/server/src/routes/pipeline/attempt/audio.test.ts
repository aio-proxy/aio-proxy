import { expect, mock, test } from 'bun:test';

import {
  type AudioProtocolAdapter,
  openAISpeechAdapter,
  type OpenAIAudioContext,
  type OpenAISpeechRequest,
  openAITranscriptionAdapter,
  type OpenAITranscriptionRequest,
  parseOpenAISpeech,
} from '@aio-proxy/core';
import { ProviderKind, ProviderProtocol, type RouterModelPolicy } from '@aio-proxy/types';

import { defineProviderRouteSource, settleRecording } from '../../../../__tests__/pipeline-helpers';
import { createAttemptResponseObservation } from '../../../response-observation';
import type { RawResolveInput, RuntimeProviderInstance } from '../../../runtime';
import { handleProtocolRequest } from '../index';
import { attemptAudioCandidate } from './audio';
import type { AudioAttemptLoopContext, CandidateSlot } from './context';
import { createAttemptEmitter } from './emit';

const SPEECH_MODEL = 'tts-1';
const TRANSCRIPTION_MODEL = 'whisper-1';
const SPEECH_URL = 'https://proxy.test/v1/audio/speech';

type Harness<TRequest, TContext> = {
  readonly ctx: AudioAttemptLoopContext<TRequest, TContext>;
  readonly route: ReturnType<typeof defineProviderRouteSource>;
};

// Mirrors the invariants attemptCandidates supplies for one request so each case
// exercises the real emitter / recorder / usage capture wiring.
function harness<TRequest, TContext>(
  adapter: AudioProtocolAdapter<TRequest, TContext>,
  request: TRequest,
  context: TContext,
  options: { readonly modelId?: string; readonly routerModels?: Readonly<Record<string, RouterModelPolicy>> } = {},
): Harness<TRequest, TContext> {
  const requestedModelId = options.modelId ?? SPEECH_MODEL;
  const route = defineProviderRouteSource([]);
  const rawRequest = new Request(SPEECH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: requestedModelId, input: 'hello', voice: 'alloy' }),
  });
  const session = route.source.requestRecorder.begin({ inboundRequest: rawRequest, inboundProtocol: adapter.protocol });
  const resolution = route.source.logicalSessionStore.begin({
    requestedModelId,
    requestId: session.requestId,
    hints: { candidates: [], transcript: 'hello' },
    headers: rawRequest.headers,
  });
  session.identify({ requestedModelId, resolution, mutateSessionState: true, streamRequested: false });
  return {
    route,
    ctx: {
      adapter,
      context,
      rawRequest,
      request,
      requestedModelId,
      routerModels: options.routerModels,
      session,
      source: route.source,
      logicalRequest: resolution.context,
      routingContinuity: { updatesAffinity: false },
      sessionIdentity: resolution.identity,
      streamRequested: false,
      emitter: createAttemptEmitter(session, false),
      release: () => {},
      deferRelease: () => {},
      logFailure: () => {},
      cooldown: route.source.cooldown,
      retryAfterCapMs: 30_000,
    },
  };
}

function speechRequest(body: Record<string, unknown> = {}): OpenAISpeechRequest {
  return parseOpenAISpeech({ model: SPEECH_MODEL, input: 'hello', voice: 'alloy', ...body });
}

function transcriptionRequest(overrides: Partial<OpenAITranscriptionRequest> = {}): OpenAITranscriptionRequest {
  return {
    model: TRANSCRIPTION_MODEL,
    modelDefaulted: false,
    clientModel: TRANSCRIPTION_MODEL,
    upload: { data: new Uint8Array([1, 2, 3]), byteLength: 3, fieldName: 'file', filename: 'clip.mp3' },
    formFields: {},
    rawFormFields: [],
    ...overrides,
  };
}

function slot(
  provider: RuntimeProviderInstance,
  options: { readonly hasNext?: boolean; readonly modelId?: string } = {},
): CandidateSlot {
  const startedAt = performance.now();
  return {
    index: 0,
    candidate: {
      provider,
      modelId: options.modelId ?? SPEECH_MODEL,
      routing: {
        priority: 0,
        weight: 1,
        prioritySource: 'provider',
        weightSource: 'provider',
        configurationIndex: 0,
      },
      selectionSource: 'weighted_random',
    },
    startedAt,
    observation: createAttemptResponseObservation({ startedAt }),
    hasNext: options.hasNext ?? false,
    trace: {
      routingContractVersion: 2,
      providerWeight: 1,
      effectivePriority: 0,
      effectiveWeight: 1,
      prioritySource: 'provider',
      weightSource: 'provider',
      selectionSource: 'weighted_random',
      sourceProtocol: ProviderProtocol.OpenAIAudio,
      selectionReason: 'weight',
    },
    inAttempt: (_targetProtocol, operation) => operation(),
    spanRef: { current: undefined },
  };
}

function fallbackFailure(step: Awaited<ReturnType<typeof attemptAudioCandidate>>): Response | undefined {
  return step.kind === 'fallback' ? step.lastFailure : undefined;
}

test('same-protocol speech raw wins and names the speech direction to the raw resolver', async () => {
  const resolved: RawResolveInput[] = [];
  const invoke = mock(async () => new Response(new Uint8Array([9, 9]), { headers: { 'content-type': 'audio/mpeg' } }));
  const speech = mock(async () => ({ audio: new Uint8Array([1]), mediaType: 'audio/mpeg' }));
  const provider = {
    id: 'azure',
    kind: ProviderKind.OAuth,
    enabled: true,
    capabilityIndex: { [SPEECH_MODEL]: new Set(['speech'] as const) },
    raw: {
      resolve: (input: RawResolveInput) => {
        resolved.push(input);
        return { invoke };
      },
    },
    speech: { invoke: speech },
  } satisfies RuntimeProviderInstance;
  const { ctx, route } = harness(openAISpeechAdapter, speechRequest(), { operation: 'speech' });

  const step = await attemptAudioCandidate(ctx, slot(provider));

  expect(step.kind).toBe('return');
  expect(resolved).toEqual([
    {
      protocol: ProviderProtocol.OpenAIAudio,
      modelId: SPEECH_MODEL,
      capability: 'speech',
      requestPath: '/v1/audio/speech',
    },
  ]);
  expect(invoke).toHaveBeenCalled();
  expect(speech).not.toHaveBeenCalled();
  await settleRecording(route.recording);
  expect(route.recording.attempts.map(({ transport, targetProtocol }) => ({ transport, targetProtocol }))).toEqual([
    { transport: 'raw', targetProtocol: ProviderProtocol.OpenAIAudio },
  ]);
});

test('converts a speech request through the speech transport and answers with the audio bytes', async () => {
  const invocations: unknown[] = [];
  const provider = {
    id: 'openai',
    kind: ProviderKind.Api,
    enabled: true,
    capabilityIndex: { [SPEECH_MODEL]: new Set(['speech'] as const) },
    speech: {
      invoke: async (invocation: unknown) => {
        invocations.push(invocation);
        return { audio: new Uint8Array([7, 8, 9]), mediaType: 'audio/opus' };
      },
    },
  } satisfies RuntimeProviderInstance;
  const { ctx, route } = harness(openAISpeechAdapter, speechRequest({ voice: 'nova', response_format: 'opus' }), {
    operation: 'speech',
  });

  const step = await attemptAudioCandidate(ctx, slot(provider));

  expect(step.kind).toBe('return');
  const response = step.kind === 'return' ? step.response : undefined;
  expect(response?.status).toBe(200);
  expect(response?.headers.get('content-type')).toBe('audio/opus');
  expect(new Uint8Array(await response!.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]));
  expect(invocations).toEqual([{ text: 'hello', voice: 'nova', outputFormat: 'opus' }]);
  await settleRecording(route.recording);
  expect(route.recording.attempts.map(({ providerId, transport }) => ({ providerId, transport }))).toEqual([
    { providerId: 'openai', transport: 'audio' },
  ]);
  // The convert path never spoke the upstream's protocol, so the attempt records
  // no target protocol — unlike the raw arm, which records `openai-audio`.
  expect(route.recording.attempts[0]?.targetProtocol).toBeUndefined();
});

test('converts a transcription request through the transcription transport, not the speech one', async () => {
  const speech = mock(async () => ({ audio: new Uint8Array([1]), mediaType: 'audio/mpeg' }));
  const audioBytes: Uint8Array[] = [];
  const provider = {
    id: 'openai',
    kind: ProviderKind.Api,
    enabled: true,
    capabilityIndex: { [TRANSCRIPTION_MODEL]: new Set(['transcription'] as const) },
    speech: { invoke: speech },
    transcription: {
      invoke: async (invocation: { readonly audio: Uint8Array }) => {
        audioBytes.push(invocation.audio);
        return { text: 'hello there', segments: [] };
      },
    },
  } satisfies RuntimeProviderInstance;
  const { ctx } = harness(
    openAITranscriptionAdapter,
    transcriptionRequest(),
    { operation: 'transcriptions' },
    {
      modelId: TRANSCRIPTION_MODEL,
    },
  );

  const step = await attemptAudioCandidate(ctx, slot(provider, { modelId: TRANSCRIPTION_MODEL }));

  expect(step.kind).toBe('return');
  expect(step.kind === 'return' ? await step.response.json() : undefined).toEqual({ text: 'hello there' });
  expect(audioBytes).toEqual([new Uint8Array([1, 2, 3])]);
  expect(speech).not.toHaveBeenCalled();
});

test('a speech-only provider cannot serve a transcription request', async () => {
  const speech = mock(async () => ({ audio: new Uint8Array([1]), mediaType: 'audio/mpeg' }));
  const provider = {
    id: 'speech-only',
    kind: ProviderKind.Api,
    enabled: true,
    capabilityIndex: { [TRANSCRIPTION_MODEL]: new Set(['speech'] as const) },
    speech: { invoke: speech },
  } satisfies RuntimeProviderInstance;
  const { ctx } = harness(
    openAITranscriptionAdapter,
    transcriptionRequest(),
    { operation: 'transcriptions' },
    {
      modelId: TRANSCRIPTION_MODEL,
    },
  );

  const step = await attemptAudioCandidate(ctx, slot(provider, { hasNext: true, modelId: TRANSCRIPTION_MODEL }));

  expect(step.kind).toBe('fallback');
  expect(fallbackFailure(step)?.status).toBe(501);
  expect(speech).not.toHaveBeenCalled();
});

test('refuses translations on the convert path so another candidate can still serve it', async () => {
  const transcribe = mock(async () => ({ text: 'never', segments: [] }));
  const provider = {
    id: 'openai',
    kind: ProviderKind.Api,
    enabled: true,
    capabilityIndex: { [TRANSCRIPTION_MODEL]: new Set(['transcription'] as const) },
    transcription: { invoke: transcribe },
  } satisfies RuntimeProviderInstance;
  const { ctx } = harness(
    openAITranscriptionAdapter,
    transcriptionRequest(),
    { operation: 'translations' },
    {
      modelId: TRANSCRIPTION_MODEL,
    },
  );

  const step = await attemptAudioCandidate(ctx, slot(provider, { hasNext: true, modelId: TRANSCRIPTION_MODEL }));

  expect(step).toEqual({ kind: 'skip', reason: 'translations' });
  expect(transcribe).not.toHaveBeenCalled();
});

test('declines stream_format on the convert path with a fallback-capable 501', async () => {
  const speech = mock(async () => ({ audio: new Uint8Array([1]), mediaType: 'audio/mpeg' }));
  const provider = {
    id: 'openai',
    kind: ProviderKind.Api,
    enabled: true,
    capabilityIndex: { [SPEECH_MODEL]: new Set(['speech'] as const) },
    speech: { invoke: speech },
  } satisfies RuntimeProviderInstance;
  const { ctx } = harness(openAISpeechAdapter, speechRequest({ stream_format: 'sse' }), { operation: 'speech' });

  const step = await attemptAudioCandidate(ctx, slot(provider, { hasNext: true }));

  expect(step.kind).toBe('fallback');
  const failure = fallbackFailure(step);
  expect(failure?.status).toBe(501);
  expect(await failure?.json()).toMatchObject({ error: { code: 'unsupported_feature' } });
  expect(speech).not.toHaveBeenCalled();

  // The traced error code is a distinct value from the body's `error.code`: the
  // body comes from the protocol error mapper, the trace from the pipeline. Only
  // the last candidate finalizes the trace, so re-run without a next candidate.
  const terminal = harness(openAISpeechAdapter, speechRequest({ stream_format: 'sse' }), { operation: 'speech' });
  const terminalStep = await attemptAudioCandidate(terminal.ctx, slot(provider));

  expect(terminalStep.kind).toBe('return');
  await settleRecording(terminal.route.recording);
  expect(terminal.route.recording.attempts.map(({ statusCode, errorCode }) => ({ statusCode, errorCode }))).toEqual([
    { statusCode: 501, errorCode: 'unsupported_feature' },
  ]);
  expect(terminal.route.recording.finals[0]).toMatchObject({ outcome: 'failure', errorCode: 'unsupported_feature' });
});

test('turns a segment-less verbose_json result into a fallback-capable 501, not a 500', async () => {
  // Egress can only tell that `verbose_json` is unrenderable once the result is in
  // hand. Without the mapping in the pipeline that throw would escape as a generic
  // 500 and no later raw candidate would get a turn.
  const provider = {
    id: 'openai',
    kind: ProviderKind.Api,
    enabled: true,
    capabilityIndex: { [TRANSCRIPTION_MODEL]: new Set(['transcription'] as const) },
    transcription: { invoke: async () => ({ text: 'hello there', segments: [] }) },
  } satisfies RuntimeProviderInstance;
  const { ctx } = harness(
    openAITranscriptionAdapter,
    transcriptionRequest({ formFields: { response_format: 'verbose_json' }, response_format: 'verbose_json' }),
    { operation: 'transcriptions' },
    { modelId: TRANSCRIPTION_MODEL },
  );

  const step = await attemptAudioCandidate(ctx, slot(provider, { hasNext: true, modelId: TRANSCRIPTION_MODEL }));

  expect(step.kind).toBe('fallback');
  const failure = fallbackFailure(step);
  expect(failure?.status).toBe(501);
  expect(await failure?.json()).toMatchObject({ error: { code: 'unsupported_feature' } });
});

test('bills the configured per-request fee on the audio convert path', async () => {
  const provider = {
    id: 'openai',
    kind: ProviderKind.Api,
    enabled: true,
    capabilityIndex: { [SPEECH_MODEL]: new Set(['speech'] as const) },
    speech: { invoke: async () => ({ audio: new Uint8Array([1]), mediaType: 'audio/mpeg' }) },
  } satisfies RuntimeProviderInstance;
  const { ctx, route } = harness(
    openAISpeechAdapter,
    speechRequest(),
    { operation: 'speech' },
    {
      routerModels: { [SPEECH_MODEL]: { metadata: { cost: { request: 0.03 } }, providers: {} } },
    },
  );

  const step = await attemptAudioCandidate(ctx, slot(provider));
  expect(step.kind).toBe('return');
  await settleRecording(route.recording);

  expect(route.recording.finals[0]).toMatchObject({
    outcome: 'success',
    usage: { estimatedCostUsd: 0.03, priceSource: 'config' },
  });
});

test('the pipeline dispatches an audio adapter through the audio arm, not the language arm', async () => {
  const modelInvoke = mock(() => new ReadableStream());
  const provider = {
    id: 'openai',
    kind: ProviderKind.AiSdk,
    enabled: true,
    models: [SPEECH_MODEL],
    capabilityIndex: { [SPEECH_MODEL]: new Set(['speech'] as const) },
    speech: { invoke: async () => ({ audio: new Uint8Array([4, 5]), mediaType: 'audio/mpeg' }) },
    model: { invoke: modelInvoke },
  } as unknown as RuntimeProviderInstance;
  const route = defineProviderRouteSource([{ calls: { ensure: 0, model: [], raw: [] }, provider }]);

  const response = await handleProtocolRequest({
    adapter: openAISpeechAdapter,
    context: { operation: 'speech' } satisfies OpenAIAudioContext,
    rawRequest: new Request(SPEECH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: SPEECH_MODEL, input: 'hello', voice: 'alloy' }),
    }),
    source: route.source,
  });

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('audio/mpeg');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([4, 5]));
  expect(modelInvoke).not.toHaveBeenCalled();
  await settleRecording(route.recording);
  expect(route.recording.attempts.map(({ providerId, transport }) => ({ providerId, transport }))).toEqual([
    { providerId: 'openai', transport: 'audio' },
  ]);
});
