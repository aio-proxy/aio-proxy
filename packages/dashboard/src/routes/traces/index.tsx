import { createFileRoute, stripSearchParams } from '@tanstack/react-router';

import { resolveTraceSearch, toTraceUrlSearch, traceSearchSchema } from '@/modules/traces/lib/trace-search';
import { TracesPage } from '@/modules/traces/templates/traces-page';

interface TracesRouteProps extends Record<string, never> {}

const TracesRoute: React.FC<TracesRouteProps> = () => {
  const search = resolveTraceSearch(Route.useSearch());
  const navigate = Route.useNavigate();

  return (
    <TracesPage
      search={search}
      onSearchChange={(next) => void navigate({ search: () => toTraceUrlSearch(next) })}
      onTraceSelect={(traceId) => void navigate({ to: '/traces/$traceId', params: { traceId } })}
    />
  );
};

export const Route = createFileRoute('/traces/')({
  validateSearch: traceSearchSchema,
  search: {
    middlewares: [stripSearchParams({ pageSize: 50 })],
  },
  component: TracesRoute,
});
