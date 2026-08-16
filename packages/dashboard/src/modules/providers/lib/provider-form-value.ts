import type { AiSdkProviderMutationBody, ApiProviderMutationBody } from '@aio-proxy/types';
import { AiSdkProviderMutationBodySchema, ApiProviderMutationBodySchema, ProviderKind } from '@aio-proxy/types';

// The provider editor's form *value*, and the two conversions at its edges: `parseProviderFormInitial`
// on the way in from a route loader, `normalizeProviderFormValue` on the way out to a mutation body.
// No hook and no network — the form itself lives in `hooks/use-provider-editor-form.ts`.

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
