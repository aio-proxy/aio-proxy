import {
  type AuthoredOAuthAlias,
  type DashboardOAuthSessionStart,
  dashboardOAuthCompleteUrl,
  type OAuthProviderMutationBody,
  ProviderKind,
  type ProviderTransforms,
} from '@aio-proxy/types';
import { isEqual } from 'es-toolkit/predicate';

export interface OAuthProviderEditValues {
  readonly id: string;
  readonly name?: string | undefined;
  readonly enabled: boolean;
  // The board owns these now, not this editor. They still travel with the patch because core rebuilds
  // the whole oauth entry from it and reads an omitted routing field as a clear, so a reauthorization
  // would otherwise reset priority to 0 and unpark a weight-zero Provider.
  readonly priority?: number | undefined;
  readonly weight?: number | undefined;
  readonly proxy?: OAuthProviderMutationBody['proxy'];
  readonly alias?: AuthoredOAuthAlias | undefined;
  readonly excludedModels?: readonly string[] | undefined;
  readonly transforms?: ProviderTransforms | undefined;
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
  const name = values.name?.trim();
  const providerPatch = {
    ...(name === undefined || name === '' ? {} : { name }),
    enabled: values.enabled,
    ...(values.priority === undefined ? {} : { priority: values.priority }),
    ...(values.weight === undefined ? {} : { weight: values.weight }),
    ...(values.proxy === undefined ? {} : { proxy: values.proxy }),
    alias: values.alias ?? {},
    excludedModels: [...(values.excludedModels ?? [])],
    ...(values.transforms === undefined ? {} : { transforms: values.transforms }),
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
