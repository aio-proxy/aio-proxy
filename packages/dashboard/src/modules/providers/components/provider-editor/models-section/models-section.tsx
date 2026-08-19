import { m } from '@aio-proxy/i18n';
import { ProviderKind, type ModelMetadata } from '@aio-proxy/types';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aio-proxy/ui/components/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@aio-proxy/ui/components/input-group';
import { ScrollArea } from '@aio-proxy/ui/components/scroll-area';
import { toast } from '@aio-proxy/ui/components/toast';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LayersIcon, SearchIcon } from 'lucide-react';
import { useState } from 'react';

import { queryKeys } from '@/lib/query-keys';

import { useProviderCatalogMutation } from '../../../hooks/use-provider-catalog-mutation';
import type { ProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import { addManualModels } from '../../../lib/add-manual-models';
import { aliasEditorIssues, type ProviderAlias, serializeAlias } from '../../../lib/alias-editor';
import { ProviderFormMode } from '../../../lib/constants';
import { exposedModels } from '../../../lib/exposed-models';
import { applyModelRows, modelRowContext, toModelRows, type ModelRow } from '../../../lib/model-rows';
import { removeModelFromAliases } from '../../../lib/remove-model-from-aliases';
import type { SectionSummary } from '../../../lib/section-status';
import { fetchProviderEditView } from '../../../services/providers-service';
import { ProviderModelMetadataDrawer } from '../provider-model-metadata-drawer';
import { SectionShell } from '../section-shell';
import { ModelAliases } from './model-aliases';
import { ModelRowItem } from './model-row-item';
import { ModelsCatalogAction } from './models-catalog-action';
import { ModelsManualAdd } from './models-manual-add';

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

type CatalogOutcome =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly code: string };

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
  const queryClient = useQueryClient();
  const catalogMutation = useProviderCatalogMutation(form, persistedProviderId);
  const oauthCatalogMutation = useMutation({
    mutationFn: async (): Promise<CatalogOutcome> => {
      if (persistedProviderId === undefined) return { ok: false, code: 'catalog_unavailable' };
      const data = await fetchProviderEditView(persistedProviderId);
      if (!data || 'error' in data || data.oauth === undefined) return { ok: false, code: 'catalog_unavailable' };
      return { ok: true, models: data.oauth.models };
    },
    onSuccess: (result) => {
      if (persistedProviderId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.providerEditView(persistedProviderId) });
      }
      if (result.ok) return;
      toast.add({ type: 'error', title: m['dashboard.providers.form.catalog_failed']({ code: result.code }) });
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: m['dashboard.providers.form.catalog_failed']({ code: 'catalog_unavailable' }),
      }),
  });
  const catalogResult = catalogMutation.data;
  const catalogPending = kind === ProviderKind.OAuth ? oauthCatalogMutation.isPending : catalogMutation.isPending;
  // A fresh catalog fetch supersedes the seed the page handed in.
  const loaded =
    kind === ProviderKind.OAuth
      ? oauthCatalogMutation.data?.ok === true
        ? oauthCatalogMutation.data.models
        : undefined
      : catalogResult?.ok === true
        ? catalogResult.models
        : undefined;
  const discovered = loaded ?? candidates;
  const catalogLoaded = discovered !== undefined;

  const loadCatalog = () => {
    if (kind === ProviderKind.OAuth) {
      oauthCatalogMutation.mutate();
      return;
    }
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
    });
  };

  return (
    <SectionShell
      id="models"
      title={m['dashboard.providers.editor.section_models']()}
      description={m['dashboard.providers.editor.section_models_description']()}
      status={summary.status}
      statusHint={summary.hint}
      action={<ModelsCatalogAction pending={catalogPending} loaded={catalogLoaded} onClick={loadCatalog} />}
    >
      <form.Field name="models">
        {(modelsField) => (
          <form.Field name="metadata">
            {(metadataField) => (
              <form.Field name="alias">
                {(aliasField) => {
                  const models: readonly string[] = modelsField.state.value ?? [];
                  const metadata = (metadataField.state.value ?? {}) as MetadataMap;
                  const alias: ProviderAlias = aliasField.state.value ?? {};
                  // An empty oauth whitelist exposes the whole discovered catalog at runtime, so the
                  // rows must render checked and unchecking one must narrow that set — not promote
                  // the single survivor. api/ai-sdk get no such substitution.
                  const selected = exposedModels(models, kind === ProviderKind.OAuth ? discovered : undefined);
                  const whitelist = new Set(selected);
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
                  const remove = (id: string) => {
                    // Every row renders the trash control, but only whitelisted ids can leave the
                    // list — a catalog-only row survives `discovered`. Removing one is a no-op on
                    // `models`, so the cascade below must not run either: it would delete aliases
                    // and metadata pointing at a row still on screen.
                    if (!whitelist.has(id)) return;
                    const { [id]: _dropped, ...rest } = metadata;
                    commit(
                      whitelistRows.filter((row) => row.id !== id),
                      rest,
                    );
                    aliasField.handleChange(
                      serializeAlias(
                        removeModelFromAliases(alias, id),
                        mode === ProviderFormMode.Create ? 'create' : 'edit',
                      ),
                    );
                  };

                  return (
                    <>
                      <div className="space-y-3" data-testid="provider-editor-field-models">
                        <div>
                          <h3 className="text-sm font-medium">
                            {m['dashboard.providers.form.models_upstream_heading']()}
                          </h3>
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
                              <EmptyDescription>
                                {m['dashboard.providers.form.models_empty_description']()}
                              </EmptyDescription>
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
                                {m['dashboard.providers.editor.models_count']({
                                  enabled: selected.length,
                                  total: rowIds.length,
                                })}
                              </p>
                            </div>

                            {/* A loaded catalog is routinely dozens to hundreds of ids, and an unbounded
                                list pushed Routing and Advanced so far down the page that the section nav
                                was the only way back. `pr-3` keeps the row's own hover and focus ring clear
                                of the scrollbar gutter. */}
                            <ScrollArea className="[&_[data-slot=scroll-area-viewport]]:max-h-72">
                              <div className="space-y-1.5 pr-3" data-testid="models-rows">
                                {visible.map((row) => (
                                  <ModelRowItem
                                    key={row.id}
                                    id={row.id}
                                    enabled={whitelist.has(row.id)}
                                    context={modelRowContext(row.metadata)}
                                    onToggle={(enabled) => toggle(row.id, enabled)}
                                    onRemove={() => remove(row.id)}
                                    onEditMetadata={() => setMetadataModel(row.id)}
                                  />
                                ))}
                              </div>
                            </ScrollArea>
                          </>
                        )}

                        <ModelsManualAdd
                          onAdd={(ids) => commit(toModelRows(addManualModels(selected, ids), metadata))}
                        />
                      </div>

                      <ModelAliases
                        alias={alias}
                        issues={aliasEditorIssues(alias, models)}
                        targetOptions={selected}
                        onAliasChange={(next) =>
                          aliasField.handleChange(
                            serializeAlias(next, mode === ProviderFormMode.Create ? 'create' : 'edit'),
                          )
                        }
                      />

                      <ProviderModelMetadataDrawer
                        model={metadataModel}
                        value={metadataModel === null ? undefined : metadata[metadataModel]}
                        onOpenChange={(open) => {
                          if (!open) setMetadataModel(null);
                        }}
                        onSave={(value) => {
                          if (metadataModel !== null) {
                            metadataField.handleChange({ ...metadata, [metadataModel]: value });
                          }
                        }}
                      />
                    </>
                  );
                }}
              </form.Field>
            )}
          </form.Field>
        )}
      </form.Field>
    </SectionShell>
  );
};
