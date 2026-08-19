import { m } from '@aio-proxy/i18n';
import { ProviderKind, type ModelMetadata } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aio-proxy/ui/components/empty';
import { Field, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@aio-proxy/ui/components/input-group';
import { LayersIcon, SearchIcon } from 'lucide-react';
import { useState } from 'react';

import { TagsInput } from '@/components/tags-input';

import { useProviderCatalogMutation } from '../../../hooks/use-provider-catalog-mutation';
import type { ProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import { PROVIDER_MODELS_PLACEHOLDER } from '../../../lib/constants';
import { exposedModels } from '../../../lib/exposed-models';
import { applyModelRows, modelRowContext, toModelRows, type ModelRow } from '../../../lib/model-rows';
import type { SectionSummary } from '../../../lib/section-status';
import { ProviderModelMetadataDrawer } from '../provider-model-metadata-drawer';
import { SectionShell } from '../section-shell';
import { ModelRowItem } from './model-row-item';

interface ModelsSectionProps {
  readonly form: ProviderEditorForm;
  readonly kind: ProviderKind;
  readonly persistedProviderId?: string | undefined;
  /** oauth: `oauth.models` (discovered catalog); api/ai-sdk: last draft catalog result. */
  readonly candidates?: readonly string[] | undefined;
  readonly summary: SectionSummary;
}

type MetadataMap = Readonly<Record<string, ModelMetadata>>;

export const ModelsSection: React.FC<ModelsSectionProps> = ({
  form,
  kind,
  persistedProviderId,
  candidates,
  summary,
}) => {
  const [filter, setFilter] = useState('');
  const [metadataModel, setMetadataModel] = useState<string | null>(null);
  const catalogMutation = useProviderCatalogMutation(form, persistedProviderId);
  const catalogResult = catalogMutation.data;
  // A fresh draft-catalog load supersedes the seed the page handed in.
  const loaded = catalogResult?.ok === true ? catalogResult.models : undefined;
  const discovered = loaded ?? candidates;

  return (
    <SectionShell
      id="models"
      title={m['dashboard.providers.editor.section_models']()}
      description={m['dashboard.providers.editor.section_models_description']()}
      status={summary.status}
      statusHint={summary.hint}
      action={
        kind === ProviderKind.OAuth ? undefined : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="models-catalog-load"
            disabled={catalogMutation.isPending}
            onClick={() => catalogMutation.mutate()}
          >
            {catalogMutation.isPending
              ? m['dashboard.providers.form.catalog_loading']()
              : m['dashboard.providers.form.catalog_load']()}
          </Button>
        )
      }
    >
      <form.Field name="models">
        {(modelsField) => (
          <form.Field name="metadata">
            {(metadataField) => {
              const models: readonly string[] = modelsField.state.value ?? [];
              const metadata = (metadataField.state.value ?? {}) as MetadataMap;
              // An empty oauth whitelist exposes the whole discovered catalog at runtime, so the rows
              // must render checked and unchecking one must narrow that set — not promote the single
              // survivor. api/ai-sdk get no such substitution: an empty whitelist there exposes nothing.
              const selected = exposedModels(models, kind === ProviderKind.OAuth ? discovered : undefined);
              const whitelist = new Set(selected);
              const discoveredSet = new Set(discovered ?? []);
              // One list: the whitelist in its configured order, then any discovered model not yet
              // whitelisted, so a candidate can be enabled without a second grid.
              const rowIds = [...selected, ...(discovered ?? []).filter((id) => !whitelist.has(id))];
              const rows = toModelRows(rowIds, metadata);
              const whitelistRows = toModelRows(selected, metadata);
              const needle = filter.trim().toLowerCase();
              const visible = rows.filter((row) => needle === '' || row.id.toLowerCase().includes(needle));

              const commit = (nextRows: readonly ModelRow[], previous: MetadataMap = metadata) => {
                const applied = applyModelRows(nextRows, previous);
                modelsField.handleChange(applied.models);
                metadataField.handleChange(applied.metadata);
              };
              const toggle = (id: string, enabled: boolean) =>
                commit(
                  enabled
                    ? [...whitelistRows, { id, metadata: metadata[id] }]
                    : whitelistRows.filter((row) => row.id !== id),
                );
              // Remove forgets the record too; disabling above deliberately keeps it.
              const remove = (id: string) => {
                const { [id]: _dropped, ...rest } = metadata;
                commit(
                  whitelistRows.filter((row) => row.id !== id),
                  rest,
                );
              };

              return (
                <div className="space-y-4" data-testid="provider-editor-field-models">
                  <div>
                    <h3 className="text-sm font-medium">{m['dashboard.providers.form.models_upstream_heading']()}</h3>
                    <p className="text-xs text-muted-foreground">
                      {m['dashboard.providers.form.models_upstream_hint']()}
                    </p>
                  </div>

                  {catalogMutation.isError || catalogResult?.ok === false ? (
                    <p role="status" className="rounded-lg border bg-muted p-3 text-sm">
                      {m['dashboard.providers.form.catalog_failed']({
                        code: catalogResult?.ok === false ? catalogResult.error.code : 'catalog_unavailable',
                      })}
                    </p>
                  ) : null}

                  {rows.length === 0 ? (
                    <Empty className="border" data-testid="models-empty">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <LayersIcon />
                        </EmptyMedia>
                        <EmptyTitle>{m['dashboard.providers.form.models_empty_title']()}</EmptyTitle>
                        <EmptyDescription>{m['dashboard.providers.form.models_empty_description']()}</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-3">
                        <InputGroup className="w-full sm:w-64">
                          <InputGroupAddon>
                            <SearchIcon />
                          </InputGroupAddon>
                          <InputGroupInput
                            value={filter}
                            data-testid="models-filter"
                            aria-label={m['dashboard.providers.editor.models_filter_placeholder']()}
                            placeholder={m['dashboard.providers.editor.models_filter_placeholder']()}
                            onChange={(event) => setFilter(event.target.value)}
                          />
                        </InputGroup>
                        <p className="text-sm text-muted-foreground" data-testid="models-count">
                          {kind === ProviderKind.OAuth && models.length === 0
                            ? m['dashboard.providers.editor.models_all_discovered']({
                                count: discovered?.length ?? 0,
                              })
                            : m['dashboard.providers.editor.models_count']({
                                enabled: models.length,
                                // api/ai-sdk have no candidates until a catalog loads; the whitelist is
                                // the only honest total until then.
                                total: discovered?.length ?? models.length,
                              })}
                        </p>
                      </div>

                      {visible.length === 0 ? (
                        // Distinct from the no-models card: the provider has models, the filter hides them.
                        <p className="text-sm text-muted-foreground" data-testid="models-no-matches">
                          {m['dashboard.providers.form.models_filter_no_matches']()}
                        </p>
                      ) : (
                        <div className="space-y-2" data-testid="models-rows">
                          {visible.map((row) => (
                            <ModelRowItem
                              key={row.id}
                              id={row.id}
                              enabled={whitelist.has(row.id)}
                              selectable={discovered !== undefined}
                              stale={discovered !== undefined && whitelist.has(row.id) && !discoveredSet.has(row.id)}
                              removable={!discoveredSet.has(row.id)}
                              context={modelRowContext(row.metadata)}
                              onToggle={(enabled) => toggle(row.id, enabled)}
                              onRemove={() => remove(row.id)}
                              onEditMetadata={() => setMetadataModel(row.id)}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  <Field>
                    <FieldLabel htmlFor="models-manual-add">
                      {m['dashboard.providers.editor.models_manual_add']()}
                    </FieldLabel>
                    <div className="w-full sm:w-64">
                      {/* The shared tags control, not a lookalike: the placeholder promises a
                          comma-separated list, and this is what splits one. */}
                      <TagsInput
                        id="models-manual-add"
                        value={selected}
                        onValueChange={(next) => commit(toModelRows(next, metadata))}
                        placeholder={PROVIDER_MODELS_PLACEHOLDER}
                        removeLabel={(model) => m['dashboard.providers.form.remove_model']({ model })}
                        showValues={false}
                      />
                    </div>
                    <FieldDescription>{m['dashboard.providers.form.models_helper']()}</FieldDescription>
                  </Field>

                  <ProviderModelMetadataDrawer
                    model={metadataModel}
                    value={metadataModel === null ? undefined : metadata[metadataModel]}
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
    </SectionShell>
  );
};
