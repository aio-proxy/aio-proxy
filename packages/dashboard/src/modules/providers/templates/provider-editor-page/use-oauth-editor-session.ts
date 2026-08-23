import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthSession } from '@aio-proxy/types';
import { toast } from '@aio-proxy/ui/components/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { queryKeys } from '@/lib/query-keys';
import { OAUTH_COMPLETE_MESSAGE } from '@/modules/oauth-complete/templates/oauth-complete-page/oauth-complete-page';

import { ProviderFormMode } from '../../lib/constants';
import {
  cancelOAuthSession,
  oauthSessionQueryOptions,
  startOAuthSession,
  submitOAuthCallback,
} from '../../services/oauth-service';
import { providerEditViewQueryOptions } from '../../services/providers-service';

export const useOAuthEditorSession = (
  mode: ProviderFormMode,
  sessionId: string | undefined,
  onSessionIdChange: (sessionId: string | undefined) => void,
  providerId: string | undefined,
) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const popup = useRef<Window | null>(null);
  const handledSuccess = useRef<string | undefined>(undefined);
  const closeUnclaimedPopup = useCallback(() => {
    const unclaimed = popup.current;
    popup.current = null;
    unclaimed?.close();
  }, []);
  const openPopup = useCallback(() => {
    popup.current = window.open('', '_blank');
  }, []);
  const [authorizedProviderId, setAuthorizedProviderId] = useState<string | undefined>(
    mode === ProviderFormMode.Edit ? providerId : undefined,
  );
  const [sessionWarning, setSessionWarning] = useState<'catalog_unavailable' | undefined>(undefined);
  const startMutation = useMutation({
    mutationFn: startOAuthSession,
    onSuccess: ({ session }) => onSessionIdChange(session.id),
    onError: (error) => {
      toast.add({
        type: 'error',
        title: m['dashboard.providers.oauth.start_failed'](),
        description: error instanceof Error ? error.message : undefined,
      });
    },
  });
  const callbackMutation = useMutation({ mutationFn: submitOAuthCallback });
  const cancelMutation = useMutation({
    mutationFn: cancelOAuthSession,
    onSuccess: () => onSessionIdChange(undefined),
  });
  const sessionQuery = useQuery(oauthSessionQueryOptions(sessionId ?? ''));
  const persistedId = authorizedProviderId ?? providerId;
  const editViewQuery = useQuery({
    ...providerEditViewQueryOptions(persistedId ?? ''),
    enabled: persistedId !== undefined && persistedId !== '',
  });
  const session: DashboardOAuthSession | undefined =
    sessionQuery.data?.session ??
    (sessionId !== undefined && sessionQuery.isError
      ? { id: sessionId, status: 'failed', code: 'OAUTH_SESSION_UNAVAILABLE' }
      : undefined);

  useEffect(() => {
    if ((session?.status === 'authorize_url' || session?.status === 'loopback') && popup.current !== null) {
      popup.current.location.href = session.status === 'loopback' ? session.authorizationUrl : session.url;
      popup.current = null;
    }
    if (session?.status === 'failed' || session?.status === 'cancelled' || session?.status === 'device_code') {
      closeUnclaimedPopup();
    }
    if (session?.status === 'succeeded' && handledSuccess.current !== session.id) {
      handledSuccess.current = session.id;
      setAuthorizedProviderId(session.providerId);
      setSessionWarning(session.warning);
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers });
      void editViewQuery.refetch();
      if (mode === ProviderFormMode.Create) {
        void navigate({
          to: '/providers/$id/edit',
          params: { id: session.providerId },
          search: { session: session.id },
          replace: true,
        });
      }
    }
  }, [closeUnclaimedPopup, editViewQuery, mode, navigate, queryClient, session]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if ((event.data as { type?: string } | null)?.type !== OAUTH_COMPLETE_MESSAGE) return;
      const source = event.source;
      if (source !== null && 'close' in source) (source as Window).close();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => closeUnclaimedPopup, [closeUnclaimedPopup]);

  return {
    openPopup,
    closeUnclaimedPopup,
    startMutation,
    callbackMutation,
    cancelMutation,
    sessionQuery,
    session,
    authorizedProviderId,
    sessionWarning,
    persistedId,
    navigate,
  };
};
