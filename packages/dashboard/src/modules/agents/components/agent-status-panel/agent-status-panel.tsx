import { m } from '@aio-proxy/i18n';
import type { AgentLocalState } from '@aio-proxy/types';

import { statusHint } from '../../lib/agent-labels';
import { AGENT_DISPLAY_NAMES } from '../../lib/agent-state';
import { AgentStatusBadge } from '../agent-status-badge';

interface AgentStatusPanelProps {
  readonly local: AgentLocalState;
}

export const AgentStatusPanel: React.FC<AgentStatusPanelProps> = ({ local }) => {
  const hint = statusHint(local.status, AGENT_DISPLAY_NAMES[local.target]);
  const rows: ReadonlyArray<readonly [string, string | undefined]> = [
    [m['dashboard.agents.field.version'](), local.host.version],
    [m['dashboard.agents.field.config_path'](), local.configPath],
    [m['dashboard.agents.field.installation'](), local.installationId],
    [m['dashboard.agents.field.adapter'](), local.adapterVersion],
    [m['dashboard.agents.field.provider_id'](), local.codex?.providerId],
    [
      m['dashboard.agents.field.auth_mode'](),
      local.codex?.authMode === undefined
        ? undefined
        : local.codex.authMode === 'command'
          ? m['dashboard.agents.codex.auth_command']()
          : m['dashboard.agents.codex.auth_keep'](),
    ],
  ];
  return (
    <div className="space-y-3" data-testid="agent-status-panel">
      <AgentStatusBadge status={local.status} />
      {hint === undefined ? null : <p className="text-sm text-muted-foreground">{hint}</p>}
      {local.endpointMatches === false ? (
        <p role="alert" className="text-sm text-destructive">
          {m['dashboard.agents.field.endpoint_mismatch']()}
        </p>
      ) : null}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        {rows
          .filter((row): row is readonly [string, string] => row[1] !== undefined)
          .map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-mono text-xs break-all">{value}</dd>
            </div>
          ))}
      </dl>
    </div>
  );
};
