import type { AliasDimensions } from '@aio-proxy/types';

import type {
  LanguageProtocolAdapter,
  ModelEgressContext,
  ProtocolRequestDiagnostic,
  SharedProtocolAdapter,
} from '../adapter';
import { REQUEST_BODY_LIMITS, type RequestBodyLimits } from '../request';

export type ImageBytesRef = {
  readonly type: 'bytes';
  readonly mediaType: string;
  readonly data: Uint8Array;
  readonly byteLength: number;
  readonly format: 'png' | 'jpeg' | 'webp';
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
};

// generateImage accepts ProviderOptions; AiSdkCallSettings has no providerOptions field.
export type ImageProviderOptions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export type ImageInvocation = {
  readonly operation: 'generate' | 'edit';
  readonly prompt: string;
  readonly n: number;
  readonly size?: `${number}x${number}`;
  readonly responseFormat: 'b64_json';
  readonly images?: readonly ImageBytesRef[];
  readonly mask?: ImageBytesRef;
  readonly providerOptions?: ImageProviderOptions;
};

export type ImageTransportResult = {
  readonly images: readonly Uint8Array[];
  readonly usage?: Readonly<Record<string, unknown>>;
  readonly created?: number;
};

export function officialImageUsage(
  usage: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (usage === undefined) return undefined;
  const inputTokens = numberField(usage, 'input_tokens') ?? numberField(usage, 'inputTokens');
  const outputTokens = numberField(usage, 'output_tokens') ?? numberField(usage, 'outputTokens');
  const totalTokens = numberField(usage, 'total_tokens') ?? numberField(usage, 'totalTokens');
  const details = officialInputTokenDetails(usage['input_tokens_details'] ?? usage['inputTokensDetails']);
  const official = {
    ...(inputTokens === undefined ? {} : { input_tokens: inputTokens }),
    ...(outputTokens === undefined ? {} : { output_tokens: outputTokens }),
    ...(totalTokens === undefined ? {} : { total_tokens: totalTokens }),
    ...(details === undefined ? {} : { input_tokens_details: details }),
  };
  return Object.keys(official).length === 0 ? undefined : official;
}

function officialInputTokenDetails(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const textTokens = numberField(record, 'text_tokens') ?? numberField(record, 'textTokens');
  const imageTokens = numberField(record, 'image_tokens') ?? numberField(record, 'imageTokens');
  const details = {
    ...(textTokens === undefined ? {} : { text_tokens: textTokens }),
    ...(imageTokens === undefined ? {} : { image_tokens: imageTokens }),
  };
  return Object.keys(details).length === 0 ? undefined : details;
}

function numberField(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

export type ImageProtocolAdapter<TRequest, TContext> = SharedProtocolAdapter<TRequest, TContext> &
  Readonly<{
    capability: 'image';
    imageInvocation: (request: TRequest, context: TContext) => ImageInvocation;
    imageJson: (result: ImageTransportResult, context: ModelEgressContext) => Promise<unknown>;
    convertSkipReason?: (request: TRequest, resolvedModelId: string) => string | undefined;
  }>;

export type InboundProtocolAdapter<TRequest, TContext> =
  | LanguageProtocolAdapter<TRequest, TContext>
  | ImageProtocolAdapter<TRequest, TContext>;

export type ImageProtocolAdapterDefinition<TRequest, TContext> = Omit<
  ImageProtocolAdapter<TRequest, TContext>,
  'capability' | 'bodyLimits' | 'requestDiagnostics' | 'dimensions'
> & {
  readonly bodyLimits?: ImageProtocolAdapter<TRequest, TContext>['bodyLimits'];
  readonly dimensions?: ImageProtocolAdapter<TRequest, TContext>['dimensions'];
  readonly requestDiagnostics?: ImageProtocolAdapter<TRequest, TContext>['requestDiagnostics'];
};

const noDimensions = (): AliasDimensions => ({});
const noRequestDiagnostics = (): readonly ProtocolRequestDiagnostic[] => [];
const defaultBodyLimits = (): RequestBodyLimits => REQUEST_BODY_LIMITS;

export function defineImageProtocolAdapter<TRequest, TContext>(
  definition: ImageProtocolAdapterDefinition<TRequest, TContext>,
): ImageProtocolAdapter<TRequest, TContext> {
  return Object.freeze({
    ...definition,
    capability: 'image',
    bodyLimits: definition.bodyLimits ?? defaultBodyLimits,
    dimensions: definition.dimensions ?? noDimensions,
    requestDiagnostics: definition.requestDiagnostics ?? noRequestDiagnostics,
  });
}
