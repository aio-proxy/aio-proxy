import {
  type OAuthProviderMutationBody,
  OAuthProviderMutationBodySchema,
  type ProviderAlias,
  type ProviderTransforms,
} from '@aio-proxy/types';
import { type ReactFormExtendedApi, useForm } from '@tanstack/react-form';

export interface OAuthProviderCommonFormValues {
  readonly id: string;
  readonly name?: string | undefined;
  readonly enabled: boolean;
  readonly weight?: number | undefined;
  readonly proxy?: OAuthProviderMutationBody['proxy'];
  readonly alias?: ProviderAlias | undefined;
  readonly transforms?: ProviderTransforms | undefined;
  readonly models: readonly string[];
}

type OAuthProviderEditFormShape = Omit<OAuthProviderCommonFormValues, 'transforms'> & {
  readonly transforms?: unknown;
};

export type OAuthProviderEditForm = ReactFormExtendedApi<
  OAuthProviderEditFormShape,
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

const parseOAuthProviderEditValue = (value: OAuthProviderEditFormShape) => {
  const proxy = value.proxy === '****' ? undefined : value.proxy;
  return OAuthProviderMutationBodySchema.safeParse({
    kind: 'oauth',
    id: value.id,
    name: value.name,
    enabled: value.enabled,
    weight: value.weight,
    ...(proxy === undefined ? {} : { proxy }),
    alias: value.alias,
    transforms: value.transforms,
  });
};

export const useOAuthProviderEditForm = (
  initial: OAuthProviderCommonFormValues,
  onSubmit: (value: OAuthProviderCommonFormValues) => void,
) =>
  useForm({
    // TanStack Form cannot instantiate the recursive JSON shape; Zod narrows it again on submit.
    defaultValues: initial as OAuthProviderEditFormShape,
    validators: {
      onChange: ({ value }) => {
        const result = parseOAuthProviderEditValue(value);
        return result.success ? undefined : result.error.issues.map((issue) => issue.message).join(', ');
      },
    },
    onSubmit: ({ value }) => {
      const result = parseOAuthProviderEditValue(value);
      if (result.success) onSubmit({ ...value, proxy: result.data.proxy, transforms: result.data.transforms });
    },
  }) as unknown as OAuthProviderEditForm;
