import type { DescriptorModelMetadata, JsonValue, ModelCatalog, ModelDescriptor } from '@aio-proxy/plugin-sdk';
import { ModelMetadataSchema, isRecord } from '@aio-proxy/types';
import { z } from 'zod';

const MODALITIES = ['language', 'image', 'embedding', 'speech', 'transcription', 'reranking'] as const;
type Modality = (typeof MODALITIES)[number];

export class ModelCatalogValidationError extends Error {
  readonly modality: Modality;
  readonly index: number;
  readonly path: readonly (string | number)[];

  constructor(modality: Modality, index: number, path: readonly (string | number)[]) {
    super('Plugin model catalog is invalid');
    this.name = 'ModelCatalogValidationError';
    this.modality = modality;
    this.index = index;
    this.path = path;
  }
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : (prototype === Object.prototype || prototype === null) &&
      Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

// NOT the loose ModelMetadataSchema: config tolerates unknown keys for
// forward-compat, but plugin metadata must not — a plugin-set `protocol`
// would leak into RuntimeModelMetadata and change dispatch, and loose
// passthrough admits non-JSON values that break catalog persistence.
// z.object strips unknown top-level keys (extend and protocol included);
// the isJsonValue guard below catches what the nested loose schemas admit.
const DescriptorModelMetadataSchema = z.object({
  name: ModelMetadataSchema.shape.name,
  description: ModelMetadataSchema.shape.description,
  limit: ModelMetadataSchema.shape.limit,
  capabilities: ModelMetadataSchema.shape.capabilities,
  cost: ModelMetadataSchema.shape.cost,
});

type ParsedDescriptorModelMetadata = z.output<typeof DescriptorModelMetadataSchema>;

function toDescriptorModelMetadata(data: ParsedDescriptorModelMetadata): DescriptorModelMetadata | undefined {
  const metadata: DescriptorModelMetadata = {
    ...(data.name === undefined ? {} : { name: data.name }),
    ...(data.description === undefined ? {} : { description: data.description }),
    ...(data.limit === undefined ? {} : { limit: data.limit }),
    ...(data.capabilities === undefined ? {} : { capabilities: data.capabilities }),
    ...(data.cost === undefined ? {} : { cost: data.cost }),
  };
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function validateDescriptors(modality: Modality, value: unknown): readonly ModelDescriptor[] {
  if (!Array.isArray(value)) throw new ModelCatalogValidationError(modality, -1, []);
  const seen = new Set<string>();
  return value.map((descriptor, index) => {
    if (!isRecord(descriptor)) throw new ModelCatalogValidationError(modality, index, []);
    const { id: rawId, displayName, extra, modelMetadata } = descriptor;
    if (typeof rawId !== 'string' || rawId.trim() === '') {
      throw new ModelCatalogValidationError(modality, index, ['id']);
    }
    const id = rawId.trim();
    if (seen.has(id)) throw new ModelCatalogValidationError(modality, index, ['id']);
    seen.add(id);
    if (displayName !== undefined && typeof displayName !== 'string') {
      throw new ModelCatalogValidationError(modality, index, ['displayName']);
    }
    if (extra !== undefined && !isJsonValue(extra)) {
      throw new ModelCatalogValidationError(modality, index, ['extra']);
    }
    // Fail-soft: catalogs are upstream-discovered data, so an invalid modelMetadata
    // is dropped rather than failing the whole catalog/Provider.
    let parsedModelMetadata: DescriptorModelMetadata | undefined;
    if (modelMetadata !== undefined) {
      const result = DescriptorModelMetadataSchema.safeParse(modelMetadata);
      if (result.success && isJsonValue(result.data)) {
        parsedModelMetadata = toDescriptorModelMetadata(result.data);
      }
    }
    return {
      id,
      ...(displayName === undefined ? {} : { displayName }),
      ...(extra === undefined ? {} : { extra }),
      ...(parsedModelMetadata === undefined ? {} : { modelMetadata: parsedModelMetadata }),
    };
  });
}

export function validateModelCatalog(value: unknown): ModelCatalog {
  if (!isRecord(value)) throw new ModelCatalogValidationError('language', -1, []);
  const { language, image, embedding, speech, transcription, reranking, extra } = value;
  if (extra !== undefined && !isJsonValue(extra)) {
    throw new ModelCatalogValidationError('language', -1, ['extra']);
  }
  return {
    language: validateDescriptors('language', language),
    image: validateDescriptors('image', image),
    embedding: validateDescriptors('embedding', embedding),
    speech: validateDescriptors('speech', speech),
    transcription: validateDescriptors('transcription', transcription),
    reranking: validateDescriptors('reranking', reranking),
    ...(extra === undefined ? {} : { extra }),
  };
}
