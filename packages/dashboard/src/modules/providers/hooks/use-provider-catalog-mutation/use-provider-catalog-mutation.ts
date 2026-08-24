import { DashboardProviderDraftSchema, type DashboardProviderDraftCatalogResponse } from '@aio-proxy/types';
import { useMutation } from '@tanstack/react-query';

import { serializeAlias } from '../../lib/alias-editor';
import { normalizeProviderFormValue, type ProviderFormShape } from '../../lib/provider-form-value';
import { fetchProviderDraftCatalog } from '../../services/provider-draft';
import type { ProviderEditorForm } from '../use-provider-editor-form';

export const useProviderCatalogMutation = (form: ProviderEditorForm, persistedProviderId?: string) =>
  useMutation<DashboardProviderDraftCatalogResponse>({
    mutationFn: async () => {
      const values = form.state.values;
      const draft = DashboardProviderDraftSchema.safeParse(
        normalizeProviderFormValue({
          ...(values as ProviderFormShape),
          alias: values.alias === undefined ? undefined : serializeAlias(values.alias, 'edit'),
        }),
      );
      if (!draft.success) return { ok: false, error: { code: 'invalid_draft', recoverable: true } };
      return fetchProviderDraftCatalog({
        draft: draft.data,
        ...(persistedProviderId === undefined ? {} : { persistedProviderId }),
      });
    },
    onError: () => undefined,
  });
