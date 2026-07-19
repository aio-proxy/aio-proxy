import { m } from "@aio-proxy/i18n";
import { createFileRoute } from "@tanstack/react-router";

import { PageContainer } from "@/components/page-container";
import { UsageOverview } from "@/modules/usage/templates/usage-overview";

const DashboardRoute: React.FC = () => {
  return (
    <PageContainer title={m["dashboard.menus.dashboard"]()}>
      <UsageOverview />
    </PageContainer>
  );
};

export const Route = createFileRoute("/")({ component: DashboardRoute });
