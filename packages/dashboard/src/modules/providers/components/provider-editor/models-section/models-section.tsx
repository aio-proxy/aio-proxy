import { m } from '@aio-proxy/i18n';
import { ProviderKind, type ModelMetadata } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aio-proxy/ui/components/empty';
import { Field, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@aio-proxy/ui/components/input-group';
import { toast } from '@aio-proxy/ui/components/toast';
import { LayersIcon, SearchIcon } from 'lucide-react';
import { useState } from 'react';

import { TagsInput } from '@/components/tags-input';

import { useProviderCatalogMutation } from '../../../hooks/use-provider-catalog-mutation';
import type { ProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import { aliasEditorIssues, type ProviderAlias, serializeAlias } from '../../../lib/alias-editor';
import { PROVIDER_MODELS_PLACEHOLDER, ProviderFormMode } from '../../../lib/constants';
import { exposedModels } from '../../../lib/exposed-models';
import { applyModelRows, modelRowContext, toModelRows, type ModelRow } from '../../../lib/model-rows';
import type { SectionSummary } from '../../../lib/section-status';
import { ProviderModelMetadataDrawer } from '../provider-model-metadata-drawer';
import { SectionShell } from '../section-shell';
import { ModelAliases } from './model-aliases';
import { ModelRowItem } from './model-row-item';

interface ModelsSectionProps {
  readonly form: ProviderEditorForm;
  readonly kind: ProviderKind;
  readonly mode: ProviderFormMode;
  readonly persistedProviderId?: string | undefined;
  /** oauth: `oauth.models` (discovered catalog); api/ai-sdk: last draft catalog result. */
  readonly candidates?: readonly string[] | undefined;
  readonly summary: SectionSummary;
}

type MetadataMap = Readonly<Record<string, ModelMetadata>>;

export const ModelsSection: React.FC<ModelsSectionProps> = ({
  form,
  kind,
  mode,
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
            // Per-call callbacks, not an effect on `catalogMutation.data`: the load is only ever
            // started by this click, so the toast fires exactly once per attempt instead of again on
            // every re-render that observes the same failed result. A failed load is transient news —
            // the user can still add models by hand — so it is a toast, not a banner pinned above
            // the list it is not blocking.
            onClick={() =>
              catalogMutation.mutate(undefined, {
                onSuccess: (result) => {
                  if (result.ok) return;
                  toast.add({
                    type: 'error',
                    title: m['dashboard.providers.form.catalog_failed']({ code: result.error.code }),
                  });
                },
                onError: () =>
                  toast.add({
                    type: 'error',
                    title: m['dashboard.providers.form.catalog_failed']({ code: 'catalog_unavailable' }),
                  }),
              })
            }
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
                        // A loaded catalog is routinely dozens to hundreds of ids, and an unbounded list
                        // pushed Routing and Advanced so far down the page that the section nav was the
                        // only way back. Capped and scrolled, matching `max-h-* overflow-y-auto` as used
                        // by the date-range panel and the heatmap hover. `pr-1` keeps the row's own hover
                        // and focus ring clear of the scrollbar gutter. Deliberate deviation from the
                        // prototype, which renders its 6-model fixture unbounded (see fidelity-rules D-F9).
                        <div className="max-h-96 space-y-2 overflow-y-auto pr-1" data-testid="models-rows">
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
                    {/* Says what the field is for before how to work it: the label already reads "add
                        model id", so a bare keystroke instruction would be the only line on screen not
                        explaining why anyone would type here when a catalog button sits above. */}
                    <FieldDescription>{m['dashboard.providers.form.models_helper']()}</FieldDescription>
                  </Field>

                  <form.Field name="alias">
                    {(aliasField) => {
                      const alias: ProviderAlias = aliasField.state.value ?? {};
                      return (
                        <ModelAliases
                          alias={alias}
                          // The RAW whitelist, never the fallback: empty means "no whitelist, so no
                          // target can be missing", and the fallback would make an alias-only provider
                          // fail against the catalog.
                          issues={aliasEditorIssues(alias, models)}
                          // The router exposes everything when the whitelist is empty, so the target
                          // picker mirrors that. `?? []` is load-bearing: api/ai-sdk have no catalog
                          // until the user loads one, and `undefined` crashes the downstream `.map` on
                          // exactly the alias-only provider this fixes.
                          targetOptions={models.length === 0 ? (discovered ?? []) : models}
                          onAliasChange={(next) =>
                            aliasField.handleChange(
                              serializeAlias(next, mode === ProviderFormMode.Create ? 'create' : 'edit'),
                            )
                          }
                        />
                      );
                    }}
                  </form.Field>

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
