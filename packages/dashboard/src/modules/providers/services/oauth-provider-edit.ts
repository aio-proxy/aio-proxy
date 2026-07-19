import type { DashboardOAuthSessionStart, OAuthProviderMutationBody, ProviderAlias } from "@aio-proxy/types";
import { isEqual } from "es-toolkit";

export interface OAuthProviderEditValues {
  readonly id: string;
  readonly name?: string;
  readonly enabled: boolean;
  readonly weight?: number;
  readonly alias?: ProviderAlias;
  readonly publicValues: DashboardOAuthSessionStart["publicValues"];
  readonly secrets: DashboardOAuthSessionStart["secrets"];
  readonly clearSecrets: readonly string[];
}

type OAuthProviderEditAction =
  | { readonly kind: "update"; readonly body: OAuthProviderMutationBody }
  | { readonly kind: "reauthorize"; readonly input: DashboardOAuthSessionStart };

export const oauthProviderEditAction = (
  values: OAuthProviderEditValues,
  initialPublicValues: DashboardOAuthSessionStart["publicValues"],
  forceReauthorize = false,
): OAuthProviderEditAction => {
  const providerPatch = {
    ...(values.name === undefined ? {} : { name: values.name }),
    enabled: values.enabled,
    ...(values.weight === undefined ? {} : { weight: values.weight }),
    ...(values.alias === undefined ? {} : { alias: values.alias }),
  };
  const secrets = Object.fromEntries(Object.entries(values.secrets).filter(([, value]) => value !== ""));
  const requiresReauthorization =
    forceReauthorize ||
    !isEqual(values.publicValues, initialPublicValues) ||
    Object.keys(secrets).length > 0 ||
    values.clearSecrets.length > 0;

  if (requiresReauthorization) {
    return {
      kind: "reauthorize",
      input: {
        targetProviderId: values.id,
        publicValues: values.publicValues,
        secrets,
        clearSecrets: [...values.clearSecrets],
        providerPatch,
      },
    };
  }

  return { kind: "update", body: { kind: "oauth", id: values.id, ...providerPatch } };
};
