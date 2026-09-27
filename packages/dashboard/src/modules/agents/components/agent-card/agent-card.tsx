import { m } from '@aio-proxy/i18n';
import type {
  AgentDescriptor,
  AgentInstallationSummary,
  AgentIntegrationKind,
  AgentLocalState,
} from '@aio-proxy/types';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon } from 'lucide-react';

import { AGENT_DISPLAY_NAMES, authorizationCounts } from '../../lib/agent-state';
import { AgentIcon } from '../agent-icon';
import { AgentStatusBadge } from '../agent-status-badge';

interface AgentCardProps {
  readonly descriptor: AgentDescriptor;
  readonly local: AgentLocalState | undefined;
  readonly installations: readonly AgentInstallationSummary[];
}

const VIA: Readonly<Record<AgentIntegrationKind, () => string>> = {
  plugin: () => m['dashboard.agents.card.via.plugin'](),
  'auth-command': () => m['dashboard.agents.card.via.auth_command'](),
  'static-config': () => m['dashboard.agents.card.via.static_config'](),
};

/** The whole card links to the Agent's details page inside aio-proxy; it never launches the Agent. */
export const AgentCard: React.FC<AgentCardProps> = ({ descriptor, local, installations }) => {
  const active = authorizationCounts(installations).active;
  return (
    <Link
      to="/agents/$target"
      params={{ target: descriptor.target }}
      className="group/agent-card block rounded-[min(var(--radius-4xl),24px)] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      data-testid={`agent-card-${descriptor.target}`}
    >
      <Card className="h-full transition-shadow group-hover/agent-card:shadow-md group-hover/agent-card:ring-foreground/15">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AgentIcon target={descriptor.target} className="shrink-0" />
            {AGENT_DISPLAY_NAMES[descriptor.target]}
          </CardTitle>
          <CardDescription>{VIA[descriptor.integrationKind]()}</CardDescription>
          <CardAction>
            <ChevronRightIcon
              aria-hidden
              className="size-4 text-muted-foreground transition-transform group-hover/agent-card:translate-x-0.5"
            />
          </CardAction>
        </CardHeader>
        <CardContent className="mt-auto flex flex-wrap items-center justify-between gap-2">
          {local === undefined ? <span /> : <AgentStatusBadge status={local.status} />}
          <span className="text-xs text-muted-foreground">
            {active === 0
              ? m['dashboard.agents.card.no_active_authorizations']()
              : m['dashboard.agents.card.active_authorizations']({ count: String(active) })}
          </span>
        </CardContent>
      </Card>
    </Link>
  );
};
