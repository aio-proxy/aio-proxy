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
import { useProviderCreate, useProviderUpdate } from '../../hooks/use-provider-mutations';
import { aliasEditorIssues } from '../../lib/alias-editor';
import { ProviderFormMode, PROVIDER_KIND_LABEL } from '../../lib/constants';
import { exposedModels } from '../../lib/exposed-models';
import { applyModelRows, toModelRows } from '../../lib/model-rows';
import { oauthAccountSubmission } from '../../lib/oauth-account-submission';
import { capabilityKey } from '../../lib/oauth-capability-key';
import { oauthProviderEditAction } from '../../lib/oauth-provider-edit';
import { normalizeProviderFormValue, type ProviderFormShape } from '../../lib/provider-form-value';
import { sectionStatuses } from '../../lib/section-status';
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
  updateProvider: (input: { id: string; body: ProviderMutationBody }) => void,
  startReauthorize: (input: DashboardOAuthSessionStart, options: { onError: () => void }) => void,
  openPopup: () => void,
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
    updateProvider({ id: values.id, body: action.body });
    return;
  }
  openPopup();
  startReauthorize(action.input, { onError });
};

const saveConfigProvider = (
  mode: ProviderFormMode,
  values: ProviderEditorShape,
  providerId: string | undefined,
  persistedMetadata: ProviderEditorShape['metadata'],
  createProvider: (body: ProviderMutationBody) => void,
  updateProvider: (input: { id: string; body: ProviderMutationBody }) => void,
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
  // Reconciled before the mode branch, not inside it: create must drop the empty records the drawer
  // left behind, exactly as update does. What `applyModelRows` prunes is the EMPTY record of a LISTED
  // id — a model whose cost fields were opened and cleared. Records for ids outside `models[]` are
  // deliberately kept, because alias-only targets have metadata and no list entry; do not "fix"
  // `applyModelRows` to prune those.
  const applied = applyModelRows(toModelRows(values.models ?? [], values.metadata ?? {}), values.metadata);
  // `{}` is not inert on update — `replaceProvider` retains `metadata` when the body omits it, so an
  // emptied map has to be sent explicitly to clear the persisted one. With nothing persisted there is
  // nothing to clear, and sending `{}` would stamp a dead `metadata: {}` key into the config file.
  const metadata = applied.metadata ?? (Object.keys(persistedMetadata ?? {}).length === 0 ? undefined : {});
  // The parsed `metadata` is dropped rather than overwritten with `undefined`, and the reconciled one
  // is spread in only when there is one — the same conditional-spread idiom as `proxy` above. The
  // parsed value is the unreconciled form state, so letting it through would restore exactly the
  // empty records `applyModelRows` just pruned.
  const { metadata: _unreconciled, ...parsed } = result.data;
  const body = { ...parsed, ...(metadata === undefined ? {} : { metadata }) };
  if (mode === ProviderFormMode.Create) {
    createProvider(body);
    return;
  }
  updateProvider({ id: providerId ?? values.id, body });
};

/**
 * The edit heading names the provider you are on. A display name is optional (D-F5), so a provider
 * saved without one falls back to the generic label rather than heading the page with nothing.
 */
const editorTitle = (mode: ProviderFormMode, name: string | undefined): string => {
  if (mode === ProviderFormMode.Create) return m['dashboard.providers.new_title']();
  return name === undefined || name.trim() === '' ? m['dashboard.providers.edit_title']() : name;
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
        closeUnclaimedPopup,
      );
      return;
    }
    saveConfigProvider(mode, values, providerId, initial?.metadata, createProvider, updateProvider);
  };

  // "Already has a key" is a property of what was loaded, not of the live field: the user clearing the
  // input must not flip the copy to "optional" and lose the promise that an empty save retains the key.
  const hasApiKey = initial !== undefined && 'apiKey' in initial && (initial.apiKey ?? '') !== '';

  const title = editorTitle(mode, values.name);
  const subtitle =
    mode === ProviderFormMode.Create
      ? m['dashboard.providers.editor.header_create_subtitle']()
      : `${providerId ?? values.id} · ${PROVIDER_KIND_LABEL[kind]}`;

  return {
    form,
    accountForm,
    kind,
    mode,
    capabilities,
    oauth,
    provider,
    summaries,
    authorized,
    hasApiKey,
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
    // One label, as in the demo footer. It used to read "authorize" for an unauthorized oauth draft,
    // but X9 makes that draft block the save, so the button was permanently disabled in exactly the
    // state whose action it named. Authorizing is the Connection section's button — same `save(false)`.
    primaryLabel: m['dashboard.providers.editor.footer_save'](),
    title,
    subtitle,
    navigate,
  };
};
