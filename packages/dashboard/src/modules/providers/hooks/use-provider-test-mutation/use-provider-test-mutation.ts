import { DashboardProviderDraftSchema, ProviderKind, type DashboardProviderDraftTestResponse } from '@aio-proxy/types';
import { useMutation } from '@tanstack/react-query';

import { serializeAlias } from '../../lib/alias-editor';
import { normalizeProviderFormValue, type ProviderFormShape } from '../../lib/provider-form-value';
import { testProviderDraftModel } from '../../services/provider-draft';
import type { ProviderEditorForm, ProviderEditorShape } from '../use-provider-editor-form';

interface ProviderTestResult {
  readonly model: string;
  readonly result: DashboardProviderDraftTestResponse;
}

type OAuthEditorValues = Extract<ProviderEditorShape, { kind: ProviderKind.OAuth }>;

// Five fields only. Spreading OAuthEditorShape leaks `validationModel`, which the strict oauth
// draft arm rejects as unrecognized_keys → invalid_draft, and the panel never reaches the network.
const oauthDraftBody = (values: OAuthEditorValues) => ({
  kind: ProviderKind.OAuth,
  id: values.id,
  enabled: values.enabled,
  proxy: null,
  excludedModels: values.excludedModels,
});

export const useProviderTestMutation = (form: ProviderEditorForm, persistedProviderId?: string) =>
  useMutation<ProviderTestResult, Error, string>({
    mutationFn: async (model) => {
      const values = form.state.values;
      const draft =
        values.kind === ProviderKind.OAuth
          ? DashboardProviderDraftSchema.safeParse(oauthDraftBody(values))
          : DashboardProviderDraftSchema.safeParse(
              normalizeProviderFormValue({
                ...(values as ProviderFormShape),
                alias: values.alias === undefined ? undefined : serializeAlias(values.alias, 'edit'),
              }),
            );
      if (!draft.success) {
        return { model, result: { ok: false, error: { code: 'invalid_draft', recoverable: true } } };
      }
      const result = await testProviderDraftModel({
        draft: draft.data,
        model,
        ...(persistedProviderId === undefined ? {} : { persistedProviderId }),
      });
      return { model, result };
    },
  });
