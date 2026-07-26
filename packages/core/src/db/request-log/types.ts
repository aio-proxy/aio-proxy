import type {
  DashboardRequestLogsPageSize,
  DashboardRequestLogsResponse,
  DashboardUsageOverviewResponse,
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
  readonly overview: (query: UsageOverviewQuery) => DashboardUsageOverviewResponse;
  readonly prune: (cutoff: Date) => void;
};
