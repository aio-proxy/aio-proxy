import { DashboardProviderDraftSchema, type DashboardProviderDraftCatalogResponse } from '@aio-proxy/types';
import { useMutation } from '@tanstack/react-query';

import { fetchProviderDraftCatalog } from '../../services/provider-draft';
import type { ProviderEditorForm } from '../use-provider-editor-form';
import { normalizeProviderFormValue, type ProviderForm, type ProviderFormShape } from '../use-provider-form';

// A union, not `ProviderEditorForm` alone: `TFormData` is invariant (reached through
// `options.listeners.onChange`), so `ProviderForm` is not assignable to `ProviderEditorForm` and a
// straight swap would break the legacy stepper call site. Both unions share `ProviderFormShape`'s
// draft-relevant keys, which is all `normalizeProviderFormValue` reads.
export const useProviderCatalogMutation = (form: ProviderForm | ProviderEditorForm, persistedProviderId?: string) =>
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
