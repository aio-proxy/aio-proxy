import type { AliasDimensions } from '@aio-proxy/types';

import type { ProtocolRequestDiagnostic, SharedProtocolAdapter } from '../adapter';
import { REQUEST_BODY_LIMITS, type RequestBodyLimits } from '../request';

export type AudioCapability = 'speech' | 'transcription';

export type AudioProviderOptions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export type SpeechInvocation = {
  readonly text: string;
  readonly voice?: string;
  readonly outputFormat?: string;
  readonly instructions?: string;
  readonly speed?: number;
  readonly language?: string;
  readonly providerOptions?: AudioProviderOptions;
};

export type TranscriptionInvocation = {
  readonly audio: Uint8Array;
  readonly mediaType?: string;
  readonly providerOptions?: AudioProviderOptions;
};

export type AudioInvocation =
  | { readonly kind: 'speech'; readonly speech: SpeechInvocation }
  | { readonly kind: 'transcription'; readonly transcription: TranscriptionInvocation };

export type SpeechResultData = {
  readonly audio: Uint8Array;
  readonly mediaType: string;
};

export type TranscriptionSegment = {
  readonly text: string;
  readonly startSecond: number;
  readonly endSecond: number;
};

export type TranscriptionResultData = {
  readonly text: string;
  readonly segments: readonly TranscriptionSegment[];
  readonly language?: string;
  readonly durationInSeconds?: number;
};

export type AudioResult =
  | { readonly kind: 'speech'; readonly speech: SpeechResultData }
  | { readonly kind: 'transcription'; readonly transcription: TranscriptionResultData };

export type AudioEgressContext = {
  readonly modelId: string;
};

/**
 * Audio egress returns a Response, not a JSON value: speech answers with audio
 * bytes and a media type, and transcription answers with JSON *or* bare
 * `text` / `srt` / `vtt`. Neither fits the JSON-only image and embedding egress
 * contracts, so audio owns its own.
 */
export type AudioProtocolAdapter<TRequest, TContext> = SharedProtocolAdapter<TRequest, TContext> &
  Readonly<{
    capability: AudioCapability;
    audioInvocation: (request: TRequest, context: TContext) => AudioInvocation;
    audioResponse: (result: AudioResult, request: TRequest, context: AudioEgressContext) => Promise<Response>;
    convertSkipReason?: (request: TRequest, resolvedModelId: string, context: TContext) => string | undefined;
  }>;

export type AudioProtocolAdapterDefinition<TRequest, TContext> = Omit<
  AudioProtocolAdapter<TRequest, TContext>,
  'bodyLimits' | 'dimensions' | 'requestDiagnostics' | 'wantsStream'
> & {
  readonly bodyLimits?: AudioProtocolAdapter<TRequest, TContext>['bodyLimits'];
  readonly dimensions?: AudioProtocolAdapter<TRequest, TContext>['dimensions'];
  readonly requestDiagnostics?: AudioProtocolAdapter<TRequest, TContext>['requestDiagnostics'];
  readonly wantsStream?: AudioProtocolAdapter<TRequest, TContext>['wantsStream'];
};

const noDimensions = (): AliasDimensions => ({});
const noRequestDiagnostics = (): readonly ProtocolRequestDiagnostic[] => [];
const defaultBodyLimits = (): RequestBodyLimits => REQUEST_BODY_LIMITS;

export function defineAudioProtocolAdapter<TRequest, TContext>(
  definition: AudioProtocolAdapterDefinition<TRequest, TContext>,
): AudioProtocolAdapter<TRequest, TContext> {
  return Object.freeze({
    ...definition,
    bodyLimits: definition.bodyLimits ?? defaultBodyLimits,
    dimensions: definition.dimensions ?? noDimensions,
    requestDiagnostics: definition.requestDiagnostics ?? noRequestDiagnostics,
    // Transcription streaming is signalled by `stream_format`, never by a
    // `stream` boolean, and no reference implementation supports it. Audio never
    // opts into the streaming pipeline on the convert path.
    wantsStream: definition.wantsStream ?? (() => false),
  });
}

export function isAudioProtocolAdapter(adapter: {
  readonly capability?: string;
}): adapter is AudioProtocolAdapter<never, never> {
  return adapter.capability === 'speech' || adapter.capability === 'transcription';
}
