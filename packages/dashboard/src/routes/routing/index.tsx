import { createFileRoute, stripSearchParams } from '@tanstack/react-router';

import { routingSearchSchema } from '@/modules/routing/lib/routing-search';
import { RoutingPage } from '@/modules/routing/templates/routing-page';

export const Route = createFileRoute('/routing/')({
  validateSearch: routingSearchSchema,
  // `24h` is the default window, so it stays out of the URL.
  search: { middlewares: [stripSearchParams({ range: '24h' })] },
  component: RoutingPage,
});
