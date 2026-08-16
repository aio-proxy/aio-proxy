import { DashboardProviderDraftSchema, type DashboardProviderDraftCatalogResponse } from '@aio-proxy/types';
import { useMutation } from '@tanstack/react-query';

import { normalizeProviderFormValue, type ProviderFormShape } from '../../lib/provider-form-value';
import { fetchProviderDraftCatalog } from '../../services/provider-draft';
import type { ProviderEditorForm } from '../use-provider-editor-form';

export const useProviderCatalogMutation = (form: ProviderEditorForm, persistedProviderId?: string) =>
  useMutation<DashboardProviderDraftCatalogResponse>({
    mutationFn: async () => {
      const draft = DashboardProviderDraftSchema.safeParse(
        normalizeProviderFormValue(form.state.values as ProviderFormShape),
      );
      if (!draft.success) return { ok: false, error: { code: 'invalid_draft', recoverable: true } };
      return fetchProviderDraftCatalog({
        draft: draft.data,
        ...(persistedProviderId === undefined ? {} : { persistedProviderId }),
      });
    },
    onError: () => undefined,
  });
