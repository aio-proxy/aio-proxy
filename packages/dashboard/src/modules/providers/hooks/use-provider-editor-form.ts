import type { OAuthProviderMutationBody, ProviderAlias, ProviderKind } from '@aio-proxy/types';
import { type ReactFormExtendedApi, useForm } from '@tanstack/react-form';
import { useState } from 'react';

import { type AliasRow, toAliasRows } from '../lib/alias-editor';
import { apiDraftFromProvider, emptySharedDraft } from '../lib/api-endpoints';
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
  readonly models?: readonly string[] | undefined;
  readonly validationModel?: string | undefined;
};

type WithEditorAlias<T> = Omit<T, 'alias'> & { readonly alias?: readonly AliasRow[] | undefined };

export type ProviderEditorShape =
  | WithEditorAlias<Extract<ProviderFormShape, { kind: ProviderKind.Api }>>
  | WithEditorAlias<Extract<ProviderFormShape, { kind: ProviderKind.AiSdk }>>
  | OAuthEditorShape;

export type ProviderEditorInitial = Omit<Partial<ProviderEditorShape>, 'alias'> & {
  readonly alias?: ProviderAlias | undefined;
};

type WithWireAlias<T> = Omit<T, 'alias'> & { readonly alias?: ProviderAlias | undefined };

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
        ...(kind === 'api' && initial?.endpoints === undefined
          ? { endpoints: apiDraftFromProvider({ ...initial, kind }) ?? emptySharedDraft() }
          : {}),
        alias: initial?.alias === undefined ? undefined : toAliasRows(initial.alias),
      }) as ProviderEditorShape,
  );
  return useForm({
    defaultValues,
  }) as unknown as ProviderEditorForm;
}
