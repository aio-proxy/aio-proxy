import type {
  AiSdkProviderInstance,
  ApiProviderInstance,
  EmbeddingInvocation,
  EmbeddingResult,
  ImageInvocation,
  ImageTransportResult,
  PluginRegistrySnapshot,
  Router,
  SpeechInvocation,
  SpeechResultData,
  TranscriptionInvocation,
  TranscriptionResultData,
} from '@aio-proxy/core';
import type {
  LogicalRequestContext,
  ProviderExecutedTool,
  RealtimeTransport,
  TokenCountCapability,
} from '@aio-proxy/plugin-sdk';
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

export type RawResolveInput = {
  readonly protocol: ProviderProtocol;
  readonly modelId: string;
  readonly capability?: 'language' | 'embedding' | 'speech' | 'transcription';
  readonly requestPath?: string;
};

export type RuntimeRawCapability = {
  readonly resolve: (input: RawResolveInput) => RawTransport | undefined;
};

export type EmbeddingTransport = {
  readonly embed: (
    invocation: EmbeddingInvocation,
    options: {
      readonly modelId: string;
      readonly signal?: AbortSignal;
      readonly logicalRequest: LogicalRequestContext;
    },
  ) => Promise<EmbeddingResult>;
};

export type ModelTransport = {
  readonly ensureAvailable?: () => Promise<void>;
  readonly invoke: AiSdkProviderInstance['invoke'];
  readonly supportsProviderTool?: (type: ProviderExecutedTool['type']) => boolean;
  readonly targetProtocol?: (modelId: string) => ProviderProtocol | undefined;
};

export type InboundCapability = 'language' | 'image' | 'embedding' | 'speech' | 'transcription' | 'video';
export type ModelCapabilityIndex = Readonly<Record<string, ReadonlySet<InboundCapability>>>;

export type ImageTransportInvokeRequest = {
  readonly modelId: string;
  readonly invocation: ImageInvocation;
  readonly signal?: AbortSignal;
};

export type ImageTransport = {
  readonly ensureAvailable?: () => Promise<void>;
  readonly invoke: (request: ImageTransportInvokeRequest) => Promise<ImageTransportResult>;
};

export type AudioTransportInvokeOptions = {
  readonly modelId: string;
  readonly signal?: AbortSignal;
  readonly logicalRequest: LogicalRequestContext;
};

export type SpeechTransport = {
  readonly ensureAvailable?: (modelId: string) => Promise<void>;
  readonly invoke: (invocation: SpeechInvocation, options: AudioTransportInvokeOptions) => Promise<SpeechResultData>;
};

export type TranscriptionTransport = {
  readonly ensureAvailable?: (modelId: string) => Promise<void>;
  readonly invoke: (
    invocation: TranscriptionInvocation,
    options: AudioTransportInvokeOptions,
  ) => Promise<TranscriptionResultData>;
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
  readonly upstreamMetadata?: Readonly<Record<ModelId, RuntimeModelMetadata>>;
  readonly plugin?: string;
  readonly capability?: string;
  readonly hasApiKey?: boolean;
  readonly tokenCount?: TokenCountCapability;
  /** Stable account fingerprint. A realtime call pins it so a re-login under the
   *  same Provider ID cannot silently move the call to another account. */
  readonly accountId?: string;
  /** Bumped by every credential write. Token refresh alone does not move it. */
  readonly runtimeRevision?: number;
  readonly realtime?: RealtimeTransport;
};
/**
 * Every transport a materialized runtime provider can expose. A provider must
 * carry at least one; dispatch selects among them by inbound capability, never
 * by provider kind.
 */
type RuntimeTransports = {
  readonly raw: RuntimeRawCapability;
  readonly model: ModelTransport;
  readonly image: ImageTransport;
  readonly embedding: EmbeddingTransport;
  readonly speech: SpeechTransport;
  readonly transcription: TranscriptionTransport;
};

// One union arm per transport, each requiring its own and leaving the rest
// optional. Derived rather than hand-written: six arms times six keys is 36
// lines that must stay in lockstep, and the count grows quadratically with
// every capability added.
type AtLeastOneRuntimeTransport = {
  [K in keyof RuntimeTransports]: Required<Pick<RuntimeTransports, K>> & Partial<Omit<RuntimeTransports, K>>;
}[keyof RuntimeTransports];

export type RuntimeProviderInstance = RuntimeProviderBase & {
  readonly capabilityIndex: ModelCapabilityIndex;
} & AtLeastOneRuntimeTransport;

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
  /** Optional: fire-and-forget OAuth quota refresh after a provider answers a request. */
  readonly warmProviderQuota?: (providerId: string) => void;
};
