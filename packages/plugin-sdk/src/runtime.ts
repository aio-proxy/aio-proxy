import type { ProviderV4 } from '@ai-sdk/provider';
import type { ModelMetadataInput } from '@aio-proxy/types';
import type { LanguageModelCallOptions, ModelMessage, RequestOptions, ToolSet } from 'ai';

import type { JsonValue } from './json';

export type ProtocolId =
  | 'openai-compatible'
  | 'openai-response'
  | 'anthropic'
  | 'gemini'
  | 'gemini-interactions'
  | 'openai-image';

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
  readonly capability?: 'language' | 'embedding';
  // Inbound URL pathname when the pipeline is choosing between raw and model.
  // Absent for capability probes that are not tied to a request.
  readonly requestPath?: string;
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
  readonly embedding: readonly ModelDescriptor[];
  readonly speech: readonly ModelDescriptor[];
  readonly transcription: readonly ModelDescriptor[];
  readonly reranking: readonly ModelDescriptor[];
  /** Catalog-level plugin-private free-form data. */
  readonly extra?: JsonValue;
};

export type OAuthRuntimeResult = {
  readonly provider: ProviderV4;
  readonly raw?: RawResolver;
  readonly tokenCount?: TokenCountCapability;
  readonly providerTools?: ProviderToolCapability;
};
