import type { AgentLocalStatus } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';

import { statusLabel } from '../../lib/agent-labels';

interface AgentStatusBadgeProps {
  readonly status: AgentLocalStatus | undefined;
}

const variantOf = (status: AgentLocalStatus | undefined) => {
  if (status === 'configured') return 'secondary' as const;
  if (status === 'conflict' || status === 'recovery_required') return 'destructive' as const;
  return 'outline' as const;
};

export const AgentStatusBadge: React.FC<AgentStatusBadgeProps> = ({ status }) => (
  <Badge variant={variantOf(status)}>{statusLabel(status)}</Badge>
);
