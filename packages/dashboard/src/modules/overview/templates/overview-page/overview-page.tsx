import { m } from '@aio-proxy/i18n';
import type { DashboardOverviewRange, UsageOverviewMetric } from '@aio-proxy/types';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aio-proxy/ui/components/empty';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { Activity, ServerOff } from 'lucide-react';
import { useState } from 'react';

import { PageContainer } from '@/components/page-container';

import { ModelUsageTrend } from '../../components/model-usage-trend';
import { OverviewKpiGrid } from '../../components/overview-kpi-grid';
import { OverviewTimeWindow } from '../../components/overview-time-window';
import { ProviderHealthTable } from '../../components/provider-health-table';
import { RequestActivityHeatmap } from '../../components/request-activity-heatmap';
import { TopModelCosts } from '../../components/top-model-costs';
import { useOverviewQuery } from '../../hooks/use-overview-query';

const loadingKpis = ['requests', 'tokens', 'cache', 'cost', 'rpm', 'tpm'] as const;

export const OverviewPage: React.FC = () => {
  const [range, setRange] = useState<DashboardOverviewRange>('24h');
  const [year, setYear] = useState(new Date().getFullYear());
  const [metric, setMetric] = useState<UsageOverviewMetric>('requests');
  const overview = useOverviewQuery({ range, year });
  let content: React.ReactNode;

  if (overview.isLoading) {
    content = (
      <>
        <span className="sr-only" role="status">
          {m['dashboard.overview.loading']()}
        </span>
        <div className="overview-kpi-grid gap-3">
          {loadingKpis.map((id) => (
            <Skeleton key={id} className="h-24 rounded-4xl" />
          ))}
        </div>
        <Skeleton className="h-80 rounded-4xl" />
        <div className="overview-lower-grid gap-3">
          <Skeleton className="h-72 rounded-4xl" />
          <Skeleton className="h-72 rounded-4xl" />
        </div>
        <Skeleton className="h-64 rounded-4xl" />
      </>
    );
  } else if (overview.isError || overview.data === undefined) {
    content = (
      <Empty className="min-h-80 bg-card">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Activity />
          </EmptyMedia>
          <EmptyTitle>{m['dashboard.overview.error_title']()}</EmptyTitle>
          <EmptyDescription>{m['dashboard.overview.error_description']()}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (overview.data.summary.providerCount === 0) {
    content = (
      <Empty className="min-h-80 bg-card">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ServerOff />
          </EmptyMedia>
          <EmptyTitle>{m['dashboard.overview.no_providers_title']()}</EmptyTitle>
          <EmptyDescription>{m['dashboard.overview.no_providers_description']()}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else {
    const isActivityPending = overview.isFetching && overview.data.activity.year !== year;
    content = (
      <>
        {overview.data.summary.requestCount === 0n ? (
          <Empty className="min-h-72 bg-card">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Activity />
              </EmptyMedia>
              <EmptyTitle>{m['dashboard.overview.no_requests_title']()}</EmptyTitle>
              <EmptyDescription>{m['dashboard.overview.no_requests_description']()}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <OverviewKpiGrid summary={overview.data.summary} />
            <ModelUsageTrend
              metric={metric}
              range={overview.data.range}
              trend={overview.data.modelTrendByMetric[metric]}
              onMetricChange={setMetric}
            />
          </>
        )}
        <div className="overview-lower-grid gap-3">
          <ProviderHealthTable rows={overview.data.providerHealth} />
          <TopModelCosts models={overview.data.topModelCosts} />
        </div>
        {isActivityPending ? (
          <div role="status">
            <span className="sr-only">{m['dashboard.overview.loading']()}</span>
            <Skeleton className="h-64 rounded-4xl" />
          </div>
        ) : (
          <RequestActivityHeatmap activity={overview.data.activity} onYearChange={setYear} />
        )}
      </>
    );
  }

  return (
    <PageContainer
      title={m['dashboard.menus.dashboard']()}
      breadcrumbs={[{ label: m['dashboard.menus.observability']() }, { label: m['dashboard.menus.dashboard']() }]}
      extra={
        <OverviewTimeWindow
          isFetching={overview.isFetching}
          range={range}
          onRangeChange={setRange}
          onRefresh={() => void overview.refetch()}
        />
      }
    >
      <div className="grid gap-3">{content}</div>
    </PageContainer>
  );
};
