import type {
  ApiProviderMutationBody,
  AuthoredOAuthAlias,
  OAuthProviderMutationBody,
  ProviderAlias,
  ProviderKind,
} from '@aio-proxy/types';
import { type ReactFormExtendedApi, useForm } from '@tanstack/react-form';
import { useState } from 'react';

import { type AliasRow, isOAuthInheritOff, toAliasRows, toOAuthAliasRows } from '../lib/alias-editor';
import { type ApiEndpointDraft, apiDraftFromProvider, emptySharedDraft } from '../lib/api-endpoints';
import type { ProviderFormShape } from '../lib/provider-form-value';

/**
 * Provider-config fields only. The OAuth *account* fields (`capabilityKey`, `publicValues`,
 * `secrets`, `clearSecrets`, `jsonValues`) stay in `useOAuthProviderForm`, which defaults them;
 * mirroring them here would leave them `undefined` behind this hook's cast.
 */
export type OAuthEditorShape = {
  readonly kind: ProviderKind.OAuth;
  readonly id: string;
  readonly name?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly priority?: number | undefined;
  readonly weight?: number | undefined;
  readonly proxy?: OAuthProviderMutationBody['proxy'];
  readonly alias?: readonly AliasRow[] | undefined;
  readonly transforms?: unknown;
  readonly excludedModels?: readonly string[] | undefined;
  readonly pluginAliasInherit?: boolean | undefined;
  readonly validationModel?: string | undefined;
};

type WithEditorAlias<T> = Omit<T, 'alias'> & { readonly alias?: readonly AliasRow[] | undefined };

export type ProviderEditorShape =
  | WithEditorAlias<Extract<ProviderFormShape, { kind: ProviderKind.Api }>>
  | WithEditorAlias<Extract<ProviderFormShape, { kind: ProviderKind.AiSdk }>>
  | OAuthEditorShape;

/**
 * A route loader's parsed initial value: every arm's fields, all optional.
 *
 * Written out rather than derived. `Partial` distributes over a union but `Omit` does not —
 * `keyof (A | B)` is only the shared keys — so `Omit<Partial<ProviderEditorShape>, 'alias'>`
 * silently dropped `endpoints`, `protocol`, `baseURL`, `apiKey`, and `packageName`. Intersecting the
 * arms instead collapses each conflicting field to `never`, and a union of partials cannot be read
 * at all: union property access needs the key on every arm, and a loader has nothing to narrow on
 * yet.
 */
export type ProviderEditorInitial = {
  readonly kind?: ProviderKind | undefined;
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly priority?: number | undefined;
  readonly weight?: number | undefined;
  readonly proxy?: OAuthProviderMutationBody['proxy'];
  readonly models?: readonly string[] | undefined;
  readonly excludedModels?: readonly string[] | undefined;
  readonly transforms?: unknown;
  readonly validationModel?: string | undefined;
  readonly protocol?: ApiProviderMutationBody['protocol'];
  readonly baseURL?: ApiProviderMutationBody['baseURL'];
  readonly apiKey?: ApiProviderMutationBody['apiKey'];
  readonly endpoints?: ApiEndpointDraft | undefined;
  readonly packageName?: string | undefined;
  readonly options?: unknown;
  readonly alias?: ProviderAlias | AuthoredOAuthAlias | undefined;
};

type WithWireAlias<T> = Omit<T, 'alias'> & {
  readonly alias?: ProviderAlias | AuthoredOAuthAlias | undefined;
};

/** Form values after `save()` serializes alias rows back to the wire record. */
export type ProviderEditorWire =
  | WithWireAlias<Extract<ProviderFormShape, { kind: ProviderKind.Api }>>
  | WithWireAlias<Extract<ProviderFormShape, { kind: ProviderKind.AiSdk }>>
  | WithWireAlias<OAuthEditorShape>;

export type ProviderEditorForm = ReactFormExtendedApi<
  ProviderEditorShape,
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

type UseProviderEditorFormOptions = {
  readonly kind: ProviderKind;
  readonly initial?: ProviderEditorInitial | undefined;
};

// Seeding only: no validators and no onSubmit by design. Save gating reads form values through
// sectionStatuses, and body correctness is parsed at dispatch, so both would be inert here.
// ponytail: the `as unknown as` cast is load-bearing — recursive transform JSON exceeds TanStack
// Form's TS2589 ceiling, so consumers narrow it at the composite editor boundary while Zod stays
// authoritative at dispatch.
export function useProviderEditorForm({ kind, initial }: UseProviderEditorFormOptions): ProviderEditorForm {
  const [defaultValues] = useState(
    () =>
      ({
        ...initial,
        kind,
        ...(kind === 'api' && (initial === undefined || !('endpoints' in initial) || initial.endpoints === undefined)
          ? { endpoints: apiDraftFromProvider({ ...initial, kind }) ?? emptySharedDraft() }
          : {}),
        alias:
          initial?.alias === undefined
            ? undefined
            : kind === 'oauth'
              ? toOAuthAliasRows(initial.alias)
              : toAliasRows(initial.alias as ProviderAlias),
        ...(kind === 'oauth'
          ? {
              excludedModels:
                initial !== undefined && 'excludedModels' in initial ? (initial.excludedModels ?? []) : [],
              pluginAliasInherit: !isOAuthInheritOff(initial?.alias),
            }
          : {}),
      }) as ProviderEditorShape,
  );
  return useForm({
    defaultValues,
  }) as unknown as ProviderEditorForm;
}
