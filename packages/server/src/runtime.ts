import type { AiSdkProviderInstance, ApiProviderInstance, PluginRegistrySnapshot, Router } from '@aio-proxy/core';
import type { LogicalRequestContext, ProviderExecutedTool, TokenCountCapability } from '@aio-proxy/plugin-sdk';
import type {
  AliasConfig,
  Config,
  ModelId,
  ModelMetadata,
  ProviderKind,
  ProviderProtocol,
  ProviderState,
} from '@aio-proxy/types';

import type { LogicalSessionStore } from './logical-session-store';
import type { RequestTraceRecorder } from './request-tracing';
import type { ProviderCooldownStore } from './routes/pipeline/provider-cooldown';
import type { ServerLogSink } from './server-log';
import type { UsageCapture } from './usage-capture';

export type RuntimeModelMetadata = ModelMetadata & {
  readonly protocol?: ProviderProtocol;
};

export type RawTransportOptions = { readonly upstreamStream: boolean };

export type RawTransport = {
  readonly invoke: (
    request: Request,
    context?: LogicalRequestContext,
    options?: RawTransportOptions,
  ) => Promise<Response>;
};

export type RuntimeRawCapability = {
  readonly resolve: (input: {
    readonly protocol: ProviderProtocol;
    readonly modelId: string;
  }) => RawTransport | undefined;
};

export type ModelTransport = {
  readonly ensureAvailable?: () => Promise<void>;
  readonly invoke: AiSdkProviderInstance['invoke'];
  readonly supportsProviderTool?: (type: ProviderExecutedTool['type']) => boolean;
  readonly targetProtocol?: (modelId: string) => ProviderProtocol | undefined;
};

export type LegacyRuntimeProviderInstance = ApiProviderInstance | AiSdkProviderInstance;
type RuntimeProviderBase = {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly enabled: boolean;
  readonly priority?: number;
  readonly weight?: number;
  readonly models?: readonly ModelId[];
  readonly alias?: Readonly<Record<string, AliasConfig>>;
  readonly configMetadata?: Readonly<Record<ModelId, ModelMetadata>>;
  readonly upstreamMetadata?: Readonly<Record<ModelId, RuntimeModelMetadata>>;
  readonly plugin?: string;
  readonly capability?: string;
  readonly hasApiKey?: boolean;
  readonly tokenCount?: TokenCountCapability;
};
export type RuntimeProviderInstance = RuntimeProviderBase &
  (
    | { readonly raw: RuntimeRawCapability; readonly model?: ModelTransport }
    | { readonly raw?: RuntimeRawCapability; readonly model: ModelTransport }
  );
export type RuntimeProviderInput = LegacyRuntimeProviderInstance | RuntimeProviderInstance;

export type ProviderRouteSnapshot = {
  readonly config?: Config;
  readonly plugins: PluginRegistrySnapshot;
  readonly providers: readonly RuntimeProviderInstance[];
  readonly router: Router<RuntimeProviderInstance>;
  readonly providerStates?: ReadonlyMap<string, ProviderState>;
};

export type ProviderSnapshotLease = {
  readonly snapshot: ProviderRouteSnapshot;
  readonly release: () => void;
};

export type RetiredProviderSnapshot = {
  readonly providerIds: ReadonlySet<string>;
  readonly whenDrained: Promise<void>;
  readonly whenProviderDrained: (providerId: string) => Promise<void>;
};

export type ProviderRouteSource = {
  readonly acquireProviderSnapshot: () => ProviderSnapshotLease;
  readonly cooldown: ProviderCooldownStore;
  readonly currentProviderSnapshot: () => ProviderRouteSnapshot;
  readonly debugLogging?: boolean;
  readonly logger: ServerLogSink;
  readonly logicalSessionStore: LogicalSessionStore;
  readonly requestRecorder: RequestTraceRecorder;
  readonly usageCapture: UsageCapture;
};
