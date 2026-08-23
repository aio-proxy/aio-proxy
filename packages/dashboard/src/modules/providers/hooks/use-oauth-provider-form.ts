import {
  type DashboardOAuthProviderPatch,
  type DashboardOAuthSessionStart,
  DashboardOAuthSessionStartSchema,
} from '@aio-proxy/types';
import { type ReactFormExtendedApi, useForm } from '@tanstack/react-form';
import { z } from 'zod';

import { isValidJson } from '@/lib/json-form-value';

export interface OAuthProviderFormValues {
  readonly capabilityKey: string;
  readonly publicValues: DashboardOAuthSessionStart['publicValues'];
  readonly secrets: DashboardOAuthSessionStart['secrets'];
  readonly clearSecrets: readonly string[];
  readonly jsonValues: Readonly<Record<string, string>>;
  readonly proxy?: DashboardOAuthProviderPatch['proxy'];
}

// The form-api generic uses a non-recursive `publicValues` shape: zod's recursive JSONType
// otherwise makes `form.Field` instantiation excessively deep (TS2589). Consumers read/write
// field values through the field API, so the widened value type is inconsequential.
type OAuthProviderFormShape = Omit<OAuthProviderFormValues, 'publicValues'> & {
  readonly publicValues: Record<string, unknown>;
};

export type OAuthProviderForm = ReactFormExtendedApi<
  OAuthProviderFormShape,
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

const OAuthJsonValuesSchema = z.record(z.string(), z.string().refine(isValidJson));

export const useOAuthProviderForm = (
  onSubmit: (value: OAuthProviderFormValues) => void,
  initial?: Partial<OAuthProviderFormValues>,
): OAuthProviderForm =>
  useForm({
    defaultValues: {
      capabilityKey: '',
      publicValues: {},
      secrets: {},
      clearSecrets: [],
      jsonValues: {},
      ...initial,
    } as OAuthProviderFormValues,
    validators: {
      onChange: ({ value }) => {
        const session = DashboardOAuthSessionStartSchema.safeParse({
          targetProviderId: 'form-validation',
          publicValues: value.publicValues,
          secrets: value.secrets,
          clearSecrets: value.clearSecrets,
          providerPatch: {
            enabled: true,
            ...(value.proxy === undefined ? {} : { proxy: value.proxy }),
          },
        });
        const jsonValues = OAuthJsonValuesSchema.safeParse(value.jsonValues);
        return session.success && jsonValues.success ? undefined : 'INVALID_OAUTH_ACCOUNT_OPTIONS';
      },
    },
    onSubmit: ({ value }) => onSubmit(value),
  }) as unknown as OAuthProviderForm;
