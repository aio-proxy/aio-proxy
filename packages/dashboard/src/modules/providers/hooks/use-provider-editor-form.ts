import type { OAuthProviderMutationBody, ProviderAlias, ProviderKind } from '@aio-proxy/types';
import { type ReactFormExtendedApi, useForm } from '@tanstack/react-form';

import type { ProviderFormShape } from './use-provider-form';

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
  readonly weight?: number | undefined;
  readonly proxy?: OAuthProviderMutationBody['proxy'];
  readonly alias?: ProviderAlias | undefined;
  readonly transforms?: unknown;
  readonly models?: readonly string[] | undefined;
  // Keyed metadata, not Record<string, unknown>: this is fed to toModelRows.
  readonly metadata?: OAuthProviderMutationBody['metadata'];
  readonly validationModel?: string | undefined;
};

export type ProviderEditorShape = ProviderFormShape | OAuthEditorShape;

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
  readonly initial?: Partial<ProviderEditorShape> | undefined;
};

// Seeding only: no validators and no onSubmit by design. Save gating reads form values through
// sectionStatuses, and body correctness is parsed at dispatch, so both would be inert here.
// ponytail: the `as unknown as` cast is load-bearing — recursive transform JSON exceeds TanStack
// Form's TS2589 ceiling, so consumers narrow it at the composite editor boundary while Zod stays
// authoritative at dispatch.
export function useProviderEditorForm({ kind, initial }: UseProviderEditorFormOptions): ProviderEditorForm {
  return useForm({
    defaultValues: { ...initial, kind } as ProviderEditorShape,
  }) as unknown as ProviderEditorForm;
}
