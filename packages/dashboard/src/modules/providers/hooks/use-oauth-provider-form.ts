import { type DashboardOAuthSessionStart, DashboardOAuthSessionStartSchema } from "@aio-proxy/types";
import { useForm } from "@tanstack/react-form";
import { z } from "zod";

export interface OAuthProviderFormValues {
  readonly capabilityKey: string;
  readonly publicValues: DashboardOAuthSessionStart["publicValues"];
  readonly secrets: DashboardOAuthSessionStart["secrets"];
  readonly clearSecrets: readonly string[];
  readonly jsonValues: Readonly<Record<string, string>>;
}

const OAuthJsonValuesSchema = z.record(
  z.string(),
  z.string().refine((value) => {
    if (value === "") return true;
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }),
);

export const useOAuthProviderForm = (
  onSubmit: (value: OAuthProviderFormValues) => void,
  initial?: Partial<OAuthProviderFormValues>,
) =>
  useForm({
    defaultValues: {
      capabilityKey: "",
      publicValues: {},
      secrets: {},
      clearSecrets: [],
      jsonValues: {},
      ...initial,
    } as OAuthProviderFormValues,
    validators: {
      onChange: ({ value }) => {
        const session = DashboardOAuthSessionStartSchema.safeParse({
          targetProviderId: "form-validation",
          publicValues: value.publicValues,
          secrets: value.secrets,
          clearSecrets: value.clearSecrets,
        });
        const jsonValues = OAuthJsonValuesSchema.safeParse(value.jsonValues);
        return session.success && jsonValues.success ? undefined : "INVALID_OAUTH_ACCOUNT_OPTIONS";
      },
    },
    onSubmit: ({ value }) => onSubmit(value),
  });
