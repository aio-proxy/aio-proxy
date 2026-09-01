import { type ModelMetadata, ProviderProtocol, type RouterModelPolicy } from '@aio-proxy/types';

import type { InboundCapability, ModelCapabilityIndex, RuntimeModelMetadata } from '../../runtime';

export type CapabilityIndexInput = {
  readonly catalog?: {
    readonly language?: readonly { readonly id: string }[];
    readonly image?: readonly { readonly id: string }[];
    readonly embedding?: readonly { readonly id: string }[];
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
  const finiteIds = finiteNonCatalogIds(input);
  const ids = new Set<string>([...languageIds, ...imageIds, ...embeddingIds, ...finiteIds]);
  const index: Record<string, Set<InboundCapability>> = {};
  for (const id of ids) {
    const capabilities = new Set<InboundCapability>();
    if (languageIds.has(id)) capabilities.add('language');
    if (imageIds.has(id)) capabilities.add('image');
    if (embeddingIds.has(id)) capabilities.add('embedding');
    if (metadataHasImageOutput(input.upstreamMetadata?.[id])) capabilities.add('image');
    if (catalogOnlyImageOutput(input, id)) capabilities.add('image');
    if (input.primaryProtocol === ProviderProtocol.OpenAIImage) capabilities.add('image');
    // Catalog image/embedding ids stay out of synthesized language even when
    // OAuth `models` unions them with language catalog ids.
    const imageOnly = imageIds.has(id) && !languageIds.has(id) && !embeddingIds.has(id);
    const catalogNonLanguage = !languageIds.has(id) && (imageIds.has(id) || embeddingIds.has(id));
    if (finiteIds.has(id) && synthesizesLanguage(input) && !catalogNonLanguage) capabilities.add('language');
    if (finiteIds.has(id) && synthesizesEmbedding(input) && !imageOnly) capabilities.add('embedding');
    if (capabilities.size > 0) index[id] = capabilities;
  }
  return index;
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
  if (input.primaryProtocol === ProviderProtocol.OpenAIImage) return false;
  return (
    input.primaryProtocol !== undefined || input.catalog === undefined || (input.catalog.language?.length ?? 0) > 0
  );
}

function hasLanguageProtocol(protocols: readonly ProviderProtocol[] | undefined): boolean {
  return protocols?.some((protocol) => protocol !== ProviderProtocol.OpenAIImage) === true;
}

function synthesizesEmbedding(input: CapabilityIndexInput): boolean {
  if (input.primaryProtocol === ProviderProtocol.OpenAIImage) return false;
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
