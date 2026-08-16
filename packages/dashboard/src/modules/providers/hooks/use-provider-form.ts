import type { AiSdkProviderMutationBody, ApiProviderMutationBody } from '@aio-proxy/types';
import { AiSdkProviderMutationBodySchema, ApiProviderMutationBodySchema, ProviderKind } from '@aio-proxy/types';
import type { ReactFormExtendedApi } from '@tanstack/react-form';

type ProviderFormValues = ApiProviderMutationBody | AiSdkProviderMutationBody;
export type ProviderFormShape = ProviderFormValues extends infer Provider
  ? Provider extends ProviderFormValues
    ? Omit<Provider, 'transforms'> & { readonly transforms?: unknown; readonly validationModel?: string }
    : never
  : never;
export type ProviderFormInitial = Partial<ProviderFormValues>;

export function normalizeProviderFormValue(value: ProviderFormShape): unknown {
  const { validationModel: _validationModel, ...provider } = value;
  return provider;
}

export function parseProviderFormInitial(value: unknown): ProviderFormInitial | undefined {
  if (value === null || typeof value !== 'object' || !('kind' in value)) return undefined;
  let schema: typeof ApiProviderMutationBodySchema | typeof AiSdkProviderMutationBodySchema | undefined;
  if (value.kind === ProviderKind.Api) schema = ApiProviderMutationBodySchema;
  else if (value.kind === ProviderKind.AiSdk) schema = AiSdkProviderMutationBodySchema;
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
