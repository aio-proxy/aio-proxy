import { createFileRoute } from '@tanstack/react-router';

import { RoutingModelPage } from '@/modules/routing/templates/routing-model-page';

const RoutingModelRoute: React.FC = () => {
  // A model id can contain slashes, so this is a splat route: `_splat` carries every
  // remaining segment joined, which is exactly the id.
  const { _splat } = Route.useParams();
  return <RoutingModelPage modelId={_splat ?? ''} />;
};

export const Route = createFileRoute('/routing/$')({ component: RoutingModelRoute });
