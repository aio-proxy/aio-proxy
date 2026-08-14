import { DashboardProviderDraftSchema, ProviderKind, type DashboardProviderDraftTestResponse } from '@aio-proxy/types';
import { useMutation } from '@tanstack/react-query';

import { testProviderDraftModel } from '../../services/provider-draft';
import type { ProviderEditorForm, ProviderEditorShape } from '../use-provider-editor-form';
import { normalizeProviderFormValue, type ProviderForm, type ProviderFormShape } from '../use-provider-form';

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
  models: values.models,
});

export const useProviderTestMutation = (form: ProviderEditorForm | ProviderForm, persistedProviderId?: string) =>
  useMutation<ProviderTestResult, Error, string>({
    mutationFn: async (model) => {
      const values = form.state.values;
      const draft =
        values.kind === ProviderKind.OAuth
          ? DashboardProviderDraftSchema.safeParse(oauthDraftBody(values))
          : DashboardProviderDraftSchema.safeParse(normalizeProviderFormValue(values as ProviderFormShape));
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
