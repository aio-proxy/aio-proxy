import { getLocale, m } from '@aio-proxy/i18n';
import type { DashboardProviderDraftCatalogResponse } from '@aio-proxy/types';
import { Field, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { Switch } from '@aio-proxy/ui/components/switch';
import { toast } from '@aio-proxy/ui/components/toast';

import type { ProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import { manualModelsFromCatalog } from '../../../lib/model-sync';
import type { ProviderSyncView } from '../../../services/providers-service';

interface ModelsSyncSwitchProps {
  readonly form: ProviderEditorForm;
  readonly candidates: readonly string[] | undefined;
  readonly refreshedAt: string | undefined;
  readonly pending: boolean;
  readonly probeCatalog: () => Promise<DashboardProviderDraftCatalogResponse>;
  readonly onCatalogLoaded: (catalog: ProviderSyncView) => void;
}

export const ModelsSyncSwitch: React.FC<ModelsSyncSwitchProps> = ({
  form,
  candidates,
  refreshedAt,
  pending,
  probeCatalog,
  onCatalogLoaded,
}) => {
  const catalogFailed = (code: string) =>
    toast.add({ type: 'error', title: m['dashboard.providers.form.catalog_failed']({ code }) });
  const changeMode = async (sync: boolean) => {
    if (!sync) {
      const values = form.state.values;
      form.setFieldValue('models', manualModelsFromCatalog(candidates, values.excludedModels, values.alias ?? []));
      form.setFieldValue('syncModels', undefined);
      form.setFieldValue('excludedModels', undefined);
      return;
    }
    try {
      const result = await probeCatalog();
      if (!result.ok || result.models.length === 0) {
        catalogFailed(result.ok ? 'catalog_unavailable' : result.error.code);
        return;
      }
      onCatalogLoaded({ models: [...result.models] });
      form.setFieldValue('models', []);
      form.setFieldValue('excludedModels', []);
      form.setFieldValue('syncModels', true);
    } catch {
      catalogFailed('catalog_unavailable');
    }
  };

  return (
    <form.Field name="syncModels">
      {(field) => (
        <Field>
          <div className="flex items-center gap-3">
            <span className="text-sm">{m['dashboard.providers.form.models_manual_label']()}</span>
            <Switch
              id="models-sync-switch"
              data-testid="models-sync-switch"
              checked={field.state.value === true}
              disabled={pending}
              onCheckedChange={(sync) => void changeMode(sync)}
            />
            <FieldLabel htmlFor="models-sync-switch">{m['dashboard.providers.form.models_sync_label']()}</FieldLabel>
          </div>
          <FieldDescription>{m['dashboard.providers.form.models_sync_hint']()}</FieldDescription>
          {field.state.value === true ? (
            <p className="text-xs text-muted-foreground" data-testid="models-sync-refreshed">
              {refreshedAt === undefined
                ? m['dashboard.providers.form.models_sync_never']()
                : m['dashboard.providers.form.models_sync_refreshed_at']({
                    time: new Date(refreshedAt).toLocaleString(getLocale()),
                  })}
            </p>
          ) : null}
        </Field>
      )}
    </form.Field>
  );
};
