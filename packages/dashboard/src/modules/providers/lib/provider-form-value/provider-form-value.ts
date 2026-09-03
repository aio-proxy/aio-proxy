import type { AiSdkProviderMutationBody, ApiProviderMutationBody } from '@aio-proxy/types';
import { AiSdkProviderMutationBodySchema, ApiProviderMutationBodySchema, ProviderKind } from '@aio-proxy/types';
import { omit } from 'es-toolkit/object';

import { apiDraftFromProvider, apiDraftToMutation, emptySharedDraft, type ApiEndpointDraft } from '../api-endpoints';

// The provider editor's form *value*, and the two conversions at its edges: `parseProviderFormInitial`
// on the way in from a route loader, `normalizeProviderFormValue` on the way out to a mutation body.
// No hook and no network — the form itself lives in `hooks/use-provider-editor-form.ts`.

type ProviderFormValues = ApiProviderMutationBody | AiSdkProviderMutationBody;
export type ProviderFormShape = ProviderFormValues extends infer Provider
  ? Provider extends ProviderFormValues
    ? Omit<Provider, 'transforms' | 'endpoints' | 'protocol' | 'baseURL'> & {
        readonly transforms?: unknown;
        readonly validationModel?: string;
        readonly protocol?: ApiProviderMutationBody['protocol'];
        readonly baseURL?: ApiProviderMutationBody['baseURL'];
        readonly endpoints?: ApiEndpointDraft;
        // Lifted onto both arms like the four above: switching kind carries the whole draft forward,
        // so an ai-sdk value really can hold an `apiKey` the normalizer then has to strip.
        readonly apiKey?: ApiProviderMutationBody['apiKey'];
      }
    : never
  : never;
export type ProviderFormInitial = Partial<ProviderFormShape>;

export function normalizeProviderFormValue(value: ProviderFormShape): unknown {
  const { validationModel: _validationModel, ...provider } = value;
  const withoutName = provider.name?.trim() === '' ? omit(provider, ['name']) : provider;
  if (withoutName.kind !== ProviderKind.Api) {
    return omit(withoutName, ['protocol', 'baseURL', 'endpoints', 'apiKey']);
  }
  const draft = withoutName.endpoints ?? apiDraftFromProvider(withoutName) ?? emptySharedDraft();
  const wired = apiDraftToMutation(draft);
  return {
    ...omit(withoutName, ['protocol', 'baseURL', 'endpoints']),
    ...wired,
  };
}

export function parseProviderFormInitial(value: unknown): ProviderFormInitial | undefined {
  if (value === null || typeof value !== 'object' || !('kind' in value)) return undefined;
  if (value.kind === ProviderKind.AiSdk) {
    const result = AiSdkProviderMutationBodySchema.safeParse(value);
    return result.success ? result.data : undefined;
  }
  if (value.kind !== ProviderKind.Api) return undefined;
  const result = ApiProviderMutationBodySchema.safeParse(value);
  if (!result.success) return undefined;
  return { ...result.data, endpoints: apiDraftFromProvider(result.data) };
}
