import type { AliasDimensions } from '@aio-proxy/types';

import type { ProtocolRequestDiagnostic, SharedProtocolAdapter } from '../adapter';
import { REQUEST_BODY_LIMITS, type RequestBodyLimits } from '../request';

export type VideoProtocolAdapter<TRequest, TContext> = SharedProtocolAdapter<TRequest, TContext> &
  Readonly<{
    capability: 'video';
    convertSkipReason?: (request: TRequest, resolvedModelId: string) => string | undefined;
  }>;

export type VideoProtocolAdapterDefinition<TRequest, TContext> = Omit<
  VideoProtocolAdapter<TRequest, TContext>,
  'capability' | 'bodyLimits' | 'requestDiagnostics' | 'dimensions'
> & {
  readonly bodyLimits?: VideoProtocolAdapter<TRequest, TContext>['bodyLimits'];
  readonly dimensions?: VideoProtocolAdapter<TRequest, TContext>['dimensions'];
  readonly requestDiagnostics?: VideoProtocolAdapter<TRequest, TContext>['requestDiagnostics'];
};

const noDimensions = (): AliasDimensions => ({});
const noRequestDiagnostics = (): readonly ProtocolRequestDiagnostic[] => [];
const defaultBodyLimits = (): RequestBodyLimits => REQUEST_BODY_LIMITS;

export function defineVideoProtocolAdapter<TRequest, TContext>(
  definition: VideoProtocolAdapterDefinition<TRequest, TContext>,
): VideoProtocolAdapter<TRequest, TContext> {
  return Object.freeze({
    ...definition,
    capability: 'video',
    bodyLimits: definition.bodyLimits ?? defaultBodyLimits,
    dimensions: definition.dimensions ?? noDimensions,
    requestDiagnostics: definition.requestDiagnostics ?? noRequestDiagnostics,
    convertSkipReason: definition.convertSkipReason ?? (() => 'video_convert'),
  });
}

export function isVideoProtocolAdapter(adapter: {
  readonly capability?: string;
}): adapter is VideoProtocolAdapter<never, never> {
  return adapter.capability === 'video';
}
