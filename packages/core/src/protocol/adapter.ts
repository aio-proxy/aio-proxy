import type { ProviderExecutedTool } from '@aio-proxy/plugin-sdk';
import type { AliasDimensions, ProviderProtocol } from '@aio-proxy/types';

import type { AiSdkCallSettings, ModelMessage, TextStreamPart, ToolSet } from '../ai-sdk-bridge';
import type { ProtocolSessionHints } from './session';

export type EmptyProtocolContext = Readonly<Record<never, never>>;
export type ModelEventStream = ReadableStream<TextStreamPart<ToolSet>>;
export type ModelSseStream = ReadableStream<Uint8Array> & { readonly completion: Promise<void> };

export type ProtocolErrorMapper = Readonly<{
  requestError: (error: unknown) => Response | undefined;
  modelUnsupported?: (error: unknown) => Response | undefined;
  modelNotFound: (message: string) => Response;
  previousResponseConflict: () => Response;
  tooLarge: () => Response;
  unsupportedContentEncoding: () => Response;
  unsupported: (feature: string) => Response;
  provider: (error: unknown) => Response | undefined;
  rateLimited: (retryAfterSeconds: number) => Response;
}>;

export type ModelInvocation = {
  readonly messages: readonly ModelMessage[];
  readonly settings?: AiSdkCallSettings;
  readonly tools?: ToolSet;
  readonly providerTools?: readonly ProviderExecutedTool[];
};

export type ModelEgressContext = {
  readonly modelId: string;
  readonly onResponseId?: (responseId: string) => void;
};

export type ProtocolRequestDiagnostic = Readonly<{
  feature: 'background';
  action: 'dropped';
  effectiveMode: 'synchronous';
}>;

export type ProtocolAdapter<TRequest, TContext> = Readonly<{
  protocol: ProviderProtocol;
  parse: (raw: Request, context: TContext) => Promise<TRequest>;
  model: (request: TRequest, context: TContext) => string;
  dimensions: (request: TRequest, context: TContext) => AliasDimensions;
  requestDiagnostics: (request: TRequest, context: TContext) => readonly ProtocolRequestDiagnostic[];
  session?: (request: TRequest, context: TContext) => ProtocolSessionHints;
  wantsStream: (request: TRequest, context: TContext) => boolean;
  rawRequest: (
    raw: Request,
    request: TRequest,
    resolvedModel: string,
    supportedEfforts: ReadonlySet<string>,
    context: TContext,
  ) => Promise<Request>;
  modelInvocation: (request: TRequest, context: TContext) => ModelInvocation;
  modelInvocationForTarget: (
    invocation: ModelInvocation,
    targetProtocol: ProviderProtocol | undefined,
    supportedEfforts: ReadonlySet<string>,
  ) => ModelInvocation;
  modelJson: (stream: ModelEventStream, context: ModelEgressContext) => Promise<unknown>;
  modelSse: (stream: ModelEventStream, context: ModelEgressContext) => ModelSseStream;
  errors: ProtocolErrorMapper;
}>;

export type ProtocolAdapterDefinition<TRequest, TContext> = Omit<
  ProtocolAdapter<TRequest, TContext>,
  'modelInvocationForTarget' | 'requestDiagnostics' | 'dimensions'
> & {
  readonly modelInvocationForTarget?: ProtocolAdapter<TRequest, TContext>['modelInvocationForTarget'];
  readonly dimensions?: ProtocolAdapter<TRequest, TContext>['dimensions'];
  readonly requestDiagnostics?: ProtocolAdapter<TRequest, TContext>['requestDiagnostics'];
};

const noDimensions = (): AliasDimensions => ({});
const noRequestDiagnostics = (): readonly ProtocolRequestDiagnostic[] => [];
const sameModelInvocation = (invocation: ModelInvocation): ModelInvocation => invocation;

export function defineProtocolAdapter<TRequest, TContext>(
  definition: ProtocolAdapterDefinition<TRequest, TContext>,
): ProtocolAdapter<TRequest, TContext> {
  return Object.freeze({
    ...definition,
    modelInvocationForTarget: definition.modelInvocationForTarget ?? sameModelInvocation,
    dimensions: definition.dimensions ?? noDimensions,
    requestDiagnostics: definition.requestDiagnostics ?? noRequestDiagnostics,
  });
}

export type EmbeddingProviderOptions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export type EmbeddingValue = {
  readonly value: string;
  readonly providerOptions?: EmbeddingProviderOptions;
};

export type EmbeddingInvocation = {
  readonly values: readonly EmbeddingValue[];
  readonly encodingFormat?: 'float' | 'base64';
};

export type EmbeddingResult = {
  readonly embeddings: readonly (readonly number[])[];
  readonly usage?: { readonly tokens?: number };
};

export type EmbeddingProtocolAdapter<TRequest, TContext> = Readonly<{
  capability: 'embedding';
  protocol: ProviderProtocol;
  parse: (raw: Request, context: TContext) => Promise<TRequest>;
  model: (request: TRequest, context: TContext) => string;
  dimensions: (request: TRequest, context: TContext) => AliasDimensions;
  requestDiagnostics: (request: TRequest, context: TContext) => readonly ProtocolRequestDiagnostic[];
  wantsStream: (request: TRequest, context: TContext) => boolean;
  rawRequest: (raw: Request, request: TRequest, resolvedModel: string, context: TContext) => Promise<Request>;
  embeddingInvocation: (request: TRequest, context: TContext) => EmbeddingInvocation;
  embeddingJson: (result: EmbeddingResult, context: { readonly modelId: string }) => unknown;
  errors: ProtocolErrorMapper;
}>;

export function defineEmbeddingProtocolAdapter<TRequest, TContext>(
  definition: Omit<
    EmbeddingProtocolAdapter<TRequest, TContext>,
    'dimensions' | 'requestDiagnostics' | 'wantsStream'
  > & {
    readonly dimensions?: EmbeddingProtocolAdapter<TRequest, TContext>['dimensions'];
    readonly requestDiagnostics?: EmbeddingProtocolAdapter<TRequest, TContext>['requestDiagnostics'];
    readonly wantsStream?: EmbeddingProtocolAdapter<TRequest, TContext>['wantsStream'];
  },
): EmbeddingProtocolAdapter<TRequest, TContext> {
  return Object.freeze({
    ...definition,
    dimensions: definition.dimensions ?? noDimensions,
    requestDiagnostics: definition.requestDiagnostics ?? noRequestDiagnostics,
    wantsStream: definition.wantsStream ?? (() => false),
  });
}
