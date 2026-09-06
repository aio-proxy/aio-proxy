import type { AudioInvocation, AudioResult } from '@aio-proxy/core';

import { terminalCompletion } from '../../../route-observation';
import type { AudioTransportInvokeOptions, SpeechTransport, TranscriptionTransport } from '../../../runtime';
import { captureAudioUsage } from '../../../usage-capture/audio-capture';
import { attemptBase, candidateConfigPrice } from '../attempt-base';
import { publicSlug } from '../public-slug';
import { candidateSupportsAudio } from './capability-filter';
import type { AttemptStep, AudioAttemptLoopContext, CandidateSlot } from './context';
import { emitReject, unsupportedDispatch } from './error';
import { completeRawAttempt, startRawAttempt } from './raw';
import { requestPathProperty } from './request-path';

// Audio dispatch for one candidate. Same-protocol raw wins, otherwise the
// request converts into a speech or transcription invocation. The language model
// transport is never consulted: audio does not travel as model messages.
export async function attemptAudioCandidate<TRequest, TContext>(
  ctx: AudioAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
): Promise<AttemptStep> {
  const { adapter, context, rawRequest, request } = ctx;
  const { candidate } = slot;
  const provider = candidate.provider;
  // The same predicate the capability filter used, so a bridged provider that
  // legitimately passed the filter is never re-rejected by an index-only check.
  const granted = candidateSupportsAudio(candidate, adapter.capability);
  const raw = granted
    ? provider.raw?.resolve({
        protocol: adapter.protocol,
        modelId: candidate.modelId,
        // `openai-audio` carries both directions on one protocol, so the
        // capability is the only signal that picks the right model descriptor.
        capability: adapter.capability,
        ...requestPathProperty(rawRequest),
      })
    : undefined;
  if (raw !== undefined) {
    slot.trace.transport = 'raw';
    slot.trace.targetProtocol = adapter.protocol;
    const attemptSpan = startRawAttempt(ctx, slot);
    // No supported efforts: audio requests carry no reasoning effort to clamp.
    const upstream = await adapter.rawRequest(rawRequest, request, candidate.modelId, new Set(), context);
    return await completeRawAttempt(ctx, slot, raw, upstream, attemptSpan);
  }
  const transport = granted ? audioTransport(ctx, slot) : undefined;
  if (transport !== undefined) {
    return await convertAudioCandidate(ctx, slot, transport);
  }
  slot.trace.transport = undefined;
  slot.trace.targetProtocol = undefined;
  return unsupportedDispatch(ctx, slot);
}

type AudioTransport =
  | { readonly kind: 'speech'; readonly speech: SpeechTransport }
  | { readonly kind: 'transcription'; readonly transcription: TranscriptionTransport };

// A transport grants exactly the direction it implements: a speech-only provider
// must not answer a transcription request with synthesized audio.
function audioTransport<TRequest, TContext>(
  ctx: AudioAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
): AudioTransport | undefined {
  const provider = slot.candidate.provider;
  if (ctx.adapter.capability === 'speech') {
    return provider.speech === undefined ? undefined : { kind: 'speech', speech: provider.speech };
  }
  return provider.transcription === undefined
    ? undefined
    : { kind: 'transcription', transcription: provider.transcription };
}

async function convertAudioCandidate<TRequest, TContext>(
  ctx: AudioAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  transport: AudioTransport,
): Promise<AttemptStep> {
  const { adapter, context, rawRequest, request, session, logicalRequest } = ctx;
  const { index, candidate, startedAt, observation, inAttempt } = slot;
  const provider = candidate.provider;
  // A skip, not a rejection: this candidate cannot convert the request, but a
  // later candidate with raw passthrough still can.
  const skipReason = adapter.convertSkipReason?.(request, candidate.modelId, context);
  if (skipReason !== undefined) return { kind: 'skip', reason: skipReason };

  slot.trace.transport = 'audio';
  slot.trace.targetProtocol = undefined;

  let invocation: AudioInvocation;
  try {
    invocation = adapter.audioInvocation(request, context);
  } catch (error) {
    const mapped = adapter.errors.requestError(error);
    if (mapped === undefined) throw error;
    return emitReject(ctx, slot, mapped, mapped.status === 501 ? 'unsupported_feature' : 'invalid_request');
  }
  // Both `invocation` and `transport` were chosen from the same
  // `adapter.capability`, so they always agree by construction.
  const attemptSpan = ctx.emitter.startAttempt(attemptBase(provider, candidate.modelId, startedAt, slot.trace), index);
  slot.spanRef.current = attemptSpan;
  const result = await inAttempt(undefined, () => {
    observation.markTransportUnavailable();
    return invokeAudioTransport(invocation, transport, {
      modelId: candidate.modelId,
      ...(rawRequest.signal === undefined ? {} : { signal: rawRequest.signal }),
      logicalRequest,
    });
  });

  // Egress owns the media type and the transcription body shape; the pipeline
  // never inspects or infers either.
  const response = await adapter.audioResponse(result, request, { modelId: candidate.modelId });
  slot.spanRef.current = undefined;
  const configPrice = candidateConfigPrice(
    ctx.routerModels,
    publicSlug(ctx.requestedModelId, candidate),
    provider.id,
    provider.upstreamMetadata?.[candidate.modelId]?.cost,
  );
  // Neither audio result carries tokens, so this only bills a configured
  // per-request fee and returns undefined when none applies.
  const usage = await captureAudioUsage({
    providerId: provider.id,
    modelId: candidate.modelId,
    requestedModelId: ctx.requestedModelId,
    ...(configPrice === undefined ? {} : { configPrice }),
  });
  session.finishFrom(
    ctx.emitter.settleSuccess(
      attemptSpan,
      observation,
      terminalCompletion(
        Promise.resolve({
          outcome: 'success',
          statusCode: response.status,
          ...(usage === undefined ? {} : { usage }),
        }),
        rawRequest.signal,
      ),
      { providerId: provider.id, modelId: candidate.modelId },
      response,
    ),
  );
  return { kind: 'return', response };
}

// Runs the one direction the adapter's capability selected. Both arms were built
// from the same `adapter.capability`, so a disagreement is unreachable and would
// mean the adapter and its transport were wired from different capabilities.
async function invokeAudioTransport(
  invocation: AudioInvocation,
  transport: AudioTransport,
  options: AudioTransportInvokeOptions,
): Promise<AudioResult> {
  if (invocation.kind === 'speech' && transport.kind === 'speech') {
    await transport.speech.ensureAvailable?.(options.modelId);
    return { kind: 'speech', speech: await transport.speech.invoke(invocation.speech, options) };
  }
  if (invocation.kind === 'transcription' && transport.kind === 'transcription') {
    await transport.transcription.ensureAvailable?.(options.modelId);
    return {
      kind: 'transcription',
      transcription: await transport.transcription.invoke(invocation.transcription, options),
    };
  }
  throw new TypeError(`OpenAI Audio ${transport.kind} transport cannot serve a ${invocation.kind} invocation`);
}
