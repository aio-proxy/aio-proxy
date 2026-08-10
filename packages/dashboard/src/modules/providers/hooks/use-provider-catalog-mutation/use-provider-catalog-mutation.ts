import { DashboardProviderDraftSchema, type DashboardProviderDraftCatalogResponse } from '@aio-proxy/types';
import { useMutation } from '@tanstack/react-query';

import { fetchProviderDraftCatalog } from '../../services/provider-draft';
import { normalizeProviderFormValue, type ProviderForm } from '../use-provider-form';

export const useProviderCatalogMutation = (form: ProviderForm, persistedProviderId?: string) =>
  useMutation<DashboardProviderDraftCatalogResponse>({
    mutationFn: async () => {
      const draft = DashboardProviderDraftSchema.safeParse(normalizeProviderFormValue(form.state.values));
      if (!draft.success) return { ok: false, error: { code: 'invalid_draft', recoverable: true } };
      return fetchProviderDraftCatalog({
        draft: draft.data,
        ...(persistedProviderId === undefined ? {} : { persistedProviderId }),
      });
    },
    onError: () => undefined,
  });
