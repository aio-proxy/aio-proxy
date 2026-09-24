import type { DashboardOAuthFormField, DashboardOAuthSessionStart } from '@aio-proxy/types';

import { formFieldVisible } from '@/lib/form-field-visible';

interface OAuthAccountDraft {
  readonly publicValues: DashboardOAuthSessionStart['publicValues'];
  readonly secrets: DashboardOAuthSessionStart['secrets'];
  readonly clearSecrets: readonly string[];
}

/** Stored values win. Absent keys still count as the field default for `when`. */
export const oauthFieldDefaults = (fields: readonly DashboardOAuthFormField[]): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    fields.flatMap((field) =>
      'defaultValue' in field && field.defaultValue !== undefined ? [[field.key, field.defaultValue] as const] : [],
    ),
  );

export const oauthAccountSubmission = (
  fields: readonly DashboardOAuthFormField[],
  draft: OAuthAccountDraft,
): OAuthAccountDraft => {
  const combined = { ...oauthFieldDefaults(fields), ...draft.publicValues, ...draft.secrets };
  const visible = fields.filter((field) => formFieldVisible(field, combined));
  const publicKeys = new Set(visible.filter((field) => field.type !== 'secret').map((field) => field.key));
  const secretKeys = new Set(visible.filter((field) => field.type === 'secret').map((field) => field.key));
  return {
    publicValues: Object.fromEntries(
      Object.entries(draft.publicValues).filter(([key, value]) => publicKeys.has(key) && value !== undefined),
    ),
    secrets: Object.fromEntries(
      Object.entries(draft.secrets).filter(([key, value]) => secretKeys.has(key) && value !== ''),
    ),
    clearSecrets: draft.clearSecrets.filter((key) => secretKeys.has(key)),
  };
};
