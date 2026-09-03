import { m } from '@aio-proxy/i18n';
import {
  type DashboardOAuthCapability,
  type DashboardOAuthProviderEdit,
  type DashboardOAuthSessionStart,
  dashboardOAuthCompleteUrl,
  type OAuthProvider,
  type ProviderAlias,
  type ProviderKind,
  type ProviderMutationBody,
  type ProviderTransforms,
  modelRoutes,
  ProviderMutationBodySchema,
} from '@aio-proxy/types';
import { toast } from '@aio-proxy/ui/components/toast';
import { useQuery } from '@tanstack/react-query';
import { useSelector } from '@tanstack/react-store';
import { useCallback, useState } from 'react';

import { useOAuthProviderForm } from '../../hooks/use-oauth-provider-form';
import {
  type ProviderEditorInitial,
  type ProviderEditorShape,
  type ProviderEditorWire,
  useProviderEditorForm,
} from '../../hooks/use-provider-editor-form';
import { useProviderCreate, useProviderUpdate } from '../../hooks/use-provider-mutations';
import {
  aliasEditorIssues,
  editorEffectiveAlias,
  isOAuthInheritOff,
  serializeAlias,
  serializeOAuthAlias,
  toAliasRecord,
  toAliasRows,
  toOAuthAliasRows,
} from '../../lib/alias-editor';
import { ProviderFormMode, PROVIDER_KIND_LABEL } from '../../lib/constants';
import { exposedModels, oauthEditorExposedModels } from '../../lib/exposed-models';
import { oauthAccountSubmission } from '../../lib/oauth-account-submission';
import { capabilityKey } from '../../lib/oauth-capability-key';
import { oauthProviderEditAction } from '../../lib/oauth-provider-edit';
import { normalizeProviderFormValue, type ProviderFormShape } from '../../lib/provider-form-value';
import { blockingSections, sectionStatuses, type SectionStatusInput } from '../../lib/section-status';
import { hasWeightTie } from '../../lib/weight-tie';
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
  values: ProviderEditorWire,
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
      ...(dashboardOAuthCompleteUrl(window.location.origin) === undefined
        ? {}
        : { completeUrl: dashboardOAuthCompleteUrl(window.location.origin) }),
      providerPatch: {
        enabled: true,
        ...(values.name === undefined || values.name.trim() === '' ? {} : { name: values.name.trim() }),
        ...(values.priority === undefined ? {} : { priority: values.priority }),
        ...(values.weight === undefined ? {} : { weight: values.weight }),
        ...(values.proxy === undefined ? {} : { proxy: values.proxy }),
      },
    },
    { onError },
  );
};

const saveOAuthProvider = (
  values: ProviderEditorWire,
  accountValues: AccountFormValues,
  oauth: DashboardOAuthProviderEdit,
  forceReauthorize: boolean,
  updateProvider: (input: { id: string; body: ProviderMutationBody }) => void,
  startReauthorize: (input: DashboardOAuthSessionStart, options: { onError: () => void }) => void,
  onError: () => void,
) => {
  const account = oauthAccountSubmission(oauth.form, accountDraft(accountValues));
  const action = oauthProviderEditAction(
    {
      ...values,
      id: values.id,
      enabled: values.enabled ?? true,
      transforms: values.transforms as ProviderTransforms | undefined,
      ...account,
    },
    oauth.publicValues,
    forceReauthorize,
  );
  if (action.kind === 'update') {
    updateProvider({ id: values.id, body: action.body });
    return;
  }
  startReauthorize(action.input, { onError });
};

const saveEditor = (
  forceReauthorize: boolean,
  ctx: {
    // The live form values, not the wire shape: serializing `alias` to a record is this function's
    // own first step, so annotating the input as already-serialized made both ends wrong.
    readonly values: ProviderEditorShape;
    readonly kind: ProviderKind;
    readonly mode: ProviderFormMode;
    readonly authorized: boolean;
    readonly accountForm: { readonly state: { readonly isValid: boolean } };
    readonly accountValues: AccountFormValues;
    readonly capabilities: readonly DashboardOAuthCapability[];
    readonly oauth: DashboardOAuthProviderEdit | undefined;
    readonly providerId: string | undefined;
    readonly initial: ProviderEditorInitial | undefined;
    readonly openPopup: () => void;
    readonly closeUnclaimedPopup: () => void;
    readonly startMutation: {
      readonly mutate: (input: DashboardOAuthSessionStart, options?: { onError: () => void }) => void;
    };
    readonly updateProvider: (input: { id: string; body: ProviderMutationBody }) => void;
    readonly createProvider: (body: ProviderMutationBody, options?: { readonly onSuccess?: () => void }) => void;
    readonly navigate: (opts: { to: '/providers/$id/edit'; params: { id: string }; replace: true }) => unknown;
    readonly saveBlocked: boolean;
  },
) => {
  const serializeMode = ctx.mode === ProviderFormMode.Create ? 'create' : 'edit';
  const wireValues = {
    ...ctx.values,
    alias:
      ctx.values.kind === 'oauth'
        ? serializeOAuthAlias(ctx.values.alias ?? [], ctx.values.pluginAliasInherit === false, serializeMode)
        : ctx.values.alias === undefined
          ? undefined
          : serializeAlias(ctx.values.alias, serializeMode),
  };
  if (ctx.kind === 'oauth' && ctx.mode === ProviderFormMode.Create && !ctx.authorized) {
    if (ctx.accountForm.state.isValid === false) return;
    ctx.openPopup();
    startCreateAuthorization(
      wireValues,
      ctx.accountValues,
      ctx.capabilities,
      ctx.startMutation.mutate,
      ctx.closeUnclaimedPopup,
    );
    return;
  }
  if (ctx.saveBlocked) return;
  if (ctx.kind === 'oauth') {
    if (ctx.oauth === undefined) return;
    saveOAuthProvider(
      wireValues,
      ctx.accountValues,
      ctx.oauth,
      forceReauthorize,
      ctx.updateProvider,
      (input, options) => {
        if (ctx.accountForm.state.isValid === false) return;
        ctx.openPopup();
        ctx.startMutation.mutate(input, options);
      },
      ctx.closeUnclaimedPopup,
    );
    return;
  }
  saveConfigProvider(
    ctx.mode,
    wireValues,
    ctx.providerId,
    ctx.createProvider,
    ctx.updateProvider,
    (id) => void ctx.navigate({ to: '/providers/$id/edit', params: { id }, replace: true }),
  );
};

const saveConfigProvider = (
  mode: ProviderFormMode,
  values: ProviderEditorWire,
  providerId: string | undefined,
  createProvider: (body: ProviderMutationBody, options?: { readonly onSuccess?: () => void }) => void,
  updateProvider: (input: { id: string; body: ProviderMutationBody }) => void,
  onCreated: (id: string) => void,
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
  const body = result.data;
  if (mode === ProviderFormMode.Create) {
    createProvider(body, {
      onSuccess: () => onCreated(body.id),
    });
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
  readonly initial?: ProviderEditorInitial | undefined;
  readonly oauth?: DashboardOAuthProviderEdit | undefined;
  readonly provider?: OAuthProvider | undefined;
  readonly sessionId?: string | undefined;
  readonly onSessionIdChange: (sessionId: string | undefined) => void;
}

const editorSectionInput = (
  values: ProviderEditorShape,
  kind: ProviderKind,
  mode: ProviderFormMode,
  extras: {
    readonly aliasIssues: SectionStatusInput['aliasIssues'];
    readonly authorized: boolean;
    readonly capabilityKey: string;
    readonly discoveredModels: readonly string[] | undefined;
    readonly excludedModels?: readonly string[] | undefined;
    readonly hasApiKey: boolean;
    readonly models: readonly string[];
    readonly others: Parameters<typeof hasWeightTie>[0]['others'];
    readonly optionsValid: boolean;
    readonly transformsValid: boolean;
    readonly transformCount: number;
    readonly pluginAliases?: ProviderAlias | undefined;
  },
): SectionStatusInput => ({
  kind: values.kind ?? kind,
  mode,
  id: values.id ?? '',
  ...(values.kind === 'api'
    ? {
        baseURL: values.baseURL,
        protocol: values.protocol,
        endpoints: values.endpoints,
        apiKey: values.apiKey,
        hasApiKey: extras.hasApiKey,
      }
    : {}),
  capabilityKey: extras.capabilityKey,
  authorized: extras.authorized,
  packageName: values.kind === 'ai-sdk' ? values.packageName : undefined,
  models: extras.models,
  excludedModels: extras.excludedModels,
  discoveredModels: extras.discoveredModels,
  aliasCount: (values.alias ?? []).length,
  aliasIssues: extras.aliasIssues,
  transformsValid: extras.transformsValid,
  transformCount: extras.transformCount,
  weightTie: hasWeightTie({
    selfId: values.id ?? '',
    selfWeight: values.weight,
    exposedAliases: modelRoutes({
      enabled: true,
      models:
        kind === 'oauth'
          ? oauthEditorExposedModels(extras.discoveredModels, extras.excludedModels)
          : exposedModels(extras.models, extras.discoveredModels),
      alias:
        kind === 'oauth'
          ? editorEffectiveAlias(
              values.alias ?? [],
              extras.pluginAliases,
              oauthEditorExposedModels(extras.discoveredModels, extras.excludedModels),
              values.kind === 'oauth' && values.pluginAliasInherit === false,
            )
          : values.alias === undefined
            ? undefined
            : toAliasRecord(values.alias),
    }).map((route) => route.alias),
    others: extras.others,
  }),
  enabled: values.enabled,
  priority: values.priority,
  weight: values.weight,
  headerCount: values.kind === 'api' ? Object.keys(values.headers ?? {}).length : 0,
  proxyCustom: values.proxy !== undefined && values.proxy !== null,
  optionsValid: extras.optionsValid,
});

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
  const onSessionSucceeded = useCallback(() => {
    accountForm.setFieldValue('secrets', {});
    accountForm.setFieldValue('clearSecrets', []);
    if (oauth !== undefined) accountForm.setFieldValue('publicValues', oauth.publicValues);
    if (initial !== undefined) {
      form.reset({
        ...initial,
        kind,
        alias:
          initial.alias === undefined
            ? undefined
            : kind === 'oauth'
              ? toOAuthAliasRows(initial.alias)
              : toAliasRows(initial.alias as ProviderAlias),
        ...(kind === 'oauth'
          ? {
              excludedModels: 'excludedModels' in initial ? (initial.excludedModels ?? []) : [],
              pluginAliasInherit: !isOAuthInheritOff(initial.alias),
            }
          : {}),
      } as ProviderEditorShape);
    }
  }, [accountForm, form, initial, kind, oauth]);
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
  } = useOAuthEditorSession(mode, sessionId, onSessionIdChange, providerId, onSessionSucceeded);

  const { mutate: createProvider, isPending: isCreating } = useProviderCreate();
  const { mutate: updateProvider, isPending: isUpdating } = useProviderUpdate();
  const capabilitiesQuery = useQuery(oauthCapabilitiesQueryOptions());
  const summariesQuery = useQuery(providersQueryOptions());

  const values = useSelector(form.store, (state) => state.values);
  const accountValues = useSelector(accountForm.store, (state) => state.values);
  const capabilities = capabilitiesQuery.data?.capabilities ?? [];
  const others = summariesQuery.data?.providers ?? [];
  const models = values.kind === 'oauth' ? [] : (values.models ?? []);
  const excludedModels = values.kind === 'oauth' ? (values.excludedModels ?? []) : undefined;
  const oauthExposed = kind === 'oauth' ? oauthEditorExposedModels(oauth?.models, excludedModels) : undefined;
  const aliasIssues = aliasEditorIssues(values.alias ?? [], oauthExposed ?? models);
  const authorized =
    mode === ProviderFormMode.Edit || authorizedProviderId !== undefined || session?.status === 'succeeded';
  const transforms = values.transforms as ProviderTransforms | undefined;
  const hasApiKey = initial !== undefined && 'apiKey' in initial && (initial.apiKey ?? '') !== '';
  const summaries = sectionStatuses(
    editorSectionInput(values, kind, mode, {
      aliasIssues,
      authorized,
      capabilityKey: accountValues.capabilityKey,
      discoveredModels: oauth?.models,
      excludedModels,
      hasApiKey,
      models,
      pluginAliases: oauth?.pluginAliases,
      others,
      optionsValid,
      transformsValid,
      transformCount: transforms?.request?.length ?? 0,
    }),
  );

  const saveBlocked = blockingSections(summaries).length > 0;
  const handleKindChange = (next: ProviderKind) => {
    onKindChange?.(next);
    setOptionsValid(next !== 'ai-sdk');
    const nextValues = { ...form.state.values, kind: next } as ProviderEditorShape;
    form.reset(nextValues);
    form.setFieldValue('kind', next);
  };

  const save = (forceReauthorize = false) =>
    saveEditor(forceReauthorize, {
      values,
      kind,
      mode,
      authorized,
      accountForm,
      accountValues,
      capabilities,
      oauth,
      providerId,
      initial,
      openPopup,
      closeUnclaimedPopup,
      startMutation,
      updateProvider,
      createProvider,
      navigate,
      saveBlocked,
    });

  const title = editorTitle(mode, values.name);
  const subtitle =
    mode === ProviderFormMode.Create
      ? m['dashboard.providers.editor.header_create_subtitle']()
      : `${PROVIDER_KIND_LABEL[kind]} · ${providerId ?? values.id}`;

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
    saveBlocked,
    isReauthorizing: startMutation.isPending,
    pending: isCreating || isUpdating || startMutation.isPending,
    primaryLabel: m['dashboard.providers.editor.footer_save'](),
    title,
    subtitle,
    navigate,
  };
};
