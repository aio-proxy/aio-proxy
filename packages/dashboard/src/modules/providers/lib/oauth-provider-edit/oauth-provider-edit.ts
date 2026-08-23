import {
  type DashboardOAuthSessionStart,
  dashboardOAuthCompleteUrl,
  type ModelMetadata,
  type OAuthProviderMutationBody,
  ProviderKind,
  type ProviderAlias,
  type ProviderTransforms,
} from '@aio-proxy/types';
import { isEqual } from 'es-toolkit';

export interface OAuthProviderEditValues {
  readonly id: string;
  readonly name?: string | undefined;
  readonly enabled: boolean;
  readonly priority?: number | undefined;
  readonly weight?: number | undefined;
  readonly proxy?: OAuthProviderMutationBody['proxy'];
  readonly alias?: ProviderAlias | undefined;
  readonly models?: readonly string[] | undefined;
  readonly transforms?: ProviderTransforms | undefined;
  readonly metadata?: Record<string, ModelMetadata> | undefined;
  readonly publicValues: DashboardOAuthSessionStart['publicValues'];
  readonly secrets: DashboardOAuthSessionStart['secrets'];
  readonly clearSecrets: readonly string[];
}

type OAuthProviderEditAction =
  | { readonly kind: 'update'; readonly body: OAuthProviderMutationBody }
  | { readonly kind: 'reauthorize'; readonly input: DashboardOAuthSessionStart };

export const oauthProviderEditAction = (
  values: OAuthProviderEditValues,
  initialPublicValues: DashboardOAuthSessionStart['publicValues'],
  forceReauthorize = false,
): OAuthProviderEditAction => {
  const providerPatch = {
    ...(values.name === undefined ? {} : { name: values.name }),
    enabled: values.enabled,
    ...(values.priority === undefined ? {} : { priority: values.priority }),
    ...(values.weight === undefined ? {} : { weight: values.weight }),
    ...(values.proxy === undefined ? {} : { proxy: values.proxy }),
    ...(values.alias === undefined ? {} : { alias: values.alias }),
    ...(values.models === undefined ? {} : { models: [...values.models] }),
    ...(values.transforms === undefined ? {} : { transforms: values.transforms }),
    // Always present, both branches: the editor owns the whole map, and a save that reauthorizes
    // must carry the metadata edits made alongside the credential change instead of dropping them.
    metadata: values.metadata ?? {},
  };
  const secrets = Object.fromEntries(Object.entries(values.secrets).filter(([, value]) => value !== ''));
  const requiresReauthorization =
    forceReauthorize ||
    !isEqual(values.publicValues, initialPublicValues) ||
    Object.keys(secrets).length > 0 ||
    values.clearSecrets.length > 0;

  if (requiresReauthorization) {
    return {
      kind: 'reauthorize',
      input: {
        targetProviderId: values.id,
        publicValues: values.publicValues,
        secrets,
        clearSecrets: [...values.clearSecrets],
        ...(dashboardOAuthCompleteUrl(window.location.origin) === undefined
          ? {}
          : { completeUrl: dashboardOAuthCompleteUrl(window.location.origin) }),
        providerPatch,
      },
    };
  }

  return {
    kind: 'update',
    body: { kind: ProviderKind.OAuth, id: values.id, ...providerPatch },
  };
};
