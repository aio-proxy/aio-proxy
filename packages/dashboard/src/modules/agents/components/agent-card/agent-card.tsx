import { m } from '@aio-proxy/i18n';
import type { AgentDescriptor, AgentInstallationSummary, AgentLocalState } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Link } from '@tanstack/react-router';

import { kindLabel } from '../../lib/agent-labels';
import { AGENT_DISPLAY_NAMES, authorizationCounts } from '../../lib/agent-state';
import { AgentStatusBadge } from '../agent-status-badge';

interface AgentCardProps {
  readonly descriptor: AgentDescriptor;
  readonly local: AgentLocalState | undefined;
  readonly installations: readonly AgentInstallationSummary[];
}

export const AgentCard: React.FC<AgentCardProps> = ({ descriptor, local, installations }) => {
  const name = AGENT_DISPLAY_NAMES[descriptor.target];
  const counts = authorizationCounts(installations);
  return (
    <Card data-testid={`agent-card-${descriptor.target}`}>
      <CardHeader>
        <CardTitle>{name}</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{kindLabel(descriptor.integrationKind)}</Badge>
          {local === undefined ? null : <AgentStatusBadge status={local.status} />}
        </CardDescription>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link to="/agents/$target" params={{ target: descriptor.target }} />}
            aria-label={m['dashboard.agents.open']({ target: name })}
          >
            {m['dashboard.agents.open']({ target: name })}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        {m['dashboard.agents.authorizations_summary']({
          active: String(counts.active),
          expired: String(counts.expired),
          revoked: String(counts.revoked),
        })}
      </CardContent>
    </Card>
  );
};
