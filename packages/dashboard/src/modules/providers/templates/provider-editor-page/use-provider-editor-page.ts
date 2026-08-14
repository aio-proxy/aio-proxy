import { m } from '@aio-proxy/i18n';
import {
  type DashboardOAuthCapability,
  type DashboardOAuthProviderEdit,
  type DashboardOAuthSession,
  type DashboardOAuthSessionStart,
  type OAuthProvider,
  type ProviderKind,
  type ProviderMutationBody,
  type ProviderTransforms,
  modelRoutes,
  ProviderMutationBodySchema,
} from '@aio-proxy/types';
import { toast } from '@aio-proxy/ui/components/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useSelector } from '@tanstack/react-store';
import { useCallback, useEffect, useRef, useState } from 'react';

import { queryKeys } from '@/lib/query-keys';

import { hasWeightTie } from '../../components/provider-editor/attempt-order-preview';
import { useOAuthProviderForm } from '../../hooks/use-oauth-provider-form';
import { type ProviderEditorShape, useProviderEditorForm } from '../../hooks/use-provider-editor-form';
import { normalizeProviderFormValue, type ProviderFormShape } from '../../hooks/use-provider-form';
import { useProviderCreate, useProviderUpdate } from '../../hooks/use-provider-mutations';
import { aliasEditorIssues } from '../../lib/alias-editor';
import { ProviderFormMode, PROVIDER_KIND_LABEL } from '../../lib/constants';
import { applyModelRows, toModelRows } from '../../lib/model-rows';
import { oauthAccountSubmission } from '../../lib/oauth-account-submission';
import { capabilityKey } from '../../lib/oauth-capability-key';
import { oauthProviderEditAction } from '../../lib/oauth-provider-edit';
import { blockingSections, sectionStatuses } from '../../lib/section-status';
import {
  cancelOAuthSession,
  oauthCapabilitiesQueryOptions,
  oauthSessionQueryOptions,
  startOAuthSession,
  submitOAuthCallback,
} from '../../services/oauth-service';
import { providerEditViewQueryOptions, providersQueryOptions } from '../../services/providers-service';

const accountDraft = (values: {
  readonly publicValues: Record<string, unknown>;
  readonly secrets: DashboardOAuthSessionStart['secrets'];
  readonly clearSecrets: readonly string[];
}): Parameters<typeof oauthAccountSubmission>[1] => ({
  publicValues: values.publicValues as DashboardOAuthSessionStart['publicValues'],
  secrets: values.secrets,
  clearSecrets: values.clearSecrets,
});

type AccountFormValues = {
  readonly capabilityKey: string;
  readonly publicValues: Record<string, unknown>;
  readonly secrets: DashboardOAuthSessionStart['secrets'];
  readonly clearSecrets: readonly string[];
};

const startCreateAuthorization = (
  values: ProviderEditorShape,
  accountValues: AccountFormValues,
  capabilities: readonly DashboardOAuthCapability[],
  mutate: (input: DashboardOAuthSessionStart, options: { onError: () => void }) => void,
  onError: () => void,
) => {
  const selected = capabilities.find((candidate) => capabilityKey(candidate) === accountValues.capabilityKey);
  if (selected === undefined) return;
  const account = oauthAccountSubmission(selected.form, accountDraft(accountValues));
  mutate(
    {
      capability: { plugin: selected.plugin, capability: selected.capability },
      ...account,
      clearSecrets: [...account.clearSecrets],
      providerPatch: {
        enabled: true,
        ...(values.name === undefined || values.name === '' ? {} : { name: values.name }),
        ...(values.proxy === undefined ? {} : { proxy: values.proxy }),
      },
    },
    { onError },
  );
};

const saveOAuthProvider = (
  values: ProviderEditorShape,
  accountValues: AccountFormValues,
  oauth: DashboardOAuthProviderEdit,
  forceReauthorize: boolean,
  updateProvider: (input: { id: string; body: ProviderMutationBody }, options: { onSuccess: () => void }) => void,
  startReauthorize: (input: DashboardOAuthSessionStart, options: { onError: () => void }) => void,
  openPopup: () => void,
  onSaved: () => void,
  onError: () => void,
) => {
  const account = oauthAccountSubmission(oauth.form, accountDraft(accountValues));
  const action = oauthProviderEditAction(
    {
      ...values,
      id: values.id,
      enabled: values.enabled ?? true,
      transforms: values.transforms as ProviderTransforms | undefined,
      metadata: values.metadata ?? {},
      ...account,
    },
    oauth.publicValues,
    forceReauthorize,
  );
  if (action.kind === 'update') {
    updateProvider({ id: values.id, body: action.body }, { onSuccess: onSaved });
    return;
  }
  openPopup();
  startReauthorize(action.input, { onError });
};

const saveConfigProvider = (
  mode: ProviderFormMode,
  values: ProviderEditorShape,
  providerId: string | undefined,
  createProvider: (body: ProviderMutationBody, options: { onSuccess: () => void }) => void,
  updateProvider: (input: { id: string; body: ProviderMutationBody }, options: { onSuccess: () => void }) => void,
  onSaved: () => void,
) => {
  const result = ProviderMutationBodySchema.safeParse(normalizeProviderFormValue(values as ProviderFormShape));
  if (!result.success) {
    toast.add({
      type: 'error',
      title:
        mode === ProviderFormMode.Create
          ? m['dashboard.providers.toast.create_failed']()
          : m['dashboard.providers.toast.update_failed'](),
      description: result.error.issues.map((issue) => issue.message).join(', '),
    });
    return;
  }
  if (mode === ProviderFormMode.Create) {
    createProvider(result.data, { onSuccess: onSaved });
    return;
  }
  const applied = applyModelRows(toModelRows(values.models ?? [], values.metadata ?? {}), values.metadata);
  updateProvider(
    { id: providerId ?? values.id, body: { ...result.data, metadata: applied.metadata ?? {} } },
    { onSuccess: onSaved },
  );
};

export interface ProviderEditorPageProps {
  readonly mode: ProviderFormMode;
  readonly kind: ProviderKind;
  readonly onKindChange?: ((kind: ProviderKind) => void) | undefined;
  readonly providerId?: string | undefined;
  readonly initial?: Partial<ProviderEditorShape> | undefined;
  readonly oauth?: DashboardOAuthProviderEdit | undefined;
  readonly provider?: OAuthProvider | undefined;
  readonly sessionId?: string | undefined;
  readonly onSessionIdChange: (sessionId: string | undefined) => void;
}

const useOAuthEditorSession = (
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
      popup.current.location.href = session.status === 'authorize_url' ? session.url : session.authorizationUrl;
      popup.current = null;
    }
    if (session?.status === 'failed' || session?.status === 'cancelled') closeUnclaimedPopup();
    if (session?.status === 'succeeded' && handledSuccess.current !== session.id) {
      handledSuccess.current = session.id;
      setAuthorizedProviderId(session.providerId);
      setSessionWarning(session.warning);
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers });
      void editViewQuery.refetch();
      if (mode === ProviderFormMode.Create) {
        void navigate({ to: '/providers/$id/edit', params: { id: session.providerId }, replace: true });
      }
    }
  }, [closeUnclaimedPopup, editViewQuery, mode, navigate, queryClient, session]);

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

export const useProviderEditorPage = ({
  mode,
  kind,
  onKindChange,
  providerId,
  initial,
  oauth,
  provider,
  sessionId,
  onSessionIdChange,
}: ProviderEditorPageProps) => {
  const [optionsValid, setOptionsValid] = useState(kind !== 'ai-sdk');
  const [transformsValid, setTransformsValid] = useState(true);
  const [saved, setSaved] = useState(false);
  const {
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
  } = useOAuthEditorSession(mode, sessionId, onSessionIdChange, providerId);

  const form = useProviderEditorForm({ kind, initial });
  const accountForm = useOAuthProviderForm(
    () => undefined,
    mode === ProviderFormMode.Edit && provider !== undefined && oauth !== undefined
      ? {
          capabilityKey: capabilityKey(provider),
          publicValues: oauth.publicValues,
          secrets: {},
          clearSecrets: [],
          jsonValues: {},
        }
      : undefined,
  );

  const { mutate: createProvider, isPending: isCreating } = useProviderCreate();
  const { mutate: updateProvider, isPending: isUpdating } = useProviderUpdate();
  const capabilitiesQuery = useQuery(oauthCapabilitiesQueryOptions());
  const summariesQuery = useQuery(providersQueryOptions());

  const values = useSelector(form.store, (state) => state.values);
  const accountValues = useSelector(accountForm.store, (state) => state.values);
  const capabilities = capabilitiesQuery.data?.capabilities ?? [];
  const others = summariesQuery.data?.providers ?? [];
  const models = values.models ?? [];
  const aliasIssues = aliasEditorIssues(values.alias ?? {}, models);
  const statuses = sectionStatuses({
    kind: values.kind ?? kind,
    mode,
    id: values.id ?? '',
    baseURL: values.kind === 'api' ? values.baseURL : undefined,
    protocol: values.kind === 'api' ? values.protocol : undefined,
    capabilityKey: accountValues.capabilityKey,
    models,
    discoveredModels: oauth?.models,
    aliasIssues,
    transformsValid,
    weightTie: hasWeightTie({
      selfId: values.id ?? '',
      selfWeight: values.weight,
      exposedAliases: modelRoutes({ enabled: true, models, alias: values.alias }).map((route) => route.alias),
      others,
    }),
    optionsValid,
  });
  const blocking = blockingSections(statuses);

  const authorized =
    mode === ProviderFormMode.Edit || authorizedProviderId !== undefined || session?.status === 'succeeded';

  const handleKindChange = (next: ProviderKind) => {
    onKindChange?.(next);
    setOptionsValid(next !== 'ai-sdk');
    const nextValues = { ...form.state.values, kind: next } as ProviderEditorShape;
    form.reset(nextValues);
    // reset clears isTouched; without a follow-up write, useForm re-applies
    // `defaultValues: { ...initial, kind }` on the parent rerender and wipes name/id.
    form.setFieldValue('kind', next);
  };

  const save = (forceReauthorize = false) => {
    setSaved(false);
    if (kind === 'oauth') {
      if (mode === ProviderFormMode.Create && !authorized) {
        openPopup();
        startCreateAuthorization(values, accountValues, capabilities, startMutation.mutate, closeUnclaimedPopup);
        return;
      }
      if (oauth === undefined) return;
      saveOAuthProvider(
        values,
        accountValues,
        oauth,
        forceReauthorize,
        updateProvider,
        startMutation.mutate,
        openPopup,
        () => setSaved(true),
        closeUnclaimedPopup,
      );
      return;
    }
    saveConfigProvider(mode, values, providerId, createProvider, updateProvider, () => setSaved(true));
  };

  const title =
    mode === ProviderFormMode.Create ? m['dashboard.providers.new_title']() : m['dashboard.providers.edit_title']();
  const subtitle =
    mode === ProviderFormMode.Edit && (providerId ?? values.id) !== undefined
      ? `${providerId ?? values.id} · ${PROVIDER_KIND_LABEL[kind]}`
      : undefined;

  return {
    form,
    accountForm,
    kind,
    mode,
    capabilities,
    oauth,
    provider,
    statuses,
    blocking,
    authorized,
    saved,
    sessionWarning,
    values,
    others,
    persistedId,
    session,
    sessionQuery,
    callbackMutation,
    cancelMutation,
    onSessionIdChange,
    handleKindChange,
    setOptionsValid,
    setTransformsValid,
    save,
    isReauthorizing: startMutation.isPending,
    pending: isCreating || isUpdating || startMutation.isPending,
    primaryLabel:
      kind === 'oauth' && mode === ProviderFormMode.Create && !authorized
        ? m['dashboard.providers.editor.authorize']()
        : m['dashboard.providers.editor.footer_save'](),
    title,
    subtitle,
    navigate,
  };
};
