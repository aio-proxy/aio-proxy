import { m } from '@aio-proxy/i18n';
import {
  type DashboardOAuthCapability,
  type DashboardOAuthProviderEdit,
  type DashboardOAuthSessionStart,
  type OAuthProvider,
  type ProviderKind,
  type ProviderMutationBody,
  type ProviderTransforms,
  modelRoutes,
  ProviderMutationBodySchema,
} from '@aio-proxy/types';
import { toast } from '@aio-proxy/ui/components/toast';
import { useQuery } from '@tanstack/react-query';
import { useSelector } from '@tanstack/react-store';
import { useState } from 'react';

import { hasWeightTie } from '../../components/provider-editor/attempt-order-preview';
import { useOAuthProviderForm } from '../../hooks/use-oauth-provider-form';
import { type ProviderEditorShape, useProviderEditorForm } from '../../hooks/use-provider-editor-form';
import { normalizeProviderFormValue, type ProviderFormShape } from '../../hooks/use-provider-form';
import { useProviderCreate, useProviderUpdate } from '../../hooks/use-provider-mutations';
import { aliasEditorIssues } from '../../lib/alias-editor';
import { ProviderFormMode, PROVIDER_KIND_LABEL } from '../../lib/constants';
import { exposedModels } from '../../lib/exposed-models';
import { applyModelRows, toModelRows } from '../../lib/model-rows';
import { oauthAccountSubmission } from '../../lib/oauth-account-submission';
import { capabilityKey } from '../../lib/oauth-capability-key';
import { oauthProviderEditAction } from '../../lib/oauth-provider-edit';
import { blockingSections, sectionStatuses } from '../../lib/section-status';
import { oauthCapabilitiesQueryOptions } from '../../services/oauth-service';
import { providersQueryOptions } from '../../services/providers-service';
import { useOAuthEditorSession } from './use-oauth-editor-session';

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
  const authorized =
    mode === ProviderFormMode.Edit || authorizedProviderId !== undefined || session?.status === 'succeeded';
  const transforms = values.transforms as ProviderTransforms | undefined;
  const summaries = sectionStatuses({
    kind: values.kind ?? kind,
    mode,
    id: values.id ?? '',
    baseURL: values.kind === 'api' ? values.baseURL : undefined,
    protocol: values.kind === 'api' ? values.protocol : undefined,
    apiKey: values.kind === 'api' ? values.apiKey : undefined,
    capabilityKey: accountValues.capabilityKey,
    authorized,
    packageName: values.kind === 'ai-sdk' ? values.packageName : undefined,
    models,
    discoveredModels: oauth?.models,
    aliasCount: Object.keys(values.alias ?? {}).length,
    aliasIssues,
    transformsValid,
    transformCount: transforms?.request?.length ?? 0,
    weightTie: hasWeightTie({
      selfId: values.id ?? '',
      selfWeight: values.weight,
      exposedAliases: modelRoutes({
        enabled: true,
        models: exposedModels(models, oauth?.models),
        alias: values.alias,
      }).map((route) => route.alias),
      others,
    }),
    enabled: values.enabled,
    weight: values.weight,
    headerCount: values.kind === 'api' ? Object.keys(values.headers ?? {}).length : 0,
    // `null`/absent is the inherit default; both `false` and a URL are a deliberate override.
    proxyCustom: values.proxy !== undefined && values.proxy !== null,
    optionsValid,
  });
  const blocking = blockingSections(summaries);

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
    summaries,
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
