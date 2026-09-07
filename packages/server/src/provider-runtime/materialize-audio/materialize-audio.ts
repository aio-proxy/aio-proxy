import {
  createProviderV4SpeechInvoke,
  createProviderV4TranscribeInvoke,
  loadAiSdkProvider,
  type ProviderFetch,
  providerV4SupportsSpeech,
  providerV4SupportsTranscription,
  resolveApiKey,
  validateProviderV4,
} from '@aio-proxy/core';
import type { AiSdkProvider, ApiProvider, Provider } from '@aio-proxy/types';
import { apiProviderEndpoints, ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import type { RuntimeProviderInstance, SpeechTransport, TranscriptionTransport } from '../../runtime';

type AudioDirections = { readonly speech: boolean; readonly transcription: boolean };

/**
 * Which audio directions each bundled AI SDK package implements, as OPTIONAL
 * ProviderV4 `speechModel` / `transcriptionModel` members. The grant must be
 * direction-specific, not per-package: attaching a transport the package does not
 * implement admits the candidate to that direction's pool only to fail inside the
 * AI SDK on every attempt, while omitting one it does implement 501s a request the
 * provider could have served.
 *
 * Read off the pinned `BUNDLED_PROVIDER_VERSIONS` builds: openai and xai assign
 * both members, google assigns `speechModel` only, groq assigns
 * `transcriptionModel` only. anthropic, mistral, openai-compatible, and openrouter
 * assign neither, so they are absent and can serve audio only through
 * same-protocol raw passthrough.
 */
const AUDIO_BRIDGE_PACKAGES: Readonly<Record<string, AudioDirections | undefined>> = {
  '@ai-sdk/openai': { speech: true, transcription: true },
  '@ai-sdk/xai': { speech: true, transcription: true },
  '@ai-sdk/google': { speech: true, transcription: false },
  '@ai-sdk/groq': { speech: false, transcription: true },
};

/**
 * Which `api` endpoint protocols can back an audio bridge, and with which package.
 * An `openai-response` endpoint is an OpenAI base URL with an accepted key, so
 * @ai-sdk/openai can build `${baseURL}/audio/speech` and `/audio/transcriptions`
 * from the same metadata that already backs its language bridge — refusing to
 * attach would 501 a request the endpoint can serve.
 *
 * Every other protocol is deliberately absent. `openai-compatible` maps to a
 * package that implements neither member. `openai-image` has no audio surface.
 * `openai-audio` needs no bridge: it matches `raw.resolve` for every inbound audio
 * request, so raw passthrough always wins before dispatch reaches a transport.
 * `anthropic`, `gemini`, and `gemini-interactions` are not OpenAI-shaped audio
 * endpoints, so a bridge would fail per attempt rather than 501 up front.
 */
const AUDIO_BRIDGE_PROTOCOLS: Readonly<Partial<Record<ProviderProtocol, string>>> = {
  [ProviderProtocol.OpenAIResponse]: '@ai-sdk/openai',
};

type LoadProvider = typeof loadAiSdkProvider;
// The ProviderV4 structural type, reached through core rather than a direct
// @ai-sdk/provider import: that package is only a devDependency here.
type AudioProviderV4 = Parameters<typeof createProviderV4SpeechInvoke>[1];

/**
 * Attaches speech and transcription transports to a provider whose AI SDK package
 * implements them, so the audio convert path has something to call. Both `ai-sdk`
 * providers (by configured package) and `api` providers (by bridgeable endpoint
 * protocol) are covered — an API provider reaching audio only through raw
 * passthrough would 501 on every cross-protocol request its endpoint could serve.
 *
 * The capability index cannot gate this the way it gates images: a bridged
 * @ai-sdk/openai provider reports the OpenAI Responses target protocol, which
 * grants language and embedding only. `candidateSupportsAudio` falls back to the
 * attached transport for exactly that case — an index that already names either
 * audio direction for the model stays authoritative.
 */
export function attachAudioTransports(
  instance: RuntimeProviderInstance,
  options: {
    readonly config: Provider;
    readonly fetch?: ProviderFetch;
    /** Injection seam mirroring `AiSdkProviderFactoryOptions.loadProvider`. */
    readonly loadProvider?: LoadProvider;
  },
): RuntimeProviderInstance {
  const bridge = audioBridge(options.config);
  if (bridge === undefined) return instance;
  const { directions, packageName, loadOptions } = bridge;
  const load = () =>
    (options.loadProvider ?? loadAiSdkProvider)(packageName, {
      ...loadOptions,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  const id = options.config.id;
  return {
    ...instance,
    ...(directions.speech && instance.speech === undefined ? { speech: lazySpeechTransport(id, load) } : {}),
    ...(directions.transcription && instance.transcription === undefined
      ? { transcription: lazyTranscriptionTransport(id, load) }
      : {}),
  };
}

type AudioBridge = {
  readonly directions: AudioDirections;
  readonly packageName: string;
  readonly loadOptions: Record<string, unknown>;
};

function audioBridge(config: Provider): AudioBridge | undefined {
  if (config.kind === ProviderKind.AiSdk) return aiSdkAudioBridge(config);
  if (config.kind === ProviderKind.Api) return apiAudioBridge(config);
  return undefined;
}

function aiSdkAudioBridge(config: AiSdkProvider): AudioBridge | undefined {
  const directions = AUDIO_BRIDGE_PACKAGES[config.packageName];
  if (directions === undefined) return undefined;
  return { directions, packageName: config.packageName, loadOptions: { ...config.options } };
}

function apiAudioBridge(config: ApiProvider): AudioBridge | undefined {
  const endpoint = apiProviderEndpoints(config).find((candidate) => candidate.protocol in AUDIO_BRIDGE_PROTOCOLS);
  if (endpoint === undefined) return undefined;
  const packageName = AUDIO_BRIDGE_PROTOCOLS[endpoint.protocol];
  const directions = packageName === undefined ? undefined : AUDIO_BRIDGE_PACKAGES[packageName];
  if (packageName === undefined || directions === undefined) return undefined;
  const apiKey = resolveApiKey(config.apiKey);
  return {
    directions,
    packageName,
    loadOptions: {
      ...(apiKey === undefined ? {} : { apiKey }),
      baseURL: endpoint.baseURL,
      ...(config.headers === undefined ? {} : { headers: config.headers }),
    },
  };
}

// Loading happens on first invoke, never at materialization: importing every
// configured provider's package at startup would make a slow or missing install
// a boot failure instead of a per-attempt candidate failure.
function lazySpeechTransport(providerId: string, load: () => Promise<unknown>): SpeechTransport {
  let invoke: SpeechTransport['invoke'] | undefined;
  return {
    async invoke(invocation, invokeOptions) {
      invoke ??= createProviderV4SpeechInvoke(
        providerId,
        await audioProvider(providerId, load, 'speechModel', providerV4SupportsSpeech),
      );
      return await invoke(invocation, invokeOptions);
    },
  };
}

function lazyTranscriptionTransport(providerId: string, load: () => Promise<unknown>): TranscriptionTransport {
  let invoke: TranscriptionTransport['invoke'] | undefined;
  return {
    async invoke(invocation, invokeOptions) {
      invoke ??= createProviderV4TranscribeInvoke(
        providerId,
        await audioProvider(providerId, load, 'transcriptionModel', providerV4SupportsTranscription),
      );
      return await invoke(invocation, invokeOptions);
    },
  };
}

/**
 * `AUDIO_BRIDGE_PACKAGES` gates on the package name, but the installed version
 * decides what the loaded provider actually implements, so the member is probed
 * again here. Naming the member in the message keeps a speech-only provider's
 * transcription failure distinguishable in the attempt log.
 */
async function audioProvider(
  providerId: string,
  load: () => Promise<unknown>,
  member: 'speechModel' | 'transcriptionModel',
  supports: (provider: AudioProviderV4) => boolean,
): Promise<AudioProviderV4> {
  const loaded = await load();
  if (!validateProviderV4(loaded) || !supports(loaded)) {
    throw new TypeError(`Provider ${providerId} cannot build a V4 ${member}`);
  }
  return loaded;
}
