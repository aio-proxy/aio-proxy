import { m } from '@aio-proxy/i18n';
import type React from 'react';

import { PageContainer } from '@/components/page-container';

interface RoutingModelPageProps {
  readonly modelId: string;
}

export const RoutingModelPage: React.FC<RoutingModelPageProps> = ({ modelId }) => (
  <PageContainer
    title={<span className="font-mono">{modelId}</span>}
    breadcrumbs={[
      { label: m['dashboard.menus.configuration']() },
      { label: m['dashboard.routing.title'](), to: '/routing' },
      { label: modelId },
    ]}
  >
    {null}
  </PageContainer>
);
