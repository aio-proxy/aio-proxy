import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel } from '@aio-proxy/types';
import type { UsageOverviewRange } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Empty } from '@aio-proxy/ui/components/empty';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@aio-proxy/ui/components/tabs';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type React from 'react';
import { useState } from 'react';

import { PageContainer } from '@/components/page-container';
import { ProviderCatalogProvider, useProviderCatalog } from '@/hooks/use-provider-catalog';

import { RoutingModelSummary } from '../../components/routing-model-summary';
import { RoutingRiskBadge } from '../../components/routing-risk-badge';
import { RoutingTrafficRefreshNotice } from '../../components/routing-traffic-refresh-notice';
import { useRoutingQuery } from '../../hooks/use-routing-query';
import { configuredRisks } from '../../lib/routing-risk';
import { indexRoutingTraffic, tierActualShares } from '../../lib/routing-traffic';
import { routingTrafficQueryOptions } from '../../services/routing-traffic-service';
import { RoutingModelPageEditor } from './routing-model-page-editor';

const usageRanges: readonly UsageOverviewRange[] = ['24h', '7d', '14d', '30d'];

interface RoutingModelPageProps {
  readonly modelId: string;
}

export const RoutingModelPage: React.FC<RoutingModelPageProps> = ({ modelId }) => {
  const query = useRoutingQuery();
  const providerCatalog = useProviderCatalog();
  const [range, setRange] = useState<UsageOverviewRange>('24h');
  const trafficQuery = useQuery(routingTrafficQueryOptions(range));
  const models = query.data?.models ?? [];
  const current = models.find((entry) => entry.modelId === modelId);
  // A refetch can drop this model (another operator removed the last Provider serving it). Swapping
  // to the empty state would unmount the editor with its drafts and navigation guard, so the last
  // snapshot stays up, read-only, until the user cancels or leaves.
  const [retained, setRetained] = useState(current);
  if (current !== undefined && current !== retained) setRetained(current);
  const model = current ?? (retained?.modelId === modelId ? retained : undefined);
  const removed = current === undefined && model !== undefined;
  const fullPageError = query.isError && query.data === undefined;
  const writable = query.data?.writable ?? false;
  const trafficIndex = trafficQuery.data === undefined ? undefined : indexRoutingTraffic(trafficQuery.data);
  const totals = trafficIndex?.get(modelId);
  const actual =
    model === undefined || totals === undefined
      ? undefined
      : model.tiers.flatMap((tier) => [...tierActualShares(tier, totals)]);
  // Split deviation is read off the list's route column; the header only flags a model nothing can serve.
  const risks = model === undefined ? [] : configuredRisks(model);

  const rangeLabels: Record<UsageOverviewRange, string> = {
    '24h': m['dashboard.usage.range_24h'](),
    '7d': m['dashboard.usage.range_7d'](),
    '14d': m['dashboard.usage.range_14d'](),
    '30d': m['dashboard.usage.range_30d'](),
  };

  const rangeSelector = (
    <Tabs value={range} onValueChange={(value) => setRange(value as UsageOverviewRange)} className="min-w-0">
      <div className="min-w-0 overflow-x-auto pb-1">
        <TabsList className="shrink-0" aria-label={m['dashboard.usage.range_label']()}>
          {usageRanges.map((entry) => (
            <TabsTrigger key={entry} value={entry}>
              {rangeLabels[entry]}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
    </Tabs>
  );

  const subtitle =
    model === undefined ? undefined : (
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {model.catalog?.lab !== undefined ? <span>{model.catalog.lab}</span> : null}
        {model.catalog?.releaseDate !== undefined ? <span>{model.catalog.releaseDate}</span> : null}
        {risks.map((risk) => (
          <RoutingRiskBadge key={risk} risk={risk} />
        ))}
      </div>
    );

  const onReload = async (): Promise<DashboardRoutingModel | undefined> => {
    const result = await query.refetch();
    // A failed refetch still resolves with the last successful payload, so returning it would look
    // like a reload that fetched nothing: the editor would clear the stale warning and the next save
    // would be rejected as stale all over again.
    if (result.isError) return undefined;
    return result.data?.models.find((entry) => entry.modelId === modelId);
  };

  const loadError = (
    <div className="space-y-3">
      <p role="alert" className="text-sm text-destructive">
        {m['dashboard.routing.load_failed']()}
      </p>
      <Button type="button" variant="outline" onClick={() => void query.refetch()}>
        {m['dashboard.routing.retry']()}
      </Button>
    </div>
  );

  const main = (() => {
    if (query.isLoading) {
      return (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      );
    }
    if (fullPageError) return loadError;
    if (model === undefined) {
      return (
        <Empty>
          <p className="font-mono text-sm">{modelId}</p>
          <Button nativeButton={false} render={<Link to="/routing/" />}>
            {m['dashboard.routing.title']()}
          </Button>
        </Empty>
      );
    }
    return (
      // Fills the page's height so the save bar, pushed to the end, rests on the viewport bottom even
      // when the page is shorter than the screen, as it does on longer pages.
      <div className="flex flex-1 flex-col gap-4">
        {query.isError ? loadError : null}
        {/* The summary and route rows keep the last traffic; a failed refresh behind them is said. */}
        {trafficQuery.isError && trafficQuery.data !== undefined ? (
          <RoutingTrafficRefreshNotice onRetry={() => void trafficQuery.refetch()} />
        ) : null}
        <RoutingModelSummary model={model} totals={totals} known={trafficIndex !== undefined} />
        <RoutingModelPageEditor
          key={model.modelId}
          model={model}
          writable={writable}
          removed={removed}
          range={range}
          actual={actual}
          onReload={onReload}
        />
      </div>
    );
  })();

  return (
    <PageContainer
      classNames={{ root: 'flex flex-col', main: 'flex w-full flex-1 flex-col' }}
      title={<span className="font-mono">{modelId}</span>}
      subtitle={subtitle}
      extra={model !== undefined && !query.isLoading && !fullPageError ? rangeSelector : undefined}
      breadcrumbs={[
        { label: m['dashboard.menus.configuration']() },
        { label: m['dashboard.routing.title'](), to: '/routing/' },
        { label: modelId },
      ]}
    >
      <ProviderCatalogProvider value={providerCatalog}>{main}</ProviderCatalogProvider>
    </PageContainer>
  );
};
