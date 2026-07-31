import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthProviderEdit, OAuthProvider } from '@aio-proxy/types';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useParams, useSearch } from '@tanstack/react-router';

import { PageContainer } from '@/components/page-container';
import { Empty } from '@/components/ui/empty';
import { ProviderFormMode } from '@/modules/providers/constants';
import type { ProviderFormInitial } from '@/modules/providers/hooks/use-provider-form';
import { providerEditViewQueryOptions } from '@/modules/providers/services/providers-service';
import { OAuthProviderEditPage } from '@/modules/providers/templates/oauth-provider-edit-page';
import { ProviderFormPage } from '@/modules/providers/templates/provider-form-page';

const EditProviderPage: React.FC = () => {
  const { id } = useParams({ from: '/providers/$id/edit' });
  const { session } = useSearch({ from: '/providers/$id/edit' });
  const navigate = useNavigate({ from: '/providers/$id/edit' });
  const { data, isLoading } = useQuery(providerEditViewQueryOptions(id));

  if (isLoading) {
    return (
      <PageContainer title={m['dashboard.providers.edit_title']()} backTo="/providers">
        <div className="p-4 text-sm text-muted-foreground">{m['dashboard.providers.edit_loading']()}</div>
      </PageContainer>
    );
  }

  if (!data || 'error' in data || !data.provider) {
    return (
      <PageContainer title={m['dashboard.providers.edit_title']()} backTo="/providers">
        <Empty data-testid="not-found">{m['dashboard.providers.edit_not_found']()}</Empty>
      </PageContainer>
    );
  }

  const provider = data.provider;

  if (provider.kind === 'oauth') {
    if (data.oauth === undefined) {
      return (
        <PageContainer title={m['dashboard.providers.edit_title']()} backTo="/providers">
          <Empty data-testid="not-found">{m['dashboard.providers.edit_not_found']()}</Empty>
        </PageContainer>
      );
    }
    return (
      <OAuthProviderEditPage
        provider={provider as unknown as OAuthProvider}
        oauth={data.oauth as unknown as DashboardOAuthProviderEdit}
        sessionId={session}
        onSessionIdChange={(next) =>
          void navigate({ search: next === undefined ? {} : { session: next }, replace: true })
        }
      />
    );
  }

  return (
    <ProviderFormPage
      mode={ProviderFormMode.Edit}
      kind={provider.kind}
      initial={provider as unknown as ProviderFormInitial}
      providerId={id}
    />
  );
};

export const Route = createFileRoute('/providers/$id/edit')({
  validateSearch: (raw) => ({ session: typeof raw['session'] === 'string' ? raw['session'] : undefined }),
  component: EditProviderPage,
});
