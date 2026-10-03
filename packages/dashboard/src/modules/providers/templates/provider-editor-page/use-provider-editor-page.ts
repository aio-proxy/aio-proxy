import { m } from '@aio-proxy/i18n';
import {
  type DashboardOAuthProviderEdit,
  type OAuthProvider,
  type ProviderAlias,
  type ProviderKind,
  type ProviderTransforms,
} from '@aio-proxy/types';
import { useQuery } from '@tanstack/react-query';
import { useSelector } from '@tanstack/react-store';
import { omit } from 'es-toolkit/object';
import { useCallback, useState } from 'react';

import { useOAuthProviderForm } from '../../hooks/use-oauth-provider-form';
import {
  type ProviderEditorInitial,
  type ProviderEditorShape,
  useProviderEditorForm,
} from '../../hooks/use-provider-editor-form';
import { useProviderCreate, useProviderUpdate } from '../../hooks/use-provider-mutations';
import { isOAuthInheritOff, toAliasRows, toOAuthAliasRows } from '../../lib/alias-editor';
import { ProviderFormMode } from '../../lib/constants';
import { editorSectionInput } from '../../lib/editor-section-input';
import { capabilityKey } from '../../lib/oauth-capability-key';
import { blockingSections, sectionOrder, sectionStatuses } from '../../lib/section-status';
import { oauthCapabilitiesQueryOptions } from '../../services/oauth-service';
import type { ProviderSyncView } from '../../services/providers-service';
import { saveEditor } from './editor-submission';
import { useOAuthEditorSession } from './use-oauth-editor-session';

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
  readonly sync?: ProviderSyncView | undefined;
  readonly sessionId?: string | undefined;
  readonly onSessionIdChange: (sessionId: string | undefined) => void;
}

const nameAfterOAuthSuccess = (
  form: ReturnType<typeof useProviderEditorForm>,
  oauth: DashboardOAuthProviderEdit | undefined,
): string => {
  const currentName = form.state.values.name?.trim() ?? '';
  if (currentName !== '') return currentName;
  return oauth?.accountLabel.trim() ?? '';
};

const resetEditorAfterOAuthSuccess = (
  form: ReturnType<typeof useProviderEditorForm>,
  initial: ProviderEditorInitial | undefined,
  kind: ProviderKind,
  oauth: DashboardOAuthProviderEdit | undefined,
) => {
  const name = nameAfterOAuthSuccess(form, oauth);
  if (initial === undefined) {
    if (name !== '') form.setFieldValue('name', name);
    return;
  }
  form.reset({
    ...initial,
    kind,
    ...(name !== '' ? { name } : {}),
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
  if (name !== '') form.setFieldValue('name', name);
};

export const useProviderEditorPage = ({
  mode,
  kind,
  onKindChange,
  providerId,
  initial,
  oauth,
  provider,
  sync,
  sessionId,
  onSessionIdChange,
}: ProviderEditorPageProps) => {
  const [optionsValid, setOptionsValid] = useState(kind !== 'ai-sdk');
  const [transformsValid, setTransformsValid] = useState(true);
  const [draftCatalog, setDraftCatalog] = useState<ProviderSyncView>();
  const catalog = draftCatalog ?? sync;
  const candidates = draftCatalog?.models ?? oauth?.models ?? sync?.models;
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
  const onSessionSucceeded = useCallback(
    (refreshed?: DashboardOAuthProviderEdit) => {
      accountForm.setFieldValue('secrets', {});
      accountForm.setFieldValue('clearSecrets', []);
      if (refreshed !== undefined) accountForm.setFieldValue('publicValues', refreshed.publicValues);
      resetEditorAfterOAuthSuccess(form, initial, kind, refreshed);
    },
    [accountForm, form, initial, kind],
  );
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

  const values = useSelector(form.store, (state) => state.values);
  const accountValues = useSelector(accountForm.store, (state) => state.values);
  const capabilities = capabilitiesQuery.data?.capabilities ?? [];
  const authorized =
    mode === ProviderFormMode.Edit || authorizedProviderId !== undefined || session?.status === 'succeeded';
  const transforms = values.transforms as ProviderTransforms | undefined;
  const hasApiKey = initial !== undefined && 'apiKey' in initial && (initial.apiKey ?? '') !== '';
  const summaries = sectionStatuses(
    editorSectionInput(values, kind, mode, {
      authorized,
      capabilityKey: accountValues.capabilityKey,
      discoveredModels: candidates,
      hasApiKey,
      optionsValid,
      transformsValid,
      transformCount: transforms?.request?.length ?? 0,
    }),
  );

  const saveBlocked = blockingSections(summaries, sectionOrder(kind)).length > 0;
  const handleKindChange = (next: ProviderKind) => {
    onKindChange?.(next);
    setOptionsValid(next !== 'ai-sdk');
    setDraftCatalog(undefined);
    const nextValues = {
      ...omit({ ...form.state.values, syncModels: undefined }, ['syncModels', 'excludedModels']),
      kind: next,
    } as ProviderEditorShape;
    form.reset(nextValues);
    form.setFieldValue('kind', next);
  };

  const save = (forceReauthorize = false, localSignIn = false) =>
    saveEditor(forceReauthorize || localSignIn, {
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
      localSignIn,
      openPopup,
      closeUnclaimedPopup,
      startMutation,
      updateProvider,
      createProvider,
      navigate,
      saveBlocked,
    });

  const title = editorTitle(mode, values.name);
  return {
    form,
    accountForm,
    candidates,
    refreshedAt: catalog?.refreshedAt,
    onCatalogLoaded: setDraftCatalog,
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
    navigate,
  };
};
