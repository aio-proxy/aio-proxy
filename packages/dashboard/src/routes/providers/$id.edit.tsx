import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthProviderEdit, OAuthProvider } from '@aio-proxy/types';
import { Empty } from '@aio-proxy/ui/components/empty';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useParams, useSearch } from '@tanstack/react-router';

import { PageContainer } from '@/components/page-container';
import { parseProviderFormInitial } from '@/modules/providers/hooks/use-provider-form';
import { ProviderFormMode } from '@/modules/providers/lib/constants';
import {
  type ProviderEditRouting,
  providerEditViewQueryOptions,
  providerFormRoutingValues,
} from '@/modules/providers/services/providers-service';
import { OAuthProviderEditPage } from '@/modules/providers/templates/oauth-provider-edit-page';
import { ProviderFormPage } from '@/modules/providers/templates/provider-form-page';

const EditProviderPage: React.FC = () => {
  const { id } = useParams({ from: '/providers/$id/edit' });
  const { session } = useSearch({ from: '/providers/$id/edit' });
  const navigate = useNavigate({ from: '/providers/$id/edit' });
  const { data, isLoading } = useQuery(providerEditViewQueryOptions(id));
  const breadcrumbs = [
    { label: m['dashboard.menus.configuration']() },
    { label: m['dashboard.providers.list_title'](), to: '/providers' },
    { label: m['dashboard.providers.edit_title']() },
  ] as const;

  if (isLoading) {
    return (
      <PageContainer title={m['dashboard.providers.edit_title']()} breadcrumbs={breadcrumbs}>
        <div className="p-4 text-sm text-muted-foreground">{m['dashboard.providers.edit_loading']()}</div>
      </PageContainer>
    );
  }

  if (!data || 'error' in data || !data.provider) {
    return (
      <PageContainer title={m['dashboard.providers.edit_title']()} breadcrumbs={breadcrumbs}>
        <Empty data-testid="not-found">{m['dashboard.providers.edit_not_found']()}</Empty>
      </PageContainer>
    );
  }

  const provider = data.provider;
  const routing = 'routing' in data ? (data.routing as ProviderEditRouting | undefined) : undefined;
  const routingValues = providerFormRoutingValues(routing);

  if (provider.kind === 'oauth') {
    if (data.oauth === undefined) {
      return (
        <PageContainer title={m['dashboard.providers.edit_title']()} breadcrumbs={breadcrumbs}>
          <Empty data-testid="not-found">{m['dashboard.providers.edit_not_found']()}</Empty>
        </PageContainer>
      );
    }
    return (
      <OAuthProviderEditPage
        provider={provider as unknown as OAuthProvider}
        oauth={data.oauth as unknown as DashboardOAuthProviderEdit}
        {...(routing === undefined ? {} : { routing })}
        sessionId={session}
        onSessionIdChange={(next) =>
          void navigate({ search: next === undefined ? {} : { session: next }, replace: true })
        }
      />
    );
  }

  const initial = parseProviderFormInitial(provider);
  if (initial === undefined) {
    return (
      <PageContainer title={m['dashboard.providers.edit_title']()} breadcrumbs={breadcrumbs}>
        <Empty data-testid="not-found">{m['dashboard.providers.edit_not_found']()}</Empty>
      </PageContainer>
    );
  }

  return (
    <ProviderFormPage
      mode={ProviderFormMode.Edit}
      kind={provider.kind}
      initial={{ ...initial, ...routingValues }}
      providerId={id}
      {...(routing === undefined ? {} : { routing })}
    />
  );
};

export const Route = createFileRoute('/providers/$id/edit')({
  validateSearch: (raw) => ({ session: typeof raw['session'] === 'string' ? raw['session'] : undefined }),
  component: EditProviderPage,
});
