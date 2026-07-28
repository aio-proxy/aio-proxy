import { createFileRoute, useParams } from '@tanstack/react-router';

import { TraceDetailPage } from '@/modules/traces/templates/trace-detail-page';

const TraceDetailRoute: React.FC = () => {
  const { traceId } = useParams({ from: '/traces/$traceId' });
  return <TraceDetailPage traceId={traceId} />;
};

export const Route = createFileRoute('/traces/$traceId')({ component: TraceDetailRoute });
