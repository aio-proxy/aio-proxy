import type { ProviderV4 } from '@ai-sdk/provider';
import type { ModelMetadataInput } from '@aio-proxy/types';
import type { LanguageModelCallOptions, ModelMessage, RequestOptions, ToolSet } from 'ai';

import type { JsonValue } from './json';

/**
 * Protocols a plugin may be asked about. `typesafe-systemone` is here so a raw
 * resolver can recognise an evaluation probe and DECLINE it; plugins do not
 * serve evaluation, and the host has no plugin evaluation transport and no
 * `ModelCatalog` bucket to route one through.
 */
export type ProtocolId =
  | 'openai-compatible'
  | 'openai-response'
  | 'anthropic'
  | 'gemini'
  | 'gemini-interactions'
  | 'openai-image'
  | 'openai-audio'
  | 'openai-video'
  | 'typesafe-systemone';

/** Non-deprecated replacement for the AI SDK `CallSettings` type. */
export type AiSdkCallSettings = LanguageModelCallOptions &
  Partial<Pick<RequestOptions, 'maxRetries' | 'abortSignal' | 'headers'>>;

export type ProviderExecutedTool = {
  readonly type: 'web-search';
  readonly name: string;
  readonly maxUses?: number;
  readonly allowedDomains?: readonly string[];
  readonly blockedDomains?: readonly string[];
};

export type ProviderToolCapability = {
  readonly supported: readonly ProviderExecutedTool['type'][];
};

export type LogicalSessionSource =
  | 'internal'
  | 'openai-conversation'
  | 'openai-prompt-cache'
  | 'claude-code'
  | 'anthropic-user'
  | 'body-session'
  | 'body-conversation'
  | 'header-session'
  | 'header-conversation'
  | 'previous-response'
  | 'transcript'
  | 'generated';

export type LogicalRequestContext = {
  readonly requestId: string;
  readonly session: {
    readonly key: `sha256:${string}`;
    readonly source: LogicalSessionSource;
  };
};

export type TokenCountInput = {
  readonly protocol: ProtocolId;
  readonly modelId: string;
  readonly request: Request;
  readonly context: LogicalRequestContext;
  readonly invocation: {
    readonly messages: readonly ModelMessage[];
    readonly settings?: AiSdkCallSettings;
    readonly tools?: ToolSet;
    readonly providerTools?: readonly ProviderExecutedTool[];
  };
};

export type TokenCountResult = { readonly inputTokens: number };

export type TokenCountCapability = {
  readonly countTokens: (input: TokenCountInput) => Promise<TokenCountResult>;
};

export type RawTransportOptions = { readonly upstreamStream: boolean };

export type RawTransport = {
  /** Authoritative low-cardinality template for the upstream request URL. */
  readonly urlTemplate?: string;
  readonly invoke: (
    request: Request,
    context?: LogicalRequestContext,
    options?: RawTransportOptions,
  ) => Promise<Response>;
};

export type RawResolver = (input: {
  readonly protocol: ProtocolId;
  readonly modelId: string;
  readonly extra?: JsonValue;
  // `'evaluation'` is listed so a resolver can recognise the probe and return
  // `undefined`, not so it can serve one: the host never routes evaluation to a
  // plugin. See `ProtocolId`.
  readonly capability?: 'language' | 'embedding' | 'speech' | 'transcription' | 'evaluation';
  // Inbound URL pathname when the pipeline is choosing between raw and model.
  // Absent for capability probes that are not tied to a request.
  readonly requestPath?: string;
  /** Low-cardinality client route template. Use only to derive an upstream template. */
  readonly urlTemplate?: string;
}) => RawTransport | undefined;

/**
 * Typed, host-consumed model metadata a plugin may report for a catalog model —
 * the descriptor-facing subset of the host's ModelMetadata authoring shape.
 * `extend` is a user-config concept and is excluded; the host strips unknown
 * keys and DROPS an invalid value fail-soft, keeping the rest of the
 * descriptor and catalog usable.
 *
 * Pick (not Omit): the schema is `.loose()`, so its type carries a string
 * index signature — Omit would collapse the named keys, Pick keeps them exact.
 */
export type DescriptorModelMetadata = Pick<
  ModelMetadataInput,
  'name' | 'description' | 'limit' | 'capabilities' | 'cost'
>;

export type ModelDescriptor = {
  readonly id: string;
  readonly displayName?: string;
  /** Plugin-private free-form data (e.g. wire protocol hints); opaque to users. */
  readonly extra?: JsonValue;
  /** Typed model metadata merged into the host's upstream metadata layer. */
  readonly modelMetadata?: DescriptorModelMetadata;
};

export type ModelCatalog = {
  readonly language: readonly ModelDescriptor[];
  readonly image: readonly ModelDescriptor[];
  /** Video models served through the openai-video raw transport. Optional for older plugins. */
  readonly video?: readonly ModelDescriptor[];
  readonly embedding: readonly ModelDescriptor[];
  readonly speech: readonly ModelDescriptor[];
  readonly transcription: readonly ModelDescriptor[];
  readonly reranking: readonly ModelDescriptor[];
  /** Catalog-level plugin-private free-form data. */
  readonly extra?: JsonValue;
};

export type RealtimeStyle = 'live' | 'realtime-calls' | 'realtime-query' | 'realtime-direct';

export type RealtimeDialInput = {
  readonly style: RealtimeStyle;
  readonly callId?: string;
  readonly model?: string;
  /** Inbound headers the plugin may forward selectively. Caller credentials are
   *  already stripped by the auth middleware; the plugin adds its own upstream
   *  auth and never forwards an inbound `authorization`. */
  readonly headers: Headers;
  readonly signal: AbortSignal;
};

export type RealtimeDialErrorKind = 'rejected' | 'unreachable' | 'aborted' | 'timeout';

const REALTIME_DIAL_ERROR_BRAND = Symbol.for('@aio-proxy/plugin-sdk/realtime-dial-error/v1');

/** A client `WebSocket` exposes no upstream HTTP status for a non-101 response,
 *  so a failed dial is only ever discriminable to these four kinds. */
export class RealtimeDialError extends Error {
  override readonly name = 'RealtimeDialError';
  /** Registry symbol, so the brand is shared across module instances — see
   *  `isRealtimeDialError`. */
  readonly [REALTIME_DIAL_ERROR_BRAND] = true;

  constructor(
    message: string,
    readonly options: { readonly kind: RealtimeDialErrorKind },
  ) {
    super(message);
  }

  get kind(): RealtimeDialErrorKind {
    return this.options.kind;
  }
}

/** A plugin resolved from its own npm cache loads a separate copy of this module, so the
 *  `RealtimeDialError` it throws is a different constructor and fails a host-side
 *  `instanceof`. The host would then read every dial failure as `rejected`: a `timeout` or
 *  `unreachable` becomes a 502 instead of a 503, and an `aborted` dial keeps trying other
 *  providers instead of answering 499. Brand check rather than constructor identity. */
export function isRealtimeDialError(value: unknown): value is RealtimeDialError {
  return value instanceof Error && REALTIME_DIAL_ERROR_BRAND in value;
}

export type RealtimeTransport = {
  readonly models: readonly string[];
  readonly fetch: (request: Request) => Promise<Response>;
  /** Resolves only once the socket is OPEN. Rejects with a `RealtimeDialError`.
   *  Aborting `signal` abandons a pending dial and closes any socket that opens. */
  readonly dial: (input: RealtimeDialInput) => Promise<WebSocket>;
};

export type OAuthRuntimeResult = {
  /** Stable, non-empty, low-cardinality OpenTelemetry GenAI provider identity.
   *  Omit it when the runtime does not know the upstream service identity. */
  readonly genAiProviderName?: string;
  readonly provider: ProviderV4;
  readonly raw?: RawResolver;
  readonly tokenCount?: TokenCountCapability;
  readonly providerTools?: ProviderToolCapability;
  readonly realtime?: RealtimeTransport;
};
