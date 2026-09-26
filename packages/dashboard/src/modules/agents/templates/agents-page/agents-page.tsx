import { m } from '@aio-proxy/i18n';
import { AGENT_DESCRIPTORS } from '@aio-proxy/types';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';

import { PageContainer } from '@/components/page-container';

import { AgentCard } from '../../components/agent-card';
import { LocalSetupBanner } from '../../components/local-setup-banner';
import { useAgentsSnapshot } from '../../hooks/use-agents-snapshot';

export const AgentsPage: React.FC = () => {
  const snapshot = useAgentsSnapshot();
  const content = (() => {
    if (snapshot.isLoading)
      return (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {AGENT_DESCRIPTORS.map((descriptor) => (
            <Skeleton key={descriptor.target} className="h-32 w-full" />
          ))}
        </div>
      );
    if (snapshot.isError || snapshot.data === undefined)
      return (
        <p role="alert" className="text-sm text-destructive">
          {m['dashboard.agents.load_failed']()}
        </p>
      );
    const data = snapshot.data;
    return (
      <div className="space-y-4">
        <LocalSetupBanner snapshot={data} />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {AGENT_DESCRIPTORS.map((descriptor) => (
            <AgentCard
              key={descriptor.target}
              descriptor={descriptor}
              local={data.local?.find((row) => row.target === descriptor.target)}
              installations={data.installations.filter((item) => item.target === descriptor.target)}
            />
          ))}
        </div>
      </div>
    );
  })();
  return (
    <PageContainer
      title={m['dashboard.agents.title']()}
      subtitle={m['dashboard.agents.description']()}
      breadcrumbs={[{ label: m['dashboard.menus.configuration']() }, { label: m['dashboard.agents.title']() }]}
    >
      {content}
    </PageContainer>
  );
};
