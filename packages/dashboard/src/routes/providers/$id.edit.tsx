import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthProviderEdit, OAuthProvider } from '@aio-proxy/types';
import { Empty } from '@aio-proxy/ui/components/empty';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useParams, useSearch } from '@tanstack/react-router';

import { PageContainer } from '@/components/page-container';
import { parseProviderFormInitial } from '@/modules/providers/hooks/use-provider-form';
import { ProviderFormMode } from '@/modules/providers/lib/constants';
import { providerEditViewQueryOptions } from '@/modules/providers/services/providers-service';
import { ProviderEditorPage } from '@/modules/providers/templates/provider-editor-page';

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
  const onSessionIdChange = (next: string | undefined) =>
    void navigate({ search: next === undefined ? {} : { session: next }, replace: true });

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

  if (provider.kind === 'oauth') {
    if (data.oauth === undefined) {
      return (
        <PageContainer title={m['dashboard.providers.edit_title']()} breadcrumbs={breadcrumbs}>
          <Empty data-testid="not-found">{m['dashboard.providers.edit_not_found']()}</Empty>
        </PageContainer>
      );
    }
    return (
      <ProviderEditorPage
        mode={ProviderFormMode.Edit}
        kind={provider.kind}
        providerId={id}
        provider={provider as unknown as OAuthProvider}
        oauth={data.oauth as unknown as DashboardOAuthProviderEdit}
        initial={{
          id: provider.id,
          name: provider.name,
          enabled: provider.enabled,
          weight: provider.weight,
          proxy: provider.proxy,
          alias: provider.alias,
          transforms: provider.transforms,
          models: provider.models ?? [],
          metadata: provider.metadata,
        }}
        sessionId={session}
        onSessionIdChange={onSessionIdChange}
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
    <ProviderEditorPage
      mode={ProviderFormMode.Edit}
      kind={provider.kind}
      providerId={id}
      initial={initial}
      sessionId={session}
      onSessionIdChange={onSessionIdChange}
    />
  );
};

export const Route = createFileRoute('/providers/$id/edit')({
  validateSearch: (raw) => ({ session: typeof raw['session'] === 'string' ? raw['session'] : undefined }),
  component: EditProviderPage,
});
