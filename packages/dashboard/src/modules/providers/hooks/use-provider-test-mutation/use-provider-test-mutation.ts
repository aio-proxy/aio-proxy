import { DashboardProviderDraftSchema, type DashboardProviderDraftTestResponse } from '@aio-proxy/types';
import { useMutation } from '@tanstack/react-query';

import { testProviderDraftModel } from '../../services/provider-draft';
import { normalizeProviderFormValue, type ProviderForm } from '../use-provider-form';

interface ProviderTestResult {
  readonly model: string;
  readonly result: DashboardProviderDraftTestResponse;
}

export const useProviderTestMutation = (form: ProviderForm, persistedProviderId?: string) =>
  useMutation<ProviderTestResult, Error, string>({
    mutationFn: async (model) => {
      const draft = DashboardProviderDraftSchema.safeParse(normalizeProviderFormValue(form.state.values));
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
