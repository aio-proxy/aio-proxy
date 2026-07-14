import type { JsonValue, ModelCatalog, ModelDescriptor } from "@aio-proxy/plugin-sdk";

const MODALITIES = ["language", "image", "embedding", "speech", "transcription", "reranking"] as const;
type Modality = (typeof MODALITIES)[number];

export class ModelCatalogValidationError extends Error {
  readonly modality: Modality;
  readonly index: number;
  readonly path: readonly (string | number)[];

  constructor(modality: Modality, index: number, path: readonly (string | number)[]) {
    super("Plugin model catalog is invalid");
    this.name = "ModelCatalogValidationError";
    this.modality = modality;
    this.index = index;
    this.path = path;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
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

function validateDescriptors(modality: Modality, value: unknown): readonly ModelDescriptor[] {
  if (!Array.isArray(value)) throw new ModelCatalogValidationError(modality, -1, []);
  const seen = new Set<string>();
  return value.map((descriptor, index) => {
    if (!isRecord(descriptor)) throw new ModelCatalogValidationError(modality, index, []);
    const { id: rawId, displayName, metadata } = descriptor;
    if (typeof rawId !== "string" || rawId.trim() === "") {
      throw new ModelCatalogValidationError(modality, index, ["id"]);
    }
    const id = rawId.trim();
    if (seen.has(id)) throw new ModelCatalogValidationError(modality, index, ["id"]);
    seen.add(id);
    if (displayName !== undefined && typeof displayName !== "string") {
      throw new ModelCatalogValidationError(modality, index, ["displayName"]);
    }
    if (metadata !== undefined && !isJsonValue(metadata)) {
      throw new ModelCatalogValidationError(modality, index, ["metadata"]);
    }
    return {
      id,
      ...(displayName === undefined ? {} : { displayName }),
      ...(metadata === undefined ? {} : { metadata }),
    };
  });
}

export function validateModelCatalog(value: unknown): ModelCatalog {
  if (!isRecord(value)) throw new ModelCatalogValidationError("language", -1, []);
  const { language, image, embedding, speech, transcription, reranking } = value;
  return {
    language: validateDescriptors("language", language),
    image: validateDescriptors("image", image),
    embedding: validateDescriptors("embedding", embedding),
    speech: validateDescriptors("speech", speech),
    transcription: validateDescriptors("transcription", transcription),
    reranking: validateDescriptors("reranking", reranking),
  };
}
