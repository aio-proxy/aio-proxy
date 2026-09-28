import { m } from '@aio-proxy/i18n';
import { Badge } from '@aio-proxy/ui/components/badge';
import type React from 'react';

interface RoutingProviderOverrideTagsProps {
  readonly cost: boolean;
  readonly limit: boolean;
}

/** Which of a Provider's own prices and limits are set, in the primary tint every override mark uses. */
export const RoutingProviderOverrideTags: React.FC<RoutingProviderOverrideTagsProps> = ({ cost, limit }) => (
  <span className="ml-auto flex shrink-0 gap-1">
    {cost ? (
      <Badge variant="secondary" className="bg-primary/10 text-primary">
        {m['dashboard.routing.profile.provider_cost']()}
      </Badge>
    ) : null}
    {limit ? (
      <Badge variant="secondary" className="bg-primary/10 text-primary">
        {m['dashboard.routing.profile.provider_limit']()}
      </Badge>
    ) : null}
  </span>
);
