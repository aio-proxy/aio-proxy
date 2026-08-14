import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent } from '@aio-proxy/ui/components/card';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type React from 'react';

import { PageContainer } from '@/components/page-container';

import { ProvidersTable } from '../components/providers-table';
import { providersQueryOptions } from '../services/providers-service';

interface ProvidersPageProps {
  readonly focusProviderId?: string;
  readonly warning?: 'catalog_unavailable';
}

export const ProvidersPage: React.FC<ProvidersPageProps> = ({ focusProviderId, warning }) => {
  const providersQuery = useQuery(providersQueryOptions());
  const providers = providersQuery.data?.providers ?? [];

  return (
    <PageContainer
      title={m['dashboard.providers.list_title']()}
      breadcrumbs={[{ label: m['dashboard.menus.configuration']() }, { label: m['dashboard.providers.list_title']() }]}
      extra={
        <Button render={<Link preload="intent" to="/providers/new" />} data-testid="new-provider-button">
          {m['dashboard.providers.new_provider']()}
        </Button>
      }
    >
      <Card>
        <CardContent>
          {warning === 'catalog_unavailable' ? (
            <p role="status" className="mb-3 rounded-lg border bg-muted p-3 text-sm">
              {m['dashboard.providers.oauth.catalog_warning']()}
            </p>
          ) : null}
          {providersQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <ProvidersTable providers={providers} focusProviderId={focusProviderId} />
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
};
