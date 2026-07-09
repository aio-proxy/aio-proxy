import { m } from "@aio-proxy/i18n";
import { createFileRoute } from "@tanstack/react-router";
import { PageContainer } from "@/components/page-container";
import { UsagePage } from "@/modules/usage/templates/usage-page";

export const Route = createFileRoute("/usage")({ component: UsageRoute });

function UsageRoute() {
  return (
    <PageContainer title={m["dashboard.usage.title"]()}>
      <UsagePage />
    </PageContainer>
  );
}
