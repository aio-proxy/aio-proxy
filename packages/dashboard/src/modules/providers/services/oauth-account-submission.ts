import type { DashboardOAuthFormField, DashboardOAuthSessionStart } from "@aio-proxy/types";

interface OAuthAccountDraft {
  readonly publicValues: DashboardOAuthSessionStart["publicValues"];
  readonly secrets: DashboardOAuthSessionStart["secrets"];
  readonly clearSecrets: readonly string[];
}

export const oauthAccountSubmission = (
  fields: readonly DashboardOAuthFormField[],
  draft: OAuthAccountDraft,
): OAuthAccountDraft => {
  const combined = { ...draft.publicValues, ...draft.secrets };
  const visible = fields.filter((field) => field.when === undefined || combined[field.when.key] === field.when.equals);
  const publicKeys = new Set(visible.filter((field) => field.type !== "secret").map((field) => field.key));
  const secretKeys = new Set(visible.filter((field) => field.type === "secret").map((field) => field.key));
  return {
    publicValues: Object.fromEntries(
      Object.entries(draft.publicValues).filter(([key, value]) => publicKeys.has(key) && value !== undefined),
    ),
    secrets: Object.fromEntries(
      Object.entries(draft.secrets).filter(([key, value]) => secretKeys.has(key) && value !== ""),
    ),
    clearSecrets: draft.clearSecrets.filter((key) => secretKeys.has(key)),
  };
};
