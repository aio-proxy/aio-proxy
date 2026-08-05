import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

import { parseTraceSearch } from '@/modules/traces/lib/trace-search';
import { TracesPage } from '@/modules/traces/templates/traces-page';

interface TracesRouteProps extends Record<string, never> {}

const TracesRoute: React.FC<TracesRouteProps> = () => {
  const search = useSearch({ from: '/traces/' });
  const navigate = useNavigate({ from: '/traces/' });
  const canonicalized = useRef(false);

  useEffect(() => {
    if (canonicalized.current) return;
    canonicalized.current = true;
    void navigate({ search, replace: true });
  }, [navigate, search]);

  return (
    <TracesPage
      search={search}
      onSearchChange={(next) => void navigate({ search: next })}
      onTraceSelect={(traceId) => void navigate({ to: '/traces/$traceId', params: { traceId } })}
    />
  );
};

export const Route = createFileRoute('/traces/')({
  validateSearch: (raw) => parseTraceSearch(raw),
  component: TracesRoute,
});
