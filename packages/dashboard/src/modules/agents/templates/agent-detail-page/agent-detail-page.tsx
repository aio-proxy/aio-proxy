import { m } from '@aio-proxy/i18n';
import { agentDescriptor, type AgentLocalStatus, type AgentTarget } from '@aio-proxy/types';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';

import { PageContainer } from '@/components/page-container';

import { AgentNotes } from '../../components/agent-notes';
import { AgentSetupPanel } from '../../components/agent-setup-panel';
import { AgentStatusPanel } from '../../components/agent-status-panel';
import { DetailSection } from '../../components/detail-section';
import { InstallationsTable } from '../../components/installations-table';
import { LocalSetupBanner } from '../../components/local-setup-banner';
import { ManualCommands } from '../../components/manual-commands';
import { RemoveAgentDialog } from '../../components/remove-agent-dialog';
import { useAgentsSnapshot } from '../../hooks/use-agents-snapshot';
import { AGENT_DISPLAY_NAMES, agentInstallations } from '../../lib/agent-state';

interface AgentDetailPageProps {
  readonly target: AgentTarget;
}

const REMOVABLE = new Set<AgentLocalStatus>(['configured', 'outdated', 'modified', 'missing']);

export const AgentDetailPage: React.FC<AgentDetailPageProps> = ({ target }) => {
  const descriptor = agentDescriptor(target);
  const name = AGENT_DISPLAY_NAMES[target];
  const snapshot = useAgentsSnapshot();
  const content = (() => {
    if (snapshot.isLoading) return <Skeleton className="h-64 w-full" />;
    if (snapshot.isError || snapshot.data === undefined)
      return (
        <p role="alert" className="text-sm text-destructive">
          {m['dashboard.agents.load_failed']()}
        </p>
      );
    const data = snapshot.data;
    const local = data.local?.find((row) => row.target === target);
    const removable = local !== undefined && REMOVABLE.has(local.status);
    return (
      <div className="space-y-4">
        <LocalSetupBanner snapshot={data} />
        {local === undefined ? null : (
          <DetailSection title={m['dashboard.agents.section.status']()}>
            <AgentStatusPanel local={local} />
          </DetailSection>
        )}
        {data.localSetup === 'unavailable' ? null : (
          <DetailSection title={m['dashboard.agents.section.setup']()}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <AgentSetupPanel key={target} descriptor={descriptor} local={local} localSetup={data.localSetup} />
              <RemoveAgentDialog target={target} removable={removable} disabled={data.localSetup !== 'available'} />
            </div>
          </DetailSection>
        )}
        <DetailSection title={m['dashboard.agents.section.authorizations']()}>
          <InstallationsTable
            installations={agentInstallations(data, target)}
            canRevoke={data.localSetup === 'available'}
            emptyMessage={m['dashboard.agents.table.empty']()}
          />
        </DetailSection>
        <DetailSection title={m['dashboard.agents.section.notes']()}>
          <AgentNotes descriptor={descriptor} localVisible={data.local !== undefined} />
        </DetailSection>
        <DetailSection title={m['dashboard.agents.section.manual']()}>
          <ManualCommands descriptor={descriptor} />
        </DetailSection>
      </div>
    );
  })();
  return (
    <PageContainer
      title={name}
      breadcrumbs={[
        { label: m['dashboard.menus.configuration']() },
        { label: m['dashboard.agents.title'](), to: '/agents' },
        { label: name },
      ]}
    >
      {content}
    </PageContainer>
  );
};
