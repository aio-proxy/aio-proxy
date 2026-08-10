import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthProviderEdit, OAuthProvider } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { useRef } from 'react';

import { PageContainer } from '@/components/page-container';

import { DeleteProviderDialog, type DeleteProviderDialogRef } from '../components/delete-provider-dialog';
import { OAuthAuthorizationPanel } from '../components/oauth-authorization-panel';
import { OAuthProviderEditFields } from '../components/oauth-provider-edit-fields';
import { PROVIDER_KIND_LABEL } from '../lib/constants';
import { useOAuthProviderEditPage } from './use-oauth-provider-edit-page';

interface OAuthProviderEditPageProps {
  readonly provider: OAuthProvider;
  readonly oauth: DashboardOAuthProviderEdit;
  readonly sessionId: string | undefined;
  readonly onSessionIdChange: (sessionId: string | undefined) => void;
}

export const OAuthProviderEditPage: React.FC<OAuthProviderEditPageProps> = ({
  provider,
  oauth,
  sessionId,
  onSessionIdChange,
}) => {
  const deleteDialogRef = useRef<DeleteProviderDialogRef>(null);
  const {
    navigate,
    form,
    accountForm,
    aliasOpen,
    setAliasOpen,
    transformsValid,
    setTransformsValid,
    session,
    sessionQuery,
    submit,
    isUpdating,
    startMutation,
    callbackMutation,
    cancelMutation,
  } = useOAuthProviderEditPage({ provider, oauth, sessionId, onSessionIdChange });

  return (
    <PageContainer
      title={m['dashboard.providers.edit_title']()}
      subtitle={`${provider.id} · ${PROVIDER_KIND_LABEL.oauth}`}
      breadcrumbs={[
        { label: m['dashboard.menus.configuration']() },
        { label: m['dashboard.providers.list_title'](), to: '/providers' },
        { label: m['dashboard.providers.edit_title']() },
      ]}
    >
      <div className="mx-auto max-w-4xl space-y-6 px-1 pb-4 sm:p-4">
        {sessionId === undefined ? (
          <form
            className="space-y-8"
            onSubmit={(event) => {
              event.preventDefault();
              submit(false);
            }}
          >
            <OAuthProviderEditFields
              provider={provider}
              oauth={oauth}
              form={form}
              accountForm={accountForm}
              aliasOpen={aliasOpen}
              onAliasOpenChange={setAliasOpen}
              onReauthorize={() => submit(true)}
              isReauthorizing={isUpdating || startMutation.isPending}
              transformsValid={transformsValid}
              onTransformsValidityChange={setTransformsValid}
            />
            <div className="flex items-center justify-between gap-3 border-t pt-4" data-testid="provider-form-actions">
              <div className="flex gap-3">
                <Button type="submit" disabled={!transformsValid || isUpdating || startMutation.isPending}>
                  {m['dashboard.providers.actions.save']()}
                </Button>
                <Button type="button" variant="outline" onClick={() => void navigate({ to: '/providers' })}>
                  {m['dashboard.providers.actions.cancel']()}
                </Button>
              </div>
              <Button type="button" variant="destructive" onClick={() => deleteDialogRef.current?.open(provider)}>
                {m['dashboard.providers.actions.delete']()}
              </Button>
            </div>
          </form>
        ) : (
          session !== undefined && (
            <OAuthAuthorizationPanel
              session={session}
              isPending={callbackMutation.isPending || cancelMutation.isPending}
              onSubmitCallback={(callbackUrl) =>
                callbackMutation.mutate({ id: session.id, callbackUrl }, { onSuccess: () => sessionQuery.refetch() })
              }
              onCancel={() => {
                if (session.status === 'failed' || session.status === 'cancelled') {
                  onSessionIdChange(undefined);
                  return;
                }
                cancelMutation.mutate(session.id);
              }}
            />
          )
        )}
      </div>
      <DeleteProviderDialog ref={deleteDialogRef} onDeleted={() => void navigate({ to: '/providers' })} />
    </PageContainer>
  );
};
