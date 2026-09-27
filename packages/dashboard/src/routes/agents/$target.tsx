import { m } from '@aio-proxy/i18n';
import { AgentTargetSchema } from '@aio-proxy/types';
import { createFileRoute, useParams } from '@tanstack/react-router';

import { AgentDetailPage } from '@/modules/agents/templates/agent-detail-page';

interface AgentDetailRouteProps extends Record<string, never> {}

const AgentDetailRoute: React.FC<AgentDetailRouteProps> = () => {
  const { target } = useParams({ from: '/agents/$target' });
  const parsed = AgentTargetSchema.safeParse(target);
  if (!parsed.success)
    return (
      <p role="alert" className="p-8 text-sm text-destructive">
        {m['dashboard.agents.not_found']()}
      </p>
    );
  return <AgentDetailPage key={parsed.data} target={parsed.data} />;
};

export const Route = createFileRoute('/agents/$target')({ component: AgentDetailRoute });
