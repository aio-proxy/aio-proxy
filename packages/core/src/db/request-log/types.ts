import type {
  DashboardRequestLogsPageSize,
  DashboardRequestLogsResponse,
  RequestOutcome,
  UsageOverviewGroupBy,
  UsageOverviewMetric,
  UsageOverviewRange,
  UsageRow,
} from '@aio-proxy/types';

import type { requestLog } from '../schema/request-log';

export type RequestLogInsert = typeof requestLog.$inferInsert;

type RequestLogFinalBase = Omit<RequestLogInsert, 'outcome'>;

export type RequestLogFinal =
  | (RequestLogFinalBase & { readonly outcome: 'success'; readonly usage?: undefined })
  | (RequestLogFinalBase & {
      readonly outcome: 'success';
      readonly finalProviderId: string;
      readonly finalModelId: string;
      readonly usage: UsageRow;
    })
  | (RequestLogFinalBase & { readonly outcome: 'failure' | 'cancelled'; readonly usage?: never });

export type UsageOverviewQuery = {
  readonly range: UsageOverviewRange;
  readonly metric: UsageOverviewMetric;
  readonly groupBy: UsageOverviewGroupBy;
  readonly now?: Date;
};

export type LegacyUsageOverviewResponse = {
  readonly range: UsageOverviewRange;
  readonly metric: UsageOverviewMetric;
  readonly groupBy: UsageOverviewGroupBy;
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly bucketUnit: 'hour' | 'day';
  readonly summary: {
    readonly estimatedCostUsd: number;
    readonly pricingCoverage: number | null;
    readonly pricedRequestCount: number;
    readonly usageRequestCount: number;
    readonly requestCount: number;
    readonly successCount: number;
    readonly failureCount: number;
    readonly cancelledCount: number;
    readonly successRate: number | null;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly averageRpm: number;
    readonly averageTpm: number;
  };
  readonly series: readonly {
    readonly key: string;
    readonly kind: 'dimension' | 'other' | 'failed' | 'cancelled';
  }[];
  readonly buckets: readonly {
    readonly key: string;
    readonly values: Readonly<Record<string, number>>;
  }[];
};

export type RequestLogsQuery = {
  readonly page: number;
  readonly pageSize: DashboardRequestLogsPageSize;
  readonly startedAfter?: Date;
  readonly completedBefore?: Date;
  readonly requestId?: string;
  readonly outcome?: RequestOutcome;
  readonly inboundProtocol?: string;
  readonly requestedModelId?: string;
  readonly finalProviderId?: string;
  readonly finalModelId?: string;
  readonly finalStatusCode?: number;
};

export type RequestLogStore = {
  readonly insertFinal: (input: RequestLogFinal) => void;
  readonly list: (query: RequestLogsQuery) => DashboardRequestLogsResponse;
  readonly overview: (query: UsageOverviewQuery) => LegacyUsageOverviewResponse;
  readonly prune: (cutoff: Date) => void;
};
