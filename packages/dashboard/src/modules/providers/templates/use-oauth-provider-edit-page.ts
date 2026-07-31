import type {
  DashboardOAuthProviderEdit,
  DashboardOAuthSession,
  DashboardOAuthSessionStart,
  OAuthProvider,
} from '@aio-proxy/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import { aliasEditorIssues, aliasIssueControlId } from '../alias-editor';
import { useOAuthProviderEditForm } from '../hooks/use-oauth-provider-edit-form';
import { useOAuthProviderForm } from '../hooks/use-oauth-provider-form';
import { useProviderUpdate } from '../hooks/use-provider-mutations';
import { oauthAccountSubmission } from '../services/oauth-account-submission';
import { oauthProviderEditAction } from '../services/oauth-provider-edit';
import {
  cancelOAuthSession,
  oauthSessionQueryOptions,
  startOAuthSession,
  submitOAuthCallback,
} from '../services/oauth-service';

interface UseOAuthProviderEditPageArgs {
  readonly provider: OAuthProvider;
  readonly oauth: DashboardOAuthProviderEdit;
  readonly sessionId: string | undefined;
  readonly onSessionIdChange: (sessionId: string | undefined) => void;
}

export const useOAuthProviderEditPage = ({
  provider,
  oauth,
  sessionId,
  onSessionIdChange,
}: UseOAuthProviderEditPageArgs) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const popup = useRef<Window | null>(null);
  const forceReauthorization = useRef(false);
  const [aliasOpen, setAliasOpen] = useState(false);
  const [transformsValid, setTransformsValid] = useState(true);
  const accountForm = useOAuthProviderForm(() => undefined, {
    capabilityKey: `${provider.plugin}\0${provider.capability}`,
    publicValues: oauth.publicValues,
    secrets: {},
    clearSecrets: [],
    jsonValues: {},
  });
  const { mutate: updateProvider, isPending: isUpdating } = useProviderUpdate();
  const startMutation = useMutation({
    mutationFn: startOAuthSession,
    onSuccess: ({ session }) => onSessionIdChange(session.id),
  });
  const callbackMutation = useMutation({ mutationFn: submitOAuthCallback });
  const cancelMutation = useMutation({
    mutationFn: cancelOAuthSession,
    onSuccess: () => onSessionIdChange(undefined),
  });
  const sessionQuery = useQuery(oauthSessionQueryOptions(sessionId ?? ''));
  const form = useOAuthProviderEditForm(
    {
      id: provider.id,
      name: provider.name,
      enabled: provider.enabled,
      weight: provider.weight,
      alias: provider.alias,
      transforms: provider.transforms,
      models: oauth.models,
    },
    (value) => {
      const account = oauthAccountSubmission(oauth.form, {
        publicValues: accountForm.getFieldValue('publicValues') as DashboardOAuthSessionStart['publicValues'],
        secrets: accountForm.getFieldValue('secrets'),
        clearSecrets: accountForm.getFieldValue('clearSecrets'),
      });
      const action = oauthProviderEditAction(
        {
          ...value,
          ...account,
        },
        oauth.publicValues,
        forceReauthorization.current,
      );
      forceReauthorization.current = false;
      if (action.kind === 'update') {
        updateProvider(
          { id: provider.id, body: action.body },
          { onSuccess: () => void navigate({ to: '/providers', search: { focus: provider.id } }) },
        );
        return;
      }
      popup.current = window.open('', '_blank');
      startMutation.mutate(action.input);
    },
  );
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
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
      void navigate({
        to: '/providers',
        search: {
          focus: session.providerId,
          ...(session.warning === undefined ? {} : { warning: session.warning }),
        },
      });
    }
  }, [navigate, queryClient, session]);

  const submit = (reauthorize: boolean) => {
    if (!transformsValid) return;
    const issue = aliasEditorIssues(form.getFieldValue('alias') ?? {}, oauth.models)[0];
    if (issue !== undefined) {
      setAliasOpen(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => document.getElementById(aliasIssueControlId(issue))?.focus());
      });
      return;
    }
    forceReauthorization.current = reauthorize;
    void form.handleSubmit();
  };

  return {
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
    onSessionIdChange,
  };
};
