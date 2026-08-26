import { type ModelMetadata, ProviderProtocol } from '@aio-proxy/types';

import type {
  InboundCapability,
  ModelCapabilityIndex,
  RuntimeModelMetadata,
  RuntimeProviderInstance,
} from '../../runtime';

export type CapabilityIndexInput = {
  readonly catalog?: {
    readonly language?: readonly { readonly id: string }[];
    readonly image?: readonly { readonly id: string }[];
  };
  readonly models?: readonly string[];
  readonly metadata?: Readonly<Record<string, ModelMetadata | undefined>>;
  readonly configMetadata?: Readonly<Record<string, ModelMetadata | undefined>>;
  readonly upstreamMetadata?: Readonly<Record<string, RuntimeModelMetadata | undefined>>;
  readonly hasImageModel?: boolean;
  readonly primaryProtocol?: ProviderProtocol;
  readonly extraProtocols?: readonly ProviderProtocol[];
  readonly aliasTargets?: readonly string[];
  readonly preservedAliasTargets?: readonly string[];
};

export function buildModelCapabilityIndex(input: CapabilityIndexInput): ModelCapabilityIndex {
  const languageIds = new Set((input.catalog?.language ?? []).map((descriptor) => descriptor.id));
  const imageIds = new Set((input.catalog?.image ?? []).map((descriptor) => descriptor.id));
  const finiteIds = finiteNonCatalogIds(input);
  const ids = new Set<string>([...languageIds, ...imageIds, ...finiteIds]);
  const index: Record<string, Set<InboundCapability>> = {};
  for (const id of ids) {
    const capabilities = new Set<InboundCapability>();
    if (languageIds.has(id)) capabilities.add('language');
    if (imageIds.has(id)) capabilities.add('image');
    if (
      metadataHasImageOutput(input.metadata?.[id]) ||
      metadataHasImageOutput(input.configMetadata?.[id]) ||
      metadataHasImageOutput(input.upstreamMetadata?.[id])
    ) {
      capabilities.add('image');
    }
    if (input.primaryProtocol === ProviderProtocol.OpenAIImage) capabilities.add('image');
    if (finiteIds.has(id) && synthesizesLanguage(input)) capabilities.add('language');
    if (capabilities.size > 0) index[id] = capabilities;
  }
  return index;
}

function finiteNonCatalogIds(input: CapabilityIndexInput): Set<string> {
  return new Set([
    ...(input.models ?? []),
    ...(input.aliasTargets ?? []),
    ...(input.preservedAliasTargets ?? []),
    ...Object.keys(input.metadata ?? {}),
    ...Object.keys(input.configMetadata ?? {}),
    ...Object.keys(input.upstreamMetadata ?? {}),
  ]);
}

function synthesizesLanguage(input: CapabilityIndexInput): boolean {
  if (input.primaryProtocol === ProviderProtocol.OpenAIImage) return false;
  return (
    input.primaryProtocol !== undefined || input.catalog === undefined || (input.catalog.language?.length ?? 0) > 0
  );
}

export function supportsLanguage(index: ModelCapabilityIndex, modelId: string): boolean {
  return index[modelId]?.has('language') === true;
}

export function supportsImage(index: ModelCapabilityIndex, modelId: string): boolean {
  return index[modelId]?.has('image') === true;
}

export function supportsImageRaw(provider: RuntimeProviderInstance, modelId: string): boolean {
  return (
    supportsImage(provider.capabilityIndex, modelId) &&
    provider.raw?.resolve({ protocol: ProviderProtocol.OpenAIImage, modelId }) !== undefined
  );
}

export function supportsImageConvert(provider: RuntimeProviderInstance, modelId: string): boolean {
  return supportsImage(provider.capabilityIndex, modelId) && provider.image !== undefined;
}

function metadataHasImageOutput(metadata: ModelMetadata | RuntimeModelMetadata | undefined): boolean {
  return metadata?.capabilities?.modalities?.output?.includes('image') === true;
}
