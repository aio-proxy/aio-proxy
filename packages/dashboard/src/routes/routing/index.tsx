import { createFileRoute, stripSearchParams } from '@tanstack/react-router';

import { routingSearchSchema } from '@/modules/routing/lib/routing-search';
import { RoutingPage } from '@/modules/routing/templates/routing-page';

interface RoutingRouteProps extends Record<string, never> {}

const RoutingRoute: React.FC<RoutingRouteProps> = () => {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return <RoutingPage search={search} onSearchChange={(next) => void navigate({ search: next })} />;
};

export const Route = createFileRoute('/routing/')({
  validateSearch: routingSearchSchema,
  // `24h` is the default window, so it stays out of the URL.
  search: { middlewares: [stripSearchParams({ range: '24h' })] },
  component: RoutingRoute,
});
