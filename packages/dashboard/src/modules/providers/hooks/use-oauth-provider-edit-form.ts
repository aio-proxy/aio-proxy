import { OAuthProviderMutationBodySchema, type ProviderAlias } from "@aio-proxy/types";
import { useForm } from "@tanstack/react-form";

export interface OAuthProviderCommonFormValues {
  readonly id: string;
  readonly name?: string;
  readonly enabled: boolean;
  readonly weight?: number;
  readonly alias?: ProviderAlias;
  readonly models: readonly string[];
}

export const useOAuthProviderEditForm = (
  initial: OAuthProviderCommonFormValues,
  onSubmit: (value: OAuthProviderCommonFormValues) => void,
) =>
  useForm({
    defaultValues: initial,
    validators: {
      onChange: ({ value }) => {
        const result = OAuthProviderMutationBodySchema.safeParse({
          kind: "oauth",
          id: value.id,
          name: value.name,
          enabled: value.enabled,
          weight: value.weight,
          alias: value.alias,
        });
        return result.success ? undefined : result.error.issues.map((issue) => issue.message).join(", ");
      },
    },
    onSubmit: ({ value }) => onSubmit(value),
  });
