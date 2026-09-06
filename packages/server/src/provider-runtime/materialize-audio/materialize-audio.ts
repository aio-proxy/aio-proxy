import {
  createProviderV4SpeechInvoke,
  createProviderV4TranscribeInvoke,
  loadAiSdkProvider,
  type ProviderFetch,
  providerV4SupportsSpeech,
  providerV4SupportsTranscription,
  validateProviderV4,
} from '@aio-proxy/core';
import type { Provider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';

import type { RuntimeProviderInstance, SpeechTransport, TranscriptionTransport } from '../../runtime';

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
 *
 * Unlike images, no protocol has to be mapped to a package here, because API
 * providers are never bridged to audio (see `attachAudioTransports`).
 */
const AUDIO_BRIDGE_PACKAGES: Readonly<
  Record<string, { readonly speech: boolean; readonly transcription: boolean } | undefined>
> = {
  '@ai-sdk/openai': { speech: true, transcription: true },
  '@ai-sdk/xai': { speech: true, transcription: true },
  '@ai-sdk/google': { speech: true, transcription: false },
  '@ai-sdk/groq': { speech: false, transcription: true },
};

type LoadProvider = typeof loadAiSdkProvider;
// The ProviderV4 structural type, reached through core rather than a direct
// @ai-sdk/provider import: that package is only a devDependency here.
type AudioProviderV4 = Parameters<typeof createProviderV4SpeechInvoke>[1];

/**
 * Attaches speech and transcription transports to an `ai-sdk` provider whose
 * package implements them, so the audio convert path has something to call.
 *
 * API providers are deliberately skipped: an `openai-audio` endpoint already
 * matches `raw.resolve` for an inbound audio request, and a provider without one
 * has no audio surface at all, so a bridged transport could only fail per
 * attempt.
 *
 * The capability index cannot gate this the way it gates images: a bridged
 * @ai-sdk/openai provider reports the OpenAI Responses target protocol, which
 * grants language and embedding only. `candidateSupportsAudio` reads the attached
 * transport for the same reason.
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
  const { config } = options;
  if (config.kind !== ProviderKind.AiSdk) return instance;
  const directions = AUDIO_BRIDGE_PACKAGES[config.packageName];
  if (directions === undefined) return instance;
  const load = () =>
    (options.loadProvider ?? loadAiSdkProvider)(config.packageName, {
      ...config.options,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  return {
    ...instance,
    ...(directions.speech && instance.speech === undefined ? { speech: lazySpeechTransport(config.id, load) } : {}),
    ...(directions.transcription && instance.transcription === undefined
      ? { transcription: lazyTranscriptionTransport(config.id, load) }
      : {}),
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
