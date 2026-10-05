import { m } from '@aio-proxy/i18n';
import {
  type DashboardOAuthCapability,
  type DashboardOAuthProviderEdit,
  type DashboardOAuthSessionStart,
  dashboardOAuthCompleteUrl,
  type ProviderKind,
  type ProviderMutationBody,
  type ProviderTransforms,
  ProviderMutationBodySchema,
} from '@aio-proxy/types';
import { toast } from '@aio-proxy/ui/components/toast';

import type {
  ProviderEditorInitial,
  ProviderEditorShape,
  ProviderEditorWire,
} from '../../hooks/use-provider-editor-form';
import { serializeAlias, serializeOAuthAlias } from '../../lib/alias-editor';
import { ProviderFormMode } from '../../lib/constants';
import { oauthAccountSubmission } from '../../lib/oauth-account-submission';
import { capabilityKey } from '../../lib/oauth-capability-key';
import { oauthProviderEditAction } from '../../lib/oauth-provider-edit';
import { normalizeProviderFormValue, type ProviderFormShape } from '../../lib/provider-form-value';

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
  localSignIn: boolean,
) => {
  const selected = capabilities.find((candidate) => capabilityKey(candidate) === accountValues.capabilityKey);
  if (selected === undefined) return;
  const account = oauthAccountSubmission(selected.form, accountDraft(accountValues));
  mutate(
    {
      capability: { plugin: selected.plugin, capability: selected.capability },
      ...(localSignIn ? { localSignIn: true } : {}),
      ...account,
      clearSecrets: [...account.clearSecrets],
      ...(dashboardOAuthCompleteUrl(window.location.origin) === undefined
        ? {}
        : { completeUrl: dashboardOAuthCompleteUrl(window.location.origin) }),
      providerPatch: {
        enabled: true,
        ...(values.name === undefined || values.name.trim() === '' ? {} : { name: values.name.trim() }),
        ...(values.proxy === undefined ? {} : { proxy: values.proxy }),
        ...(values.proxyBackup === undefined ? {} : { proxyBackup: values.proxyBackup }),
        ...(values.proxyFallback === undefined ? {} : { proxyFallback: values.proxyFallback }),
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

export const saveEditor = (
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
    readonly localSignIn: boolean;
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
    if (!ctx.localSignIn) ctx.openPopup();
    startCreateAuthorization(
      wireValues,
      ctx.accountValues,
      ctx.capabilities,
      ctx.startMutation.mutate,
      ctx.closeUnclaimedPopup,
      ctx.localSignIn,
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
        if (!ctx.localSignIn) ctx.openPopup();
        ctx.startMutation.mutate({ ...input, ...(ctx.localSignIn ? { localSignIn: true } : {}) }, options);
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
