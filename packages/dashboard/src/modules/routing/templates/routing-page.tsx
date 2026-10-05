import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent } from '@aio-proxy/ui/components/card';
import { Empty } from '@aio-proxy/ui/components/empty';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { PageContainer } from '@/components/page-container';
import { ProviderCatalogProvider, useProviderCatalog } from '@/hooks/use-provider-catalog';

import { RoutingLabFilter } from '../components/routing-lab-filter';
import { RoutingSelectionPolicy } from '../components/routing-selection-policy';
import { RoutingTable } from '../components/routing-table';
import { RoutingTrafficRefreshNotice } from '../components/routing-traffic-refresh-notice';
import { useRoutingQuery } from '../hooks/use-routing-query';
import { filterRoutingModels, sortRoutingModels } from '../lib/routing-rows';
import { type RoutingSearch, withRoutingFilters } from '../lib/routing-search';
import { indexRoutingTraffic } from '../lib/routing-traffic';
import { routingTrafficQueryOptions } from '../services/routing-traffic-service';

interface RoutingPageProps {
  readonly search: RoutingSearch;
  readonly onSearchChange: (next: RoutingSearch) => void;
}

export const RoutingPage: React.FC<RoutingPageProps> = ({ search, onSearchChange }) => {
  const query = useRoutingQuery();
  const providerCatalog = useProviderCatalog();
  const trafficQuery = useQuery(routingTrafficQueryOptions(search.range));
  const models = query.data?.models ?? [];
  const index = trafficQuery.data === undefined ? undefined : indexRoutingTraffic(trafficQuery.data);
  const visible = filterRoutingModels(sortRoutingModels(models), search);

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

  const content = (() => {
    if (query.isLoading) {
      return (
        <div className="space-y-2" aria-label={m['dashboard.routing.title']()}>
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      );
    }
    // A failed refetch keeps the last inventory, so only a query that never loaded replaces the list;
    // otherwise the cached models stay up under the same notice and retry.
    if (query.isError && query.data === undefined) return loadError;
    if (models.length === 0) {
      return (
        <Empty>
          <p>{m['dashboard.routing.empty']()}</p>
          <Button render={<Link to="/providers" />}>{m['dashboard.routing.empty_action']()}</Button>
        </Empty>
      );
    }
    if (visible.length === 0) {
      return (
        <Empty>
          <p>{m['dashboard.routing.table.empty_filtered']()}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => onSearchChange(withRoutingFilters(search, { lab: undefined }))}
          >
            {m['dashboard.routing.table.clear_filters']()}
          </Button>
        </Empty>
      );
    }
    return (
      <RoutingTable
        models={visible}
        vendorModels={models}
        traffic={index}
        selection={query.data?.selection}
        lab={search.lab}
        onLabChange={(lab) => onSearchChange(withRoutingFilters(search, { lab }))}
      />
    );
  })();

  return (
    <PageContainer
      title={m['dashboard.routing.title']()}
      subtitle={m['dashboard.routing.subtitle']()}
      breadcrumbs={[{ label: m['dashboard.menus.configuration']() }, { label: m['dashboard.routing.title']() }]}
    >
      {query.data?.writable === false ? (
        <p role="status" className="mb-3 rounded-lg border bg-muted p-3 text-sm">
          {m['dashboard.routing.read_only']()}
        </p>
      ) : null}
      <Card>
        <CardContent className="space-y-4">
          {/* Keyed by the server value so a change saved elsewhere resets the switch's form state. */}
          {query.data === undefined ? null : (
            <RoutingSelectionPolicy
              key={query.data.selection}
              selection={query.data.selection}
              writable={query.data.writable}
            />
          )}
          {/* Outside `content` on purpose: a filter that matches nothing must still be adjustable,
              otherwise the only way out of an empty result is to clear every filter. */}
          {query.data !== undefined && models.length > 0 && visible.length === 0 ? (
            <RoutingLabFilter
              models={models}
              value={search.lab}
              onChange={(lab) => onSearchChange(withRoutingFilters(search, { lab }))}
            />
          ) : null}
          {query.isError && query.data !== undefined ? loadError : null}
          {/* Cached traffic, drift and success rates stay up after a failed refresh, but say they are stale. */}
          {trafficQuery.isError && trafficQuery.data !== undefined ? (
            <RoutingTrafficRefreshNotice onRetry={() => void trafficQuery.refetch()} />
          ) : null}
          <ProviderCatalogProvider value={providerCatalog}>{content}</ProviderCatalogProvider>
        </CardContent>
      </Card>
    </PageContainer>
  );
};
