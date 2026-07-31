import type { AiSdkProviderMutationBody, ApiProviderMutationBody } from '@aio-proxy/types';
import { AiSdkProviderMutationBodySchema, ApiProviderMutationBodySchema, ProviderKind } from '@aio-proxy/types';
import { type ReactFormExtendedApi, useForm } from '@tanstack/react-form';

import type { ProviderFormMode } from '../constants';

type ProviderFormValues = ApiProviderMutationBody | AiSdkProviderMutationBody;
type ProviderFormShape = ProviderFormValues extends infer Provider
  ? Provider extends ProviderFormValues
    ? Omit<Provider, 'transforms'> & { readonly transforms?: unknown }
    : never
  : never;
export type ProviderFormInitial = Partial<ProviderFormValues>;

export function parseProviderFormInitial(value: unknown): ProviderFormInitial | undefined {
  if (value === null || typeof value !== 'object' || !('kind' in value)) return undefined;
  const schema =
    value.kind === ProviderKind.Api
      ? ApiProviderMutationBodySchema
      : value.kind === ProviderKind.AiSdk
        ? AiSdkProviderMutationBodySchema
        : undefined;
  if (schema === undefined) return undefined;
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

export type ProviderForm = ReactFormExtendedApi<
  ProviderFormShape,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>;

type UseProviderFormOptions = {
  mode: ProviderFormMode;
  kind: ProviderKind;
  initial?: ProviderFormInitial | undefined;
  onSubmit?: ((value: ProviderFormValues) => void | Promise<void>) | undefined;
};

// ponytail: @tanstack/zod-form-adapter is not installed; a plain safeParse validator
// covers the same ground. Add the adapter only if field-level Zod wiring is needed.
// ponytail: recursive transform JSON exceeds TanStack Form's TS2589 ceiling; consumers
// narrow it at the composite editor boundary while Zod remains authoritative here.
export function useProviderForm({ kind, initial, onSubmit }: UseProviderFormOptions): ProviderForm {
  const schema = kind === 'api' ? ApiProviderMutationBodySchema : AiSdkProviderMutationBodySchema;

  return useForm({
    defaultValues: { ...initial, kind } as ProviderFormShape,
    validators: {
      onChange: ({ value }) => {
        const result = schema.safeParse(value);
        return result.success ? undefined : result.error.issues.map((issue) => issue.message).join(', ');
      },
    },
    onSubmit: async ({ value }) => {
      const result = schema.safeParse(value);
      if (result.success && onSubmit) await onSubmit(result.data);
    },
  }) as unknown as ProviderForm;
}
