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
      const result = await transcribe({
        model: invocation.mediaType === undefined ? model : withMediaType(model, invocation.mediaType),
        audio: invocation.audio,
        ...(invocation.providerOptions === undefined
          ? {}
          : { providerOptions: invocation.providerOptions as TranscribeCall['providerOptions'] }),
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
 * `transcribe()` takes no media type: it re-derives one by sniffing the audio
 * bytes and falls back to `audio/wav`. Its audio `ftyp` signature sits at offset
 * 0 while a real MP4/M4A container puts it at offset 4, so an m4a upload sniffs
 * as nothing and reaches upstream labelled `audio/wav` — and @ai-sdk/openai
 * turns the media type into the upload's filename extension, so OpenAI sees a
 * `.wav` that is not a WAV. The client's own `Content-Type` is better
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
