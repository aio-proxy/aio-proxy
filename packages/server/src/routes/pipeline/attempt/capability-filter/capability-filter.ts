import type { AudioCapability, InboundCapability, RouterSelectionSource } from '@aio-proxy/core';
import type { RouterModelPolicy } from '@aio-proxy/types';

import {
  metadataHasImageOutput,
  supportsEmbedding,
  supportsImage,
  supportsLanguage,
  supportsSpeech,
  supportsTranscription,
} from '../../../../provider-runtime';
import type { RuntimeProviderInstance } from '../../../../runtime';
import { publicSlug } from '../../public-slug';

export function filterCandidatesByCapability<
  T extends { provider: RuntimeProviderInstance; modelId: string; selectionSource: RouterSelectionSource },
>(
  candidates: readonly T[],
  capability: InboundCapability,
  routing: {
    readonly requestedModelId: string;
    readonly routerModels: Readonly<Record<string, RouterModelPolicy>> | undefined;
  },
): T[] {
  return candidates.filter((candidate) => {
    if (capability === 'image') {
      return candidateSupportsImage(candidate, routing.requestedModelId, routing.routerModels);
    }
    if (capability === 'embedding') return supportsEmbedding(candidate.provider.capabilityIndex, candidate.modelId);
    if (capability === 'speech' || capability === 'transcription') {
      return candidateSupportsAudio(candidate, capability);
    }
    return supportsLanguage(candidate.provider.capabilityIndex, candidate.modelId);
  });
}

// Effective image support: the upstream-id index OR the requested slug's
// router-policy grant. The SAME predicate gates the capability filter and
// dispatchImageCandidate - a candidate that passes the filter must never be
// re-rejected downstream by an index-only check.
export function candidateSupportsImage(
  candidate: {
    readonly provider: Pick<RuntimeProviderInstance, 'id' | 'capabilityIndex'>;
    readonly modelId: string;
    readonly selectionSource: RouterSelectionSource;
  },
  requestedModelId: string,
  routerModels: Readonly<Record<string, RouterModelPolicy>> | undefined,
): boolean {
  return (
    supportsImage(candidate.provider.capabilityIndex, candidate.modelId) ||
    metadataHasImageOutput(routerModels?.[publicSlug(requestedModelId, candidate)]?.metadata)
  );
}

/**
 * Effective audio support: the upstream-id index when it knows this model's audio
 * directions, and only otherwise an attached transport for the requested
 * direction. The index alone is too narrow - a bridged `@ai-sdk/openai` provider
 * reports the OpenAI Responses target protocol, so its index grants language and
 * embedding while `attachAudioTransports` gave it working speech and
 * transcription models.
 *
 * The transport is the escape hatch for exactly that case, and it must not
 * override an index that DOES speak for the model: a plugin cataloging one TTS
 * model and one STT model gets both provider-level transports attached, so a
 * transport-first predicate would admit transcription-only `whisper-1` to a
 * speech request and hand dispatch a `speechModel('whisper-1')` call the upstream
 * can only reject. An index entry naming either direction is therefore the
 * authority for both, and its silence on the requested one is a denial.
 *
 * Presence of the transport, not `kind`, is what opens the hatch: an API provider
 * that does not serve `openai-audio` has no raw endpoint to passthrough to, so
 * admitting it by kind would hand the dispatch loop a candidate it must
 * immediately skip. The SAME predicate gates this filter and audio dispatch.
 */
export function candidateSupportsAudio(
  candidate: {
    readonly provider: Pick<RuntimeProviderInstance, 'capabilityIndex' | 'speech' | 'transcription'>;
    readonly modelId: string;
  },
  capability: AudioCapability,
): boolean {
  const { capabilityIndex, speech, transcription } = candidate.provider;
  const indexedSpeech = supportsSpeech(capabilityIndex, candidate.modelId);
  const indexedTranscription = supportsTranscription(capabilityIndex, candidate.modelId);
  if (indexedSpeech || indexedTranscription) {
    return capability === 'speech' ? indexedSpeech : indexedTranscription;
  }
  return (capability === 'speech' ? speech : transcription) !== undefined;
}
