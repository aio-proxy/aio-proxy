import type { AiSdkProviderMutationBody, ApiProviderMutationBody } from "@aio-proxy/types";
import { AiSdkProviderMutationBodySchema, ApiProviderMutationBodySchema } from "@aio-proxy/types";
import { useForm } from "@tanstack/react-form";

type UseProviderFormOptions = {
  mode: "create" | "edit";
  kind: "api" | "ai-sdk";
  initial?: Partial<ApiProviderMutationBody> | Partial<AiSdkProviderMutationBody>;
};

// ponytail: @tanstack/zod-form-adapter is not installed; a plain safeParse validator
// covers the same ground. Add the adapter only if field-level Zod wiring is needed.
export function useProviderForm({ kind, initial }: UseProviderFormOptions) {
  const schema = kind === "api" ? ApiProviderMutationBodySchema : AiSdkProviderMutationBodySchema;

  return useForm({
    defaultValues: initial ?? ({} as ApiProviderMutationBody | AiSdkProviderMutationBody),
    validators: {
      onChange: ({ value }) => {
        const result = schema.safeParse(value);
        return result.success ? undefined : result.error.issues.map((issue) => issue.message).join(", ");
      },
    },
  });
}
