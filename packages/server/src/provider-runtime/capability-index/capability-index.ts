import { type ModelMetadata, ProviderProtocol, type RouterModelPolicy } from '@aio-proxy/types';

import type { InboundCapability, ModelCapabilityIndex, RuntimeModelMetadata } from '../../runtime';

export type CapabilityIndexInput = {
  readonly catalog?: {
    readonly language?: readonly { readonly id: string }[];
    readonly image?: readonly { readonly id: string }[];
    readonly embedding?: readonly { readonly id: string }[];
    readonly speech?: readonly { readonly id: string }[];
    readonly transcription?: readonly { readonly id: string }[];
  };
  readonly models?: readonly string[];
  readonly upstreamMetadata?: Readonly<Record<string, RuntimeModelMetadata | undefined>>;
  /**
   * models.dev fallback metadata, the LOWEST layer (`catalog < upstream < config`). Consulted
   * only for ids whose upstream metadata declares no output modality, so an explicit upstream
   * or authored value always wins.
   *
   * Deliberately NOT part of `finiteNonCatalogIds`: this answers "does an already-routable id
   * produce images?" and must never make an id routable on its own.
   */
  readonly catalogMetadata?: Readonly<Record<string, ModelMetadata | undefined>>;
  readonly hasImageModel?: boolean;
  readonly primaryProtocol?: ProviderProtocol;
  readonly extraProtocols?: readonly ProviderProtocol[];
  readonly aliasTargets?: readonly string[];
  readonly preservedAliasTargets?: readonly string[];
};

export function buildModelCapabilityIndex(input: CapabilityIndexInput): ModelCapabilityIndex {
  const languageIds = new Set((input.catalog?.language ?? []).map((descriptor) => descriptor.id));
  const imageIds = new Set((input.catalog?.image ?? []).map((descriptor) => descriptor.id));
  const embeddingIds = new Set((input.catalog?.embedding ?? []).map((descriptor) => descriptor.id));
  const speechIds = new Set((input.catalog?.speech ?? []).map((descriptor) => descriptor.id));
  const transcriptionIds = new Set((input.catalog?.transcription ?? []).map((descriptor) => descriptor.id));
  const finiteIds = finiteNonCatalogIds(input);
  const ids = new Set<string>([
    ...languageIds,
    ...imageIds,
    ...embeddingIds,
    ...speechIds,
    ...transcriptionIds,
    ...finiteIds,
  ]);
  const protocolServed = protocolCapabilitySet(input);
  const index: Record<string, Set<InboundCapability>> = {};
  for (const id of ids) {
    const capabilities = new Set<InboundCapability>();
    if (languageIds.has(id)) capabilities.add('language');
    if (imageIds.has(id)) capabilities.add('image');
    if (embeddingIds.has(id)) capabilities.add('embedding');
    // Unlike the protocol grant below, a catalog names each audio id's direction,
    // so speech and transcription are recorded separately rather than unioned.
    if (speechIds.has(id)) capabilities.add('speech');
    if (transcriptionIds.has(id)) capabilities.add('transcription');
    if (metadataHasImageOutput(input.upstreamMetadata?.[id])) capabilities.add('image');
    if (catalogOnlyImageOutput(input, id)) capabilities.add('image');
    // Image reads the PRIMARY protocol only, unlike speech/transcription below,
    // which honour extra endpoints too. An extra /images endpoint does not make
    // every listed id an image model - per-model metadata decides that, and
    // `openai-image endpoint on a chat-primary provider ...` pins it. An audio
    // endpoint carries no comparable per-model signal, so it must grant broadly.
    if (input.primaryProtocol !== undefined && protocolServes(input.primaryProtocol, 'image'))
      capabilities.add('image');
    // Catalog image/embedding/audio ids stay out of synthesized language even when
    // OAuth `models` unions them with language catalog ids.
    const imageOnly = imageIds.has(id) && !languageIds.has(id) && !embeddingIds.has(id);
    const catalogNonLanguage =
      !languageIds.has(id) &&
      (imageIds.has(id) || embeddingIds.has(id) || speechIds.has(id) || transcriptionIds.has(id));
    if (finiteIds.has(id) && synthesizesLanguage(input) && !catalogNonLanguage) capabilities.add('language');
    if (finiteIds.has(id) && synthesizesEmbedding(input) && !imageOnly) capabilities.add('embedding');
    if (finiteIds.has(id) && protocolServed.has('speech')) capabilities.add('speech');
    if (finiteIds.has(id) && protocolServed.has('transcription')) capabilities.add('transcription');
    if (capabilities.size > 0) index[id] = capabilities;
  }
  return index;
}

/**
 * The single source of truth for what a wire protocol can serve. Every protocol
 * must be listed: an absent protocol grants nothing, so adding one to the enum
 * without a row here makes its providers unroutable rather than silently
 * dropping them into the language pool.
 *
 * `language`/`embedding` rows are necessary but not sufficient - a listed
 * protocol still has to clear the no-catalog and catalog-membership rules in
 * `synthesizesLanguage`/`synthesizesEmbedding`, which this table cannot see.
 */
const PROTOCOL_CAPABILITIES: Readonly<Record<ProviderProtocol, readonly InboundCapability[]>> = {
  [ProviderProtocol.OpenAIResponse]: ['language', 'embedding'],
  [ProviderProtocol.OpenAICompatible]: ['language', 'embedding'],
  [ProviderProtocol.Anthropic]: ['language', 'embedding'],
  [ProviderProtocol.Gemini]: ['language', 'embedding'],
  [ProviderProtocol.GeminiInteractions]: ['language', 'embedding'],
  [ProviderProtocol.OpenAIImage]: ['image'],
  // One audio base URL serves /audio/speech and /audio/transcriptions alike and
  // never says which direction a given model runs, so both are granted and the
  // upstream rejects the mismatched one. Granting neither would leave an
  // audio-only provider unroutable.
  [ProviderProtocol.OpenAIAudio]: ['speech', 'transcription'],
};

// The optional chain is load-bearing despite the total Record type: a protocol
// value can reach here from parsed config or a newly added enum member before
// the table gains its row, and TypeScript cannot see that gap.
function protocolServes(protocol: ProviderProtocol, capability: InboundCapability): boolean {
  return PROTOCOL_CAPABILITIES[protocol]?.includes(capability) === true;
}

// Every protocol this provider serves, primary plus extra endpoints.
function protocolCapabilitySet(input: CapabilityIndexInput): ReadonlySet<InboundCapability> {
  const protocols = [
    ...(input.primaryProtocol === undefined ? [] : [input.primaryProtocol]),
    ...(input.extraProtocols ?? []),
  ];
  return new Set(protocols.flatMap((protocol) => PROTOCOL_CAPABILITIES[protocol] ?? []));
}

// A provider whose ONLY endpoints lack a chat surface can never answer a chat
// request, so its ids must stay out of the synthesized language pool.
function servesLanguage(protocol: ProviderProtocol): boolean {
  return protocolServes(protocol, 'language');
}

// models.dev sits beneath upstream metadata: it only speaks for ids whose upstream
// metadata declares no output modality at all. An upstream text-only declaration
// therefore still suppresses image, per the Images design's precedence table.
function catalogOnlyImageOutput(input: CapabilityIndexInput, id: string): boolean {
  if (input.upstreamMetadata?.[id]?.capabilities?.modalities?.output !== undefined) return false;
  return metadataHasImageOutput(input.catalogMetadata?.[id]);
}

function finiteNonCatalogIds(input: CapabilityIndexInput): Set<string> {
  return new Set([
    ...(input.models ?? []),
    ...(input.aliasTargets ?? []),
    ...(input.preservedAliasTargets ?? []),
    ...Object.keys(input.upstreamMetadata ?? {}),
  ]);
}

function synthesizesLanguage(input: CapabilityIndexInput): boolean {
  if (hasLanguageProtocol(input.extraProtocols)) return true;
  if (input.primaryProtocol !== undefined && !servesLanguage(input.primaryProtocol)) return false;
  return (
    input.primaryProtocol !== undefined || input.catalog === undefined || (input.catalog.language?.length ?? 0) > 0
  );
}

function hasLanguageProtocol(protocols: readonly ProviderProtocol[] | undefined): boolean {
  return protocols?.some(servesLanguage) === true;
}

function synthesizesEmbedding(input: CapabilityIndexInput): boolean {
  if (input.primaryProtocol !== undefined && !protocolServes(input.primaryProtocol, 'embedding')) return false;
  return input.catalog === undefined;
}

export function supportsLanguage(index: ModelCapabilityIndex, modelId: string): boolean {
  return index[modelId]?.has('language') === true;
}

export function supportsImage(index: ModelCapabilityIndex, modelId: string): boolean {
  return index[modelId]?.has('image') === true;
}

export function supportsEmbedding(index: ModelCapabilityIndex, modelId: string): boolean {
  return index[modelId]?.has('embedding') === true;
}

export function supportsSpeech(index: ModelCapabilityIndex, modelId: string): boolean {
  return index[modelId]?.has('speech') === true;
}

export function supportsTranscription(index: ModelCapabilityIndex, modelId: string): boolean {
  return index[modelId]?.has('transcription') === true;
}

export function metadataHasImageOutput(metadata: ModelMetadata | RuntimeModelMetadata | undefined): boolean {
  return metadata?.capabilities?.modalities?.output?.includes('image') === true;
}

// Provider-agnostic transport plumbing: does ANY router policy declare image
// output? Deliberately not per-provider/per-slug - an attached-but-unused
// transport is harmless, while a granted candidate without a transport is a
// dead end. Per-request enforcement stays in candidateSupportsImage.
export function routerModelsGrantImage(models: Readonly<Record<string, RouterModelPolicy>> | undefined): boolean {
  return Object.values(models ?? {}).some((policy) => metadataHasImageOutput(policy.metadata));
}
