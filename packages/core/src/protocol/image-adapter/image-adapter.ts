import type { AliasDimensions } from '@aio-proxy/types';

import type { AiSdkCallSettings } from '../../ai-sdk-bridge';
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

export type ImageInvocation = {
  readonly operation: 'generate' | 'edit';
  readonly prompt: string;
  readonly n: number;
  readonly size?: `${number}x${number}`;
  readonly responseFormat: 'b64_json';
  readonly images?: readonly ImageBytesRef[];
  readonly mask?: ImageBytesRef;
  readonly providerOptions?: AiSdkCallSettings['providerOptions'];
};

export type ImageTransportResult = {
  readonly images: readonly Uint8Array[];
  readonly usage?: Readonly<Record<string, unknown>>;
  readonly created?: number;
};

export type ImageProtocolAdapter<TRequest, TContext> = SharedProtocolAdapter<TRequest, TContext> &
  Readonly<{
    capability: 'image';
    imageInvocation: (request: TRequest, context: TContext) => ImageInvocation;
    imageJson: (result: ImageTransportResult, context: ModelEgressContext) => Promise<unknown>;
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
