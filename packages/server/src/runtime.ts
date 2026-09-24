import type {
  AiSdkProviderInstance,
  ApiProviderInstance,
  EmbeddingInvocation,
  EmbeddingResult,
  EvaluationInvocation,
  EvaluationResult,
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
  readonly urlTemplate?: string;
  readonly invoke: (
    request: Request,
    context?: LogicalRequestContext,
    options?: RawTransportOptions,
  ) => Promise<Response>;
};

export type RawResolveInput = {
  readonly protocol: ProviderProtocol;
  readonly modelId: string;
  readonly capability?: 'language' | 'embedding' | 'speech' | 'transcription' | 'evaluation';
  readonly requestPath?: string;
  readonly urlTemplate?: string;
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

export type EvaluationTransport = {
  readonly evaluate: (
    invocation: EvaluationInvocation,
    options: {
      readonly modelId: string;
      readonly signal?: AbortSignal;
    },
  ) => Promise<EvaluationResult>;
};

/**
 * The outcome of probing a lazily loaded package for an evaluation resolver.
 *
 * Three states, deliberately not a boolean. `unsupported` and `failed` mean
 * opposite things to the caller: the first is a routing fact (this candidate can
 * never serve evaluation convert), the second is a transient attempt failure that
 * must fall back to the next candidate rather than surface as a router miss.
 */
export type EvaluationDiscovery =
  | { readonly kind: 'supported'; readonly evaluate: EvaluationTransport['evaluate'] }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed'; readonly error: Error };

/**
 * An `EvaluationTransport` that also exposes the probe backing it.
 *
 * Declared here rather than beside the probe so the runtime type can name it
 * without importing back from `provider-runtime`, which would make the two
 * modules circular.
 */
export type LazyEvaluationTransport = EvaluationTransport & {
  readonly discover: () => Promise<EvaluationDiscovery>;
};

export type ModelTransport = {
  readonly ensureAvailable?: () => Promise<void>;
  readonly invoke: AiSdkProviderInstance['invoke'];
  readonly supportsProviderTool?: (type: ProviderExecutedTool['type']) => boolean;
  readonly targetProtocol?: (modelId: string) => ProviderProtocol | undefined;
};

export type InboundCapability =
  | 'language'
  | 'image'
  | 'embedding'
  | 'speech'
  | 'transcription'
  | 'video'
  | 'evaluation';
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
  readonly genAiProviderName?: string;
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
  /**
   * Evaluation convert. Deliberately NOT one of the `AtLeastOneRuntimeTransport`
   * arms: it is never sufficient on its own. An `ai-sdk` candidate always carries
   * `model` too, and an `api` candidate always carries `raw`, so admitting an
   * evaluation-only provider would only widen the type without a caller that
   * could dispatch it.
   *
   * Typed as the LAZY transport, not the bare one: presence here proves only that
   * the provider might evaluate, since the package behind it has not been loaded
   * yet. Callers must disprove a candidate by awaiting `discover()` rather than by
   * testing `evaluation !== undefined`, so `discover` has to stay reachable on the
   * materialized instance instead of being erased by a widened field type.
   */
  readonly evaluation?: LazyEvaluationTransport;
} & AtLeastOneRuntimeTransport;

export type RuntimeProviderInput = LegacyRuntimeProviderInstance | RuntimeProviderInstance;

export type PayloadCaptureHint = (
  request: Request,
  options: { readonly maxBytes: number },
) => Promise<'sensitive' | 'normal'>;

export type ProviderRouteSnapshot = {
  readonly payloadCaptureHints?: readonly PayloadCaptureHint[];
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
  readonly preObservationCapturePolicy?: (
    request: Request,
    snapshot: ProviderRouteSnapshot,
    maxBytes: number,
  ) => Promise<{ readonly capturePayload: boolean }>;
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
