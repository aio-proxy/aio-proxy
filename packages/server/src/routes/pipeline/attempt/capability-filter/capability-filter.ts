import type { AudioCapability, InboundCapability, RouterSelectionSource } from '@aio-proxy/core';
import type { RouterModelPolicy } from '@aio-proxy/types';

import {
  metadataHasImageOutput,
  supportsEmbedding,
  supportsImage,
  supportsLanguage,
  supportsSpeech,
  supportsTranscription,
  supportsVideo,
} from '../../../../provider-runtime';
import type { ModelCapabilityIndex, RuntimeProviderInstance } from '../../../../runtime';
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
    if (capability === 'video') return supportsVideo(candidate.provider.capabilityIndex, candidate.modelId);
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
 * Effective audio support: the upstream-id index whenever it speaks for audio at
 * all, and only otherwise an attached transport for the requested direction. The
 * index alone is too narrow - a bridged `@ai-sdk/openai` provider reports the
 * OpenAI Responses target protocol, so its index grants language and embedding
 * while `attachAudioTransports` gave it working speech and transcription models.
 *
 * The transport is the escape hatch for exactly that case, and the hatch must be
 * PROVIDER-scoped, not model-scoped. Transports are attached per provider, so a
 * plugin cataloging one TTS model beside a dozen language models gets a
 * provider-level speech transport that says nothing about any individual id: a
 * per-model fallback would read that transport as proof every language model
 * speaks, and hand dispatch a `speechModel('gpt-4o')` call the upstream can only
 * reject. So the moment the index names either audio direction for ANY of the
 * provider's models, it is the authority for all of them, and its silence on the
 * requested direction is a denial. Only an index that knows no audio whatsoever -
 * a bridge with no model-level audio metadata - opens the hatch.
 *
 * Presence of the transport, not `kind`, is what opens it: an API provider that
 * does not serve `openai-audio` has no raw endpoint to passthrough to, so
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
  if (indexKnowsAudio(capabilityIndex)) {
    return capability === 'speech'
      ? supportsSpeech(capabilityIndex, candidate.modelId)
      : supportsTranscription(capabilityIndex, candidate.modelId);
  }
  return (capability === 'speech' ? speech : transcription) !== undefined;
}

// Memoized on the index object, which is built once per runtime provider: without
// it every audio candidate would rescan a catalog that can run to thousands of ids.
const audioAwareIndexes = new WeakMap<object, boolean>();

function indexKnowsAudio(index: ModelCapabilityIndex): boolean {
  const cached = audioAwareIndexes.get(index);
  if (cached !== undefined) return cached;
  const known = Object.values(index).some(
    (capabilities) => capabilities.has('speech') || capabilities.has('transcription'),
  );
  audioAwareIndexes.set(index, known);
  return known;
}
