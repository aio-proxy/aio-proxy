import { m } from '@aio-proxy/i18n';
import type { DashboardOverviewRange, UsageOverviewMetric } from '@aio-proxy/types';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aio-proxy/ui/components/empty';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { Activity, ServerOff } from 'lucide-react';
import { useState } from 'react';

import { PageContainer } from '@/components/page-container';

import { ModelUsageTrend } from '../../components/model-usage-trend';
import { OverviewKpiGrid } from '../../components/overview-kpi-grid';
import { getOverviewRangeLabel, OverviewTimeWindow } from '../../components/overview-time-window';
import { ProviderHealthTable } from '../../components/provider-health-table';
import { TokenActivityHeatmap } from '../../components/token-activity-heatmap';
import { TopModelCosts } from '../../components/top-model-costs';
import {
  useOverviewActivityQuery,
  useOverviewDiagnosticsQuery,
  useOverviewQuery,
} from '../../hooks/use-overview-query';

const loadingKpis = ['requests', 'tokens', 'cache', 'cost', 'rpm', 'tpm'] as const;

export const OverviewPage: React.FC = () => {
  const [range, setRange] = useState<DashboardOverviewRange>('24h');
  const [metric, setMetric] = useState<UsageOverviewMetric>('requests');
  const overview = useOverviewQuery({ range });
  const diagnostics = useOverviewDiagnosticsQuery({ range });
  const activity = useOverviewActivityQuery();
  let content: React.ReactNode;

  if (
    overview.isLoading ||
    overview.isPlaceholderData ||
    diagnostics.isLoading ||
    diagnostics.isPlaceholderData ||
    activity.isLoading
  ) {
    content = (
      <>
        <span className="sr-only" role="status">
          {m['dashboard.overview.loading']()}
        </span>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {loadingKpis.map((id) => (
            <Skeleton key={id} className="h-24 rounded-4xl" />
          ))}
        </div>
        <Skeleton className="h-80 rounded-4xl" />
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Skeleton className="h-72 rounded-4xl" />
          <Skeleton className="h-72 rounded-4xl" />
        </div>
        <Skeleton className="h-64 rounded-4xl" />
      </>
    );
  } else if (
    overview.isError ||
    diagnostics.isError ||
    activity.isError ||
    overview.data === undefined ||
    diagnostics.data === undefined ||
    activity.data === undefined
  ) {
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
    content = (
      <>
        {overview.data.summary.current.requestCount === 0n ? (
          <Empty className="min-h-72 bg-card">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Activity />
              </EmptyMedia>
              <EmptyTitle>
                {m['dashboard.overview.no_requests_title']({ range: getOverviewRangeLabel(overview.data.range) })}
              </EmptyTitle>
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
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <ProviderHealthTable rows={diagnostics.data.providerHealth} />
          <TopModelCosts models={diagnostics.data.topModelCosts} />
        </div>
        <TokenActivityHeatmap activity={activity.data} />
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
          onRefresh={() => void Promise.all([overview.refetch(), diagnostics.refetch(), activity.refetch()])}
        />
      }
    >
      <div className="grid gap-3">{content}</div>
    </PageContainer>
  );
};
