import { isRecord } from '@aio-proxy/shared';

import type {
  EmbeddingTransport,
  ImageTransport,
  ModelTransport,
  RuntimeProviderInput,
  RuntimeProviderInstance,
  RuntimeRawCapability,
  SpeechTransport,
  TranscriptionTransport,
} from '../../runtime';

// Own-property reads only: a materialized provider must declare its transports
// itself, never inherit one from a prototype (see the inherited-model test).
function ownTransport(provider: RuntimeProviderInput, key: string): unknown {
  return Object.hasOwn(provider, key) ? (provider as Readonly<Record<string, unknown>>)[key] : undefined;
}

/**
 * Whether the input is already a materialized runtime provider, i.e. it declares
 * at least one dispatchable transport. Throws when a declared transport has the
 * wrong shape, so a malformed plugin provider fails at materialization rather
 * than mid-request.
 */
export function isMaterializedRuntimeProvider(provider: RuntimeProviderInput): provider is RuntimeProviderInstance {
  const raw = ownTransport(provider, 'raw');
  const model = ownTransport(provider, 'model');
  const image = ownTransport(provider, 'image');
  const embedding = ownTransport(provider, 'embedding');
  const speech = ownTransport(provider, 'speech');
  const transcription = ownTransport(provider, 'transcription');
  if (raw !== undefined && !isRuntimeRawCapability(raw)) {
    throw new TypeError(`Runtime provider ${provider.id} has an invalid raw capability`);
  }
  if (model !== undefined && !isModelTransport(model)) {
    throw new TypeError(`Runtime provider ${provider.id} has an invalid model capability`);
  }
  if (image !== undefined && !isImageTransport(image)) {
    throw new TypeError(`Runtime provider ${provider.id} has an invalid image capability`);
  }
  if (embedding !== undefined && !isEmbeddingTransport(embedding)) {
    throw new TypeError(`Runtime provider ${provider.id} has an invalid embedding capability`);
  }
  if (speech !== undefined && !isAudioTransport(speech)) {
    throw new TypeError(`Runtime provider ${provider.id} has an invalid speech capability`);
  }
  if (transcription !== undefined && !isAudioTransport(transcription)) {
    throw new TypeError(`Runtime provider ${provider.id} has an invalid transcription capability`);
  }
  return (
    raw !== undefined ||
    model !== undefined ||
    image !== undefined ||
    embedding !== undefined ||
    speech !== undefined ||
    transcription !== undefined
  );
}

function isRuntimeRawCapability(value: unknown): value is RuntimeRawCapability {
  return typeof value === 'object' && value !== null && 'resolve' in value && typeof value.resolve === 'function';
}

function isModelTransport(value: unknown): value is ModelTransport {
  return (
    typeof value === 'object' &&
    value !== null &&
    'invoke' in value &&
    typeof value.invoke === 'function' &&
    (!('ensureAvailable' in value) ||
      value.ensureAvailable === undefined ||
      typeof value.ensureAvailable === 'function') &&
    (!('targetProtocol' in value) || value.targetProtocol === undefined || typeof value.targetProtocol === 'function')
  );
}

function isImageTransport(value: unknown): value is ImageTransport {
  return (
    typeof value === 'object' &&
    value !== null &&
    'invoke' in value &&
    typeof value.invoke === 'function' &&
    (!('ensureAvailable' in value) ||
      value.ensureAvailable === undefined ||
      typeof value.ensureAvailable === 'function')
  );
}

function isEmbeddingTransport(value: unknown): value is EmbeddingTransport {
  return typeof value === 'object' && value !== null && 'embed' in value && typeof value.embed === 'function';
}

// Speech and transcription share one structural shape (`invoke` plus an optional
// `ensureAvailable`), so one guard covers both; the caller names the capability
// in the error. `isRecord` rather than `isPlainObject`: a plugin may hand over a
// class instance.
function isAudioTransport(value: unknown): value is SpeechTransport | TranscriptionTransport {
  if (!isRecord(value) || typeof value['invoke'] !== 'function') return false;
  const ensureAvailable = value['ensureAvailable'];
  return ensureAvailable === undefined || typeof ensureAvailable === 'function';
}

/** Lifts a legacy provider instance's optional `embed` into an embedding transport. */
export function embeddingTransport(
  source: { readonly embed?: EmbeddingTransport['embed'] } | undefined,
): { readonly embedding: EmbeddingTransport } | Record<never, never> {
  return source?.embed === undefined ? {} : { embedding: { embed: source.embed } };
}
