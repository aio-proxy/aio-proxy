import type { ProviderV4 } from '@ai-sdk/provider';

import { generateSpeech, transcribe } from '../../ai-sdk-bridge';
import { AiSdkProviderError } from '../../error';
import type {
  SpeechInvocation,
  SpeechResultData,
  TranscriptionInvocation,
  TranscriptionResultData,
} from '../../protocol/audio-adapter';

export type AudioInvokeOptions = {
  readonly modelId: string;
  readonly signal?: AbortSignal;
};

type SpeechCall = Parameters<typeof generateSpeech>[0];
type TranscribeCall = Parameters<typeof transcribe>[0];
type TranscriptionModel = ReturnType<NonNullable<ProviderV4['transcriptionModel']>>;

/**
 * `audio/mp3` is what the AI SDK falls back to when it cannot sniff the returned
 * bytes, and it is not a registered media type — speech egress writes this value
 * straight into the `content-type` response header, where a client that
 * content-sniffs sees an unknown type. Normalize to the IANA name once here
 * instead of at every egress site.
 */
const MP3_ALIASES: Readonly<Record<string, string>> = { 'audio/mp3': 'audio/mpeg', 'audio/x-mp3': 'audio/mpeg' };

// `speechModel` and `transcriptionModel` are OPTIONAL ProviderV4 members:
// @ai-sdk/openai implements both, @ai-sdk/openai-compatible implements neither.
// Probe before dispatch so an unsupported provider fails the candidate instead
// of throwing an opaque TypeError from inside the AI SDK.
export function providerV4SupportsSpeech(provider: ProviderV4): boolean {
  return typeof provider.speechModel === 'function';
}

export function providerV4SupportsTranscription(provider: ProviderV4): boolean {
  return typeof provider.transcriptionModel === 'function';
}

export function createProviderV4SpeechInvoke(
  providerId: string,
  provider: ProviderV4,
): (invocation: SpeechInvocation, options: AudioInvokeOptions) => Promise<SpeechResultData> {
  return async (invocation, options) => {
    if (!providerV4SupportsSpeech(provider)) {
      throw new TypeError(`Provider '${providerId}' does not support speech generation`);
    }
    try {
      const result = await generateSpeech({
        model: provider.speechModel!(options.modelId),
        text: invocation.text,
        ...(invocation.voice === undefined ? {} : { voice: invocation.voice }),
        ...(invocation.outputFormat === undefined ? {} : { outputFormat: invocation.outputFormat }),
        ...(invocation.instructions === undefined ? {} : { instructions: invocation.instructions }),
        ...(invocation.speed === undefined ? {} : { speed: invocation.speed }),
        ...(invocation.language === undefined ? {} : { language: invocation.language }),
        ...(invocation.providerOptions === undefined
          ? {}
          : { providerOptions: invocation.providerOptions as SpeechCall['providerOptions'] }),
        ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
      });
      return { audio: result.audio.uint8Array, mediaType: audioMediaType(result.audio.mediaType) };
    } catch (error) {
      throw new AiSdkProviderError(providerId, error);
    }
  };
}

export function createProviderV4TranscribeInvoke(
  providerId: string,
  provider: ProviderV4,
): (invocation: TranscriptionInvocation, options: AudioInvokeOptions) => Promise<TranscriptionResultData> {
  return async (invocation, options) => {
    if (!providerV4SupportsTranscription(provider)) {
      throw new TypeError(`Provider '${providerId}' does not support transcription`);
    }
    try {
      const model = provider.transcriptionModel!(options.modelId);
      const providerOptions = transcriptionProviderOptions(model.provider, invocation);
      const declared = specificAudioMediaType(invocation.mediaType);
      const result = await transcribe({
        model: declared === undefined ? model : withMediaType(model, declared),
        audio: invocation.audio,
        ...(providerOptions === undefined
          ? {}
          : { providerOptions: providerOptions as TranscribeCall['providerOptions'] }),
        ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
      });
      return {
        text: result.text,
        // `TranscriptionResultData.segments` is non-optional, but a provider
        // answering a non-verbose format reports no segments at all.
        segments: result.segments ?? [],
        ...(result.language === undefined ? {} : { language: result.language }),
        ...(result.durationInSeconds === undefined ? {} : { durationInSeconds: result.durationInSeconds }),
      };
    } catch (error) {
      throw new AiSdkProviderError(providerId, error);
    }
  };
}

/**
 * `transcribe()` has no provider-agnostic parameter for `language`, `prompt`,
 * `temperature`, or `timestampGranularities`: the only channel is `providerOptions`,
 * keyed by provider name. The protocol layer cannot pick that key — it does not know
 * which candidate will serve the request — so the key is derived here from the model's
 * own `provider` string, taking the segment before the first `.`.
 *
 * Verified against the installed SDKs: @ai-sdk/openai's transcription model reports
 * `provider: 'openai.transcription'` but parses its options under `'openai'`, and
 * @ai-sdk/groq reports `'groq'` and parses under `'groq'`, accepting the same option
 * names. So the first segment is the options key for both. Values are not validated
 * here: the SDK's own `parseProviderOptions` does that, and its failure is already
 * wrapped as `AiSdkProviderError`.
 */
function transcriptionProviderOptions(
  modelProvider: string,
  invocation: TranscriptionInvocation,
): Record<string, Record<string, unknown>> | undefined {
  const derived: Record<string, unknown> = {
    ...(invocation.language === undefined ? {} : { language: invocation.language }),
    ...(invocation.prompt === undefined ? {} : { prompt: invocation.prompt }),
    ...(invocation.temperature === undefined ? {} : { temperature: invocation.temperature }),
    ...(invocation.timestampGranularities === undefined
      ? {}
      : { timestampGranularities: invocation.timestampGranularities }),
  };
  const caller = invocation.providerOptions;
  if (Object.keys(derived).length === 0) return caller === undefined ? undefined : { ...caller };
  const key = modelProvider.split('.')[0] ?? modelProvider;
  // Caller-supplied options win: that channel is explicitly authored, so it is the
  // more specific intent for the same key.
  return { ...caller, [key]: { ...derived, ...caller?.[key] } };
}

/**
 * Non-`audio/*` labels that still name a container OpenAI accepts for
 * transcription. MP4 and WebM are audio/video dual-purpose containers, and a
 * client uploading an `.mp4` or `.webm` recording routinely declares the video
 * type — @ai-sdk/openai derives the upload filename from the subtype, so these
 * arrive as `audio.mp4` / `audio.webm`, which are supported. Sniffing cannot
 * recover either: MP4's `ftyp` box sits at offset 4, past where the SDK looks.
 */
const SUPPORTED_CONTAINER_MEDIA_TYPES: ReadonlySet<string> = new Set(['video/mp4', 'video/webm']);

/**
 * A multipart part carries whatever `Content-Type` the client's HTTP library chose,
 * and a great many of them label every file upload `application/octet-stream`. That
 * is not information about the audio — overriding the SDK's byte sniffing with it
 * makes @ai-sdk/openai derive the filename `audio.octet-stream`, which OpenAI
 * rejects as an unsupported format even for a perfectly ordinary MP3. A specific
 * `audio/*` type, or one of the dual-purpose containers above, is better
 * information than sniffing; anything else falls through so the SDK looks at the
 * bytes.
 */
function specificAudioMediaType(mediaType: string | undefined): string | undefined {
  if (mediaType === undefined) return undefined;
  const normalized = mediaType.toLowerCase();
  if (SUPPORTED_CONTAINER_MEDIA_TYPES.has(normalized)) return normalized;
  return normalized.startsWith('audio/') && normalized !== 'audio/*' ? normalized : undefined;
}

/**
 * `transcribe()` takes no media type: it re-derives one by sniffing the audio
 * bytes and falls back to `audio/wav`. Its audio `ftyp` signature sits at offset
 * 0 while a real MP4/M4A container puts it at offset 4, so an m4a upload sniffs
 * as nothing and reaches upstream labelled `audio/wav` — and @ai-sdk/openai
 * turns the media type into the upload's filename extension, so OpenAI sees a
 * `.wav` that is not a WAV. A specific `audio/*` type from the client is better
 * information, so override it at the model boundary. Wrapping the model rather
 * than calling `doGenerate` directly keeps `transcribe()`'s retries, warning
 * logging, and empty-transcript guard on both paths.
 */
function withMediaType(model: TranscriptionModel, mediaType: string): TranscriptionModel {
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    doGenerate: (callOptions) => model.doGenerate({ ...callOptions, mediaType }),
  };
}

function audioMediaType(mediaType: string): string {
  return MP3_ALIASES[mediaType.toLowerCase()] ?? mediaType;
}
