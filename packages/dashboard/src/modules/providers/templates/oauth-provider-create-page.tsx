import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthCapability, DashboardOAuthSession } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

import { PageContainer } from '@/components/page-container';
import { queryKeys } from '@/lib/query-keys';

import { OAuthAccountFields } from '../components/oauth-account-fields';
import { OAuthAuthorizationPanel } from '../components/oauth-authorization-panel';
import { OAuthCapabilityCombobox } from '../components/oauth-capability-combobox';
import { ProviderProxyField } from '../components/provider-proxy-field';
import { useOAuthProviderForm } from '../hooks/use-oauth-provider-form';
import { ProviderFormMode } from '../lib/constants';
import { oauthAccountSubmission } from '../lib/oauth-account-submission';
import {
  cancelOAuthSession,
  oauthCapabilitiesQueryOptions,
  oauthSessionQueryOptions,
  startOAuthSession,
  submitOAuthCallback,
} from '../services/oauth-service';

interface OAuthProviderCreatePageProps {
  readonly sessionId: string | undefined;
  readonly onSessionIdChange: (sessionId: string | undefined) => void;
}

const capabilityKey = (capability: DashboardOAuthCapability) => `${capability.plugin}\0${capability.capability}`;

export const OAuthProviderCreatePage: React.FC<OAuthProviderCreatePageProps> = ({ sessionId, onSessionIdChange }) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const popup = useRef<Window | null>(null);
  const capabilitiesQuery = useQuery(oauthCapabilitiesQueryOptions());
  const sessionQuery = useQuery(oauthSessionQueryOptions(sessionId ?? ''));
  const startMutation = useMutation({
    mutationFn: startOAuthSession,
    onSuccess: ({ session }) => onSessionIdChange(session.id),
  });
  const callbackMutation = useMutation({ mutationFn: submitOAuthCallback });
  const cancelMutation = useMutation({
    mutationFn: cancelOAuthSession,
    onSuccess: () => onSessionIdChange(undefined),
  });
  const capabilities = capabilitiesQuery.data?.capabilities ?? [];
  const form = useOAuthProviderForm((value) => {
    const capability = capabilities.find((candidate) => capabilityKey(candidate) === value.capabilityKey);
    if (capability === undefined) return;
    const account = oauthAccountSubmission(capability.form, value);
    popup.current = window.open('', '_blank');
    startMutation.mutate({
      capability: { plugin: capability.plugin, capability: capability.capability },
      ...account,
      clearSecrets: [...account.clearSecrets],
      providerPatch: {
        enabled: true,
        ...(value.proxy === undefined ? {} : { proxy: value.proxy }),
      },
    });
  });
  const session: DashboardOAuthSession | undefined =
    sessionQuery.data?.session ??
    (sessionId !== undefined && sessionQuery.isError
      ? { id: sessionId, status: 'failed', code: 'OAUTH_SESSION_UNAVAILABLE' }
      : undefined);

  useEffect(() => {
    if (session?.status === 'loopback' && popup.current !== null) {
      popup.current.location.href = session.authorizationUrl;
      popup.current = null;
    }
    if (session?.status === 'succeeded') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers });
      void navigate({
        to: '/providers',
        search: {
          focus: session.providerId,
          ...(session.warning === undefined ? {} : { warning: session.warning }),
        },
      });
    }
  }, [navigate, queryClient, session]);

  return (
    <PageContainer
      title={m['dashboard.providers.new_title']()}
      breadcrumbs={[
        { label: m['dashboard.menus.configuration']() },
        { label: m['dashboard.providers.list_title'](), to: '/providers' },
        { label: m['dashboard.providers.new_title']() },
      ]}
    >
      <div className="max-w-lg space-y-6 p-4">
        {sessionId === undefined ? (
          <form
            className="space-y-6"
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <form.Subscribe selector={(state) => state.values.capabilityKey}>
              {(selectedKey) => {
                const selected = capabilities.find((candidate) => capabilityKey(candidate) === selectedKey);
                return (
                  <>
                    <form.Field name="capabilityKey">
                      {(field) => (
                        <OAuthCapabilityCombobox
                          capabilities={capabilities}
                          value={selected ?? null}
                          onValueChange={(value) => {
                            field.handleChange(value === null ? '' : capabilityKey(value));
                            form.setFieldValue('publicValues', value?.defaults ?? {});
                            form.setFieldValue('secrets', {});
                            form.setFieldValue('clearSecrets', []);
                            form.setFieldValue('jsonValues', {});
                          }}
                        />
                      )}
                    </form.Field>
                    {selected === undefined ? null : <OAuthAccountFields fields={selected.form} form={form} />}
                    {selected === undefined ? null : (
                      <form.Field name="proxy">
                        {(field) => <ProviderProxyField field={field} mode={ProviderFormMode.Create} />}
                      </form.Field>
                    )}
                    <Button type="submit" disabled={selected === undefined || startMutation.isPending}>
                      {m['dashboard.providers.oauth.continue']()}
                    </Button>
                  </>
                );
              }}
            </form.Subscribe>
          </form>
        ) : session === undefined ? null : (
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
        )}
      </div>
    </PageContainer>
  );
};
