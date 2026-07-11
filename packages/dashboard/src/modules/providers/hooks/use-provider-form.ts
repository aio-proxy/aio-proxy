import type { AiSdkProviderMutationBody, ApiProviderMutationBody, ProviderKind } from "@aio-proxy/types";
import { AiSdkProviderMutationBodySchema, ApiProviderMutationBodySchema } from "@aio-proxy/types";
import { useForm } from "@tanstack/react-form";
import type { ProviderFormMode } from "../constants";

type ProviderFormValues = ApiProviderMutationBody | AiSdkProviderMutationBody;

type UseProviderFormOptions = {
  mode: ProviderFormMode;
  kind: ProviderKind;
  initial?: Partial<ApiProviderMutationBody> | Partial<AiSdkProviderMutationBody> | undefined;
  onSubmit?: ((value: ProviderFormValues) => void | Promise<void>) | undefined;
};

// ponytail: @tanstack/zod-form-adapter is not installed; a plain safeParse validator
// covers the same ground. Add the adapter only if field-level Zod wiring is needed.
export function useProviderForm({ kind, initial, onSubmit }: UseProviderFormOptions) {
  const schema = kind === "api" ? ApiProviderMutationBodySchema : AiSdkProviderMutationBodySchema;

  return useForm({
    defaultValues: { ...(initial ?? {}), kind } as ProviderFormValues,
    validators: {
      onChange: ({ value }) => {
        const result = schema.safeParse(value);
        return result.success ? undefined : result.error.issues.map((issue) => issue.message).join(", ");
      },
    },
    onSubmit: async ({ value }) => {
      if (onSubmit) {
        await onSubmit(value);
      }
    },
  });
}
