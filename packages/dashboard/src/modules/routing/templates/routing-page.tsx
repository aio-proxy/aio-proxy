import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent } from '@aio-proxy/ui/components/card';
import { Empty } from '@aio-proxy/ui/components/empty';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { PageContainer } from '@/components/page-container';

import { RoutingHealthStrip } from '../components/routing-health-strip';
import { RoutingLabFilter } from '../components/routing-lab-filter';
import { RoutingTable } from '../components/routing-table';
import { useRoutingQuery } from '../hooks/use-routing-query';
import { countRoutingRisks } from '../lib/routing-risk';
import { filterRoutingModels, sortRoutingModels } from '../lib/routing-rows';
import { toggleRoutingRisk, type RoutingSearch, withRoutingFilters } from '../lib/routing-search';
import { indexRoutingTraffic } from '../lib/routing-traffic';
import { routingTrafficQueryOptions } from '../services/routing-traffic-service';

interface RoutingPageProps {
  readonly search: RoutingSearch;
  readonly onSearchChange: (next: RoutingSearch) => void;
}

export const RoutingPage: React.FC<RoutingPageProps> = ({ search, onSearchChange }) => {
  const query = useRoutingQuery();
  const trafficQuery = useQuery(routingTrafficQueryOptions(search.range));
  const models = query.data?.models ?? [];
  const index = trafficQuery.data === undefined ? undefined : indexRoutingTraffic(trafficQuery.data);
  const visible = filterRoutingModels(sortRoutingModels(models), search, index);

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
    if (query.isError) {
      return (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-destructive">
            {m['dashboard.routing.load_failed']()}
          </p>
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            {m['dashboard.routing.retry']()}
          </Button>
        </div>
      );
    }
    if (models.length === 0) {
      return (
        <Empty>
          <p>{m['dashboard.routing.empty']()}</p>
          <Button render={<Link to="/providers" />}>{m['dashboard.routing.empty_action']()}</Button>
        </Empty>
      );
    }
    return (
      <div className="space-y-4">
        <RoutingLabFilter
          models={models}
          value={search.lab}
          onChange={(lab) => onSearchChange(withRoutingFilters(search, { lab }))}
        />
        <RoutingTable models={visible} traffic={index} />
      </div>
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
      {query.data !== undefined && models.length > 0 ? (
        <RoutingHealthStrip
          total={models.length}
          counts={countRoutingRisks(models, index)}
          active={search.risk}
          onToggle={(risk) => onSearchChange(toggleRoutingRisk(search, risk))}
        />
      ) : null}
      <Card>
        <CardContent>{content}</CardContent>
      </Card>
    </PageContainer>
  );
};
