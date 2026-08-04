import { m } from '@aio-proxy/i18n';
import type { ModelMetadata } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Checkbox } from '@aio-proxy/ui/components/checkbox';
import { Field, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { Label } from '@aio-proxy/ui/components/label';
import { useState } from 'react';

import { TagsInput } from '@/components/tags-input';

import { PROVIDER_MODELS_PLACEHOLDER } from '../../constants';
import { useProviderCatalogMutation } from '../../hooks/use-provider-catalog-mutation';
import type { ProviderForm } from '../../hooks/use-provider-form';
import { ProviderModelMetadataDrawer } from './provider-model-metadata-drawer';

interface ProviderModelsFieldProps {
  readonly form: ProviderForm;
  readonly persistedProviderId?: string;
}

export const ProviderModelsField: React.FC<ProviderModelsFieldProps> = ({ form, persistedProviderId }) => {
  const [metadataModel, setMetadataModel] = useState<string | null>(null);
  const catalogMutation = useProviderCatalogMutation(form, persistedProviderId);
  const catalogResult = catalogMutation.data;

  return (
    <form.Field name="models">
      {(modelsField) => (
        <form.Field name="metadata">
          {(metadataField) => {
            const models = modelsField.state.value ?? [];
            const metadata = metadataField.state.value ?? {};
            const toggleModel = (model: string, enabled: boolean) =>
              modelsField.handleChange(enabled ? [...models, model] : models.filter((item) => item !== model));

            return (
              <div className="space-y-5" data-testid="provider-form-field-models">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <FieldLabel>{m['dashboard.providers.form.label_models']()}</FieldLabel>
                    <FieldDescription>{m['dashboard.providers.form.catalog_description']()}</FieldDescription>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={catalogMutation.isPending}
                    onClick={() => catalogMutation.mutate()}
                  >
                    {catalogMutation.isPending
                      ? m['dashboard.providers.form.catalog_loading']()
                      : m['dashboard.providers.form.catalog_load']()}
                  </Button>
                </div>

                {catalogMutation.isError ? (
                  <p role="status" className="rounded-lg border bg-muted p-3 text-sm">
                    {m['dashboard.providers.form.catalog_failed']({ code: 'catalog_unavailable' })}
                  </p>
                ) : catalogResult?.ok ? (
                  catalogResult.models.length === 0 ? (
                    <p role="status" className="rounded-lg border bg-muted p-3 text-sm">
                      {m['dashboard.providers.form.catalog_empty']()}
                    </p>
                  ) : (
                    <Field role="group" aria-label={m['dashboard.providers.form.catalog_models']()}>
                      <FieldLabel>{m['dashboard.providers.form.catalog_models']()}</FieldLabel>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {catalogResult.models.map((model) => (
                          <Label key={model} className="rounded-lg border p-3">
                            <Checkbox
                              checked={models.includes(model)}
                              onClick={() => toggleModel(model, !models.includes(model))}
                            />
                            <span className="truncate">{model}</span>
                          </Label>
                        ))}
                      </div>
                    </Field>
                  )
                ) : catalogResult === undefined ? null : (
                  <p role="status" className="rounded-lg border bg-muted p-3 text-sm">
                    {m['dashboard.providers.form.catalog_failed']({ code: catalogResult.error.code })}
                  </p>
                )}

                <Field>
                  <FieldLabel>{m['dashboard.providers.form.enabled_models']()}</FieldLabel>
                  {models.length === 0 ? (
                    <FieldDescription>{m['dashboard.providers.form.enabled_models_empty']()}</FieldDescription>
                  ) : (
                    <div className="space-y-2">
                      {models.map((model) => (
                        <div key={model} className="flex items-center gap-2 rounded-lg border p-2">
                          <span className="min-w-0 flex-1 truncate">{model}</span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label={m['dashboard.providers.form.edit_metadata']({ model })}
                            onClick={() => setMetadataModel(model)}
                          >
                            {m['dashboard.providers.form.metadata']()}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={m['dashboard.providers.form.remove_model']({ model })}
                            onClick={() => toggleModel(model, false)}
                          >
                            {m['dashboard.providers.actions.delete']()}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </Field>

                <Field>
                  <Label htmlFor="provider-manual-models">{m['dashboard.providers.form.manual_models']()}</Label>
                  <TagsInput
                    id="provider-manual-models"
                    value={models}
                    onValueChange={modelsField.handleChange}
                    placeholder={PROVIDER_MODELS_PLACEHOLDER}
                    removeLabel={(model) => m['dashboard.providers.form.remove_model']({ model })}
                    showValues={false}
                  />
                  <FieldDescription>{m['dashboard.providers.form.models_helper']()}</FieldDescription>
                </Field>

                <ProviderModelMetadataDrawer
                  model={metadataModel}
                  value={metadataModel === null ? undefined : (metadata[metadataModel] as ModelMetadata | undefined)}
                  onOpenChange={(open) => {
                    if (!open) setMetadataModel(null);
                  }}
                  onSave={(value) => {
                    if (metadataModel !== null) metadataField.handleChange({ ...metadata, [metadataModel]: value });
                  }}
                />
              </div>
            );
          }}
        </form.Field>
      )}
    </form.Field>
  );
};
