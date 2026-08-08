import type { AiSdkProviderMutationBody, ApiProviderMutationBody } from '@aio-proxy/types';
import { AiSdkProviderMutationBodySchema, ApiProviderMutationBodySchema, ProviderKind } from '@aio-proxy/types';
import { type ReactFormExtendedApi, useForm } from '@tanstack/react-form';

import { aliasEditorIssues } from '../lib/alias-editor';
import type { ProviderFormMode, ProviderFormStep } from '../lib/constants';

type ProviderFormValues = ApiProviderMutationBody | AiSdkProviderMutationBody;
export type ProviderEditorKind = ProviderKind.Api | ProviderKind.AiSdk;
type ProviderFormShape = ProviderFormValues extends infer Provider
  ? Provider extends ProviderFormValues
    ? Omit<Provider, 'transforms'> & { readonly transforms?: unknown; readonly validationModel?: string }
    : never
  : never;
export type ProviderFormInitial = Partial<ProviderFormValues>;

const ApiConnectionSchema = ApiProviderMutationBodySchema.pick({
  kind: true,
  id: true,
  name: true,
  protocol: true,
  baseURL: true,
  apiKey: true,
  headers: true,
  proxy: true,
});
const AiSdkConnectionSchema = AiSdkProviderMutationBodySchema.pick({
  kind: true,
  id: true,
  name: true,
  packageName: true,
  options: true,
  parseReasoningContent: true,
  proxy: true,
});
const ApiModelsSchema = ApiProviderMutationBodySchema.pick({ kind: true, models: true, metadata: true, alias: true });
const AiSdkModelsSchema = AiSdkProviderMutationBodySchema.pick({
  kind: true,
  models: true,
  metadata: true,
  alias: true,
});
const ApiRoutingSchema = ApiProviderMutationBodySchema.pick({
  kind: true,
  enabled: true,
  weight: true,
  transforms: true,
});
const AiSdkRoutingSchema = AiSdkProviderMutationBodySchema.pick({
  kind: true,
  enabled: true,
  weight: true,
  transforms: true,
});

export function normalizeProviderFormValue(value: ProviderFormShape): unknown {
  const { validationModel: _validationModel, ...provider } = value;
  if (provider.proxy !== '****') return provider;
  const { proxy: _proxy, ...withoutRedactedProxy } = provider;
  return withoutRedactedProxy;
}

export function parseProviderFormInitial(value: unknown): ProviderFormInitial | undefined {
  if (value === null || typeof value !== 'object' || !('kind' in value)) return undefined;
  const redactedProxy = 'proxy' in value && value.proxy === '****';
  const candidate = redactedProxy ? { ...value, proxy: undefined } : value;
  const schema =
    value.kind === ProviderKind.Api
      ? ApiProviderMutationBodySchema
      : value.kind === ProviderKind.AiSdk
        ? AiSdkProviderMutationBodySchema
        : undefined;
  if (schema === undefined) return undefined;
  const result = schema.safeParse(candidate);
  return result.success ? { ...result.data, ...(redactedProxy ? { proxy: '****' } : {}) } : undefined;
}

export function providerFormStepIsValid(
  kind: ProviderEditorKind,
  step: ProviderFormStep,
  value: ProviderFormShape,
): boolean {
  const normalized = normalizeProviderFormValue(value);
  if (step === 0) {
    return (kind === ProviderKind.Api ? ApiConnectionSchema : AiSdkConnectionSchema).safeParse(normalized).success;
  }
  if (step === 1) {
    const result = (kind === ProviderKind.Api ? ApiModelsSchema : AiSdkModelsSchema).safeParse(normalized);
    return result.success && aliasEditorIssues(result.data.alias ?? {}, result.data.models).length === 0;
  }
  if (step === 2) {
    return (kind === ProviderKind.Api ? ApiRoutingSchema : AiSdkRoutingSchema).safeParse(normalized).success;
  }
  return true;
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
  kind: ProviderEditorKind;
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
        const result = schema.safeParse(normalizeProviderFormValue(value));
        return result.success ? undefined : result.error.issues.map((issue) => issue.message).join(', ');
      },
    },
    onSubmit: async ({ value }) => {
      const result = schema.safeParse(normalizeProviderFormValue(value));
      if (result.success && onSubmit) await onSubmit(result.data);
    },
  }) as unknown as ProviderForm;
}
