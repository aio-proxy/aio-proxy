import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { RotateCwIcon } from 'lucide-react';
import type React from 'react';

import { PageContainer } from '@/components/page-container';

import { ProviderCardGrid } from '../components/provider-card-grid';
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
        <Button
          nativeButton={false}
          render={<Link preload="intent" to="/providers/new" />}
          data-testid="new-provider-button"
        >
          {m['dashboard.providers.new_provider']()}
        </Button>
      }
    >
      {warning === 'catalog_unavailable' ? (
        <p role="status" className="mb-3 rounded-lg border bg-muted p-3 text-sm">
          {m['dashboard.providers.oauth.catalog_warning']()}
        </p>
      ) : null}
      {providersQuery.isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-40 w-full" />
          ))}
        </div>
      ) : providersQuery.isError ? (
        // Without this branch a failed query falls through to the grid's own empty state, which
        // tells a user whose backend is down that they have no providers configured.
        <div className="flex flex-wrap items-center gap-2" role="alert" data-testid="providers-load-error">
          <p className="text-sm text-destructive">{m['dashboard.providers.list_load_failed']()}</p>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-testid="providers-load-retry"
            onClick={() => void providersQuery.refetch()}
          >
            <RotateCwIcon data-icon="inline-start" aria-hidden="true" />
            {m['dashboard.providers.list_retry']()}
          </Button>
        </div>
      ) : (
        <ProviderCardGrid
          providers={providers}
          routingRevision={providersQuery.data?.routingRevision ?? ''}
          focusProviderId={focusProviderId}
        />
      )}
    </PageContainer>
  );
};
