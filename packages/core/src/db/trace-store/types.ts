import type { LogicalSessionSource } from '@aio-proxy/plugin-sdk';
import type {
  DashboardOverviewRange,
  DashboardOverviewResponse,
  DashboardTraceDetail,
  DashboardTracePageSize,
  DashboardTracesResponse,
  DashboardUsageOverviewResponse,
  OtelSpanStatusCode,
  TraceTerminationReason,
  UsageOverviewGroupBy,
  UsageOverviewMetric,
  UsageOverviewRange,
  UsageRow,
} from '@aio-proxy/types';

import type { SpanAttributesJson, SpanEventJson, SpanLinkJson } from '../schema/trace-span';

export type StoredSpan = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly statusCode: number;
  readonly attributes: SpanAttributesJson;
  readonly events: readonly SpanEventJson[];
  readonly links: readonly SpanLinkJson[];
};

export type SessionIdentity = {
  readonly source: LogicalSessionSource;
  readonly id: string;
};

export type SessionResponseOwner = {
  readonly identity: SessionIdentity;
  readonly providerId: string;
};

export type SessionResponseResolution =
  | { readonly status: 'owned'; readonly owner: SessionResponseOwner }
  | { readonly status: 'ambiguous' };

export type SessionAffinityObservation = {
  readonly providerId: string;
  readonly revision: number;
  readonly active: boolean;
};

export type TraceRootStart = {
  readonly traceId: string;
  readonly spanId: string;
  readonly requestId: string;
  readonly inboundProtocol: string;
  readonly name: string;
  readonly kind: number;
  readonly startedAt: Date;
  readonly statusCode: number;
  readonly attributes: SpanAttributesJson;
  readonly events: readonly SpanEventJson[];
  readonly links: readonly SpanLinkJson[];
};

export type TraceTerminalSummary = {
  readonly finalProviderId?: string;
  readonly finalModelId?: string;
  readonly finalHttpStatus?: number;
  readonly terminationReason?: TraceTerminationReason;
  readonly errorType?: string;
  readonly errorCode?: string;
  readonly usage?: UsageRow;
};

export type TraceCompletion = {
  readonly traceId: string;
  readonly rootSpanId: string;
  readonly spans: readonly StoredSpan[];
  readonly summary: TraceTerminalSummary;
  readonly session?: {
    readonly identity: SessionIdentity;
    readonly requestedModelId: string;
    readonly resolvedBy: LogicalSessionSource;
  };
  readonly sessionState?: {
    readonly observedAffinity?: SessionAffinityObservation;
    readonly responseId?: string;
  };
};

export type TracesQuery = {
  readonly page: number;
  readonly pageSize: DashboardTracePageSize;
  readonly startedAfter?: Date;
  readonly startedBefore?: Date;
  readonly traceId?: string;
  readonly requestId?: string;
  readonly sessionSource?: string;
  readonly sessionId?: string;
  readonly otelStatusCode?: OtelSpanStatusCode;
  readonly terminationReason?: TraceTerminationReason;
  readonly inboundProtocol?: string;
  readonly requestedModelId?: string;
  readonly finalProviderId?: string;
  readonly finalModelId?: string;
  readonly finalHttpStatus?: number;
};

export type UsageOverviewQuery = {
  readonly range: UsageOverviewRange;
  readonly metric: UsageOverviewMetric;
  readonly groupBy: UsageOverviewGroupBy;
  readonly now?: Date;
};

export type DashboardOverviewQuery = {
  readonly range: DashboardOverviewRange;
  readonly year: number;
  readonly now?: Date;
};

export type TraceStore = {
  readonly startRoot: (input: TraceRootStart) => void;
  readonly complete: (input: TraceCompletion) => boolean;
  readonly list: (query: TracesQuery) => DashboardTracesResponse;
  readonly find: (traceId: string, now?: Date) => DashboardTraceDetail | undefined;
  readonly overview: (query: UsageOverviewQuery) => DashboardUsageOverviewResponse;
  readonly overviewDashboard: (query: DashboardOverviewQuery) => DashboardOverviewResponse;
  readonly resolveResponse: (responseId: string, now: Date) => SessionResponseResolution | undefined;
  readonly markResponseAmbiguous: (responseId: string, now: Date) => void;
  readonly findAffinity: (
    identity: SessionIdentity,
    requestedModelId: string,
    now: Date,
  ) => SessionAffinityObservation | undefined;
  readonly recover: (now: Date) => number;
  readonly prune: (traceCutoff: Date, sessionCutoff: Date) => void;
};
