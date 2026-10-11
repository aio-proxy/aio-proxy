import { m } from '@aio-proxy/i18n';
import { ProviderKind } from '@aio-proxy/types';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aio-proxy/ui/components/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@aio-proxy/ui/components/input-group';
import { ScrollArea } from '@aio-proxy/ui/components/scroll-area';
import { toast } from '@aio-proxy/ui/components/toast';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSelector } from '@tanstack/react-store';
import { LayersIcon, SearchIcon } from 'lucide-react';
import { useState } from 'react';

import { queryKeys } from '@/lib/query-keys';

import { useProviderCatalogMutation } from '../../../hooks/use-provider-catalog-mutation';
import type { ProviderEditorForm, ProviderEditorInitial } from '../../../hooks/use-provider-editor-form';
import { addManualModels } from '../../../lib/add-manual-models';
import {
  aliasEditorIssues,
  type AliasRow,
  hideAliasRow,
  mergeInheritedAliasRows,
  mintAliasRowId,
  promoteEditedInheritedRows,
  type ProviderAlias,
  restoreAliasRow,
} from '../../../lib/alias-editor';
import { exposedModels, oauthEditorExposedModels } from '../../../lib/exposed-models';
import { canRefreshSavedCatalog } from '../../../lib/model-sync';
import { applicablePluginAliases } from '../../../lib/plugin-alias-suggestions';
import { removeModelFromAliases } from '../../../lib/remove-model-from-aliases';
import type { SectionSummary } from '../../../lib/section-status';
import { fetchProviderEditView, type ProviderSyncView } from '../../../services/providers-service';
import { SectionShell } from '../section-shell';
import { ModelAliases } from './model-aliases';
import { ModelRowItem } from './model-row-item';
import { ModelsCatalogAction } from './models-catalog-action';
import { ModelsManualAdd } from './models-manual-add';
import { ModelsSyncSwitch } from './models-sync-switch';

interface ModelsSectionProps {
  readonly form: ProviderEditorForm;
  readonly kind: ProviderKind;
  readonly persistedProviderId?: string | undefined;
  readonly initial?: ProviderEditorInitial | undefined;
  readonly refreshedAt?: string | undefined;
  readonly onCatalogLoaded: (catalog: ProviderSyncView) => void;
  /** The edit view's discovered catalog, superseded by a successful draft probe or refresh. */
  readonly candidates?: readonly string[] | undefined;
  /** oauth: `oauth.pluginAliases` — the plugin's default aliases, already validated server-side. */
  readonly pluginAliases?: ProviderAlias | undefined;
  readonly summary: SectionSummary;
}

type CatalogOutcome =
  | { readonly ok: true; readonly models: readonly string[]; readonly refreshedAt?: string | undefined }
  | { readonly ok: false; readonly code: string };

export const ModelsSection: React.FC<ModelsSectionProps> = ({
  form,
  kind,
  persistedProviderId,
  initial,
  refreshedAt,
  onCatalogLoaded,
  candidates,
  pluginAliases,
  summary,
}) => {
  const [filter, setFilter] = useState('');
  const values = useSelector(form.store, (state) => state.values);
  const synced = values.kind !== ProviderKind.OAuth && values.syncModels === true;
  const discoveryMode = kind === ProviderKind.OAuth || synced;
  const queryClient = useQueryClient();
  const catalogMutation = useProviderCatalogMutation(form, persistedProviderId);
  const savedCatalogMutation = useMutation({
    mutationFn: async (): Promise<CatalogOutcome> => {
      if (persistedProviderId === undefined) return { ok: false, code: 'catalog_unavailable' };
      // `refreshCatalog` is what makes this a reload rather than a redraw: the view can only report
      // the stored catalog, so without it the button would return the same rows for as long as the
      // catalog policy's TTL had not expired.
      const data = await fetchProviderEditView(persistedProviderId, { refreshCatalog: true });
      if (!data || 'error' in data) return { ok: false, code: 'catalog_unavailable' };
      // The read succeeded but the rediscovery behind it did not, so the models below are the stale
      // ones. Reporting success here is what made the old button look like it had worked.
      if (data.catalogRefreshed !== true) return { ok: false, code: 'catalog_unavailable' };
      const catalog = kind === ProviderKind.OAuth ? data.oauth : data.sync;
      if (catalog === undefined) return { ok: false, code: 'catalog_unavailable' };
      return { ok: true, models: catalog.models, refreshedAt: data.sync?.refreshedAt };
    },
    onSettled: (result) => {
      // Only a completed refresh may refetch the edit view. That read takes its models straight from
      // the stored catalog, and a refresh reported as failed can still have committed one — discovery
      // succeeded, the snapshot rebuild did not — so refetching would swap the rows under the error
      // toast for IDs generation still rejects until the rebuild retry lands.
      if (result?.ok === true && persistedProviderId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.providerEditView(persistedProviderId) });
      }
      // A refresh moves the Provider's catalog freshness and last-success timestamp on success, and
      // may add a catalog diagnostic on failure. Either way the list card is stale. `exact` because
      // `['providers']` is a prefix of the edit-view key, and the failure path must not reach it.
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers, exact: true });
    },
    onSuccess: (result) => {
      if (result.ok) {
        onCatalogLoaded({
          models: [...result.models],
          ...(result.refreshedAt === undefined ? {} : { refreshedAt: result.refreshedAt }),
        });
        return;
      }
      toast.add({ type: 'error', title: m['dashboard.providers.form.catalog_failed']({ code: result.code }) });
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: m['dashboard.providers.form.catalog_failed']({ code: 'catalog_unavailable' }),
      }),
  });
  const catalogPending = savedCatalogMutation.isPending || catalogMutation.isPending;
  const discovered = candidates;
  const catalogLoaded = discovered !== undefined;

  const loadCatalog = () => {
    if (
      kind === ProviderKind.OAuth ||
      (persistedProviderId !== undefined && canRefreshSavedCatalog(form.state.values, initial))
    ) {
      savedCatalogMutation.mutate();
      return;
    }
    catalogMutation.mutate(undefined, {
      onSuccess: (result) => {
        if (result.ok && (!synced || result.models.length > 0)) {
          onCatalogLoaded({ models: [...result.models] });
          return;
        }
        toast.add({
          type: 'error',
          title: m['dashboard.providers.form.catalog_failed']({
            code: result.ok ? 'catalog_unavailable' : result.error.code,
          }),
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
      {kind === ProviderKind.OAuth ? null : (
        <ModelsSyncSwitch
          form={form}
          candidates={discovered}
          refreshedAt={refreshedAt}
          pending={catalogPending}
          probeCatalog={() => catalogMutation.mutateAsync()}
          onCatalogLoaded={onCatalogLoaded}
        />
      )}
      <form.Field name={discoveryMode ? 'excludedModels' : 'models'}>
        {(modelsField) => (
          <form.Field name="alias">
            {(aliasField) => (
              <form.Field name="pluginAliasInherit">
                {(inheritField) => {
                  const stored: readonly string[] = modelsField.state.value ?? [];
                  const alias: readonly AliasRow[] = aliasField.state.value ?? [];
                  const inheritOff = kind === ProviderKind.OAuth && inheritField.state.value === false;
                  const selected = discoveryMode
                    ? oauthEditorExposedModels(discovered, stored)
                    : exposedModels(stored, undefined);
                  const applicableAliases = applicablePluginAliases(pluginAliases, selected);
                  const displayAlias =
                    kind === ProviderKind.OAuth
                      ? mergeInheritedAliasRows(alias, applicableAliases, selected, inheritOff)
                      : alias;
                  const aliasTargets = synced ? (discovered ?? []) : selected;
                  const persistAlias = (next: readonly AliasRow[]) =>
                    aliasField.handleChange(
                      promoteEditedInheritedRows(next, displayAlias).filter((row) => row.origin !== 'inherited'),
                    );
                  const whitelist = new Set(selected);
                  // Row order must not depend on which rows are ticked. Listing the whitelist first
                  // re-sorted a row the moment its box was checked, while the ScrollArea kept its scroll
                  // offset — so a catalog row jumped up to the enabled block and slid a different model
                  // under the pointer, where the next click landed. Catalog order is fixed; ids the
                  // catalog does not know (typed by hand) lead it, newest first as `addManualModels`
                  // writes them.
                  const catalogIds = discovered ?? [];
                  const knownToCatalog = new Set(catalogIds);
                  const rowIds = [...selected.filter((id) => !knownToCatalog.has(id)), ...catalogIds];
                  const needle = filter.trim().toLowerCase();
                  const visible = rowIds.filter((id) => needle === '' || id.toLowerCase().includes(needle));

                  const commit = (nextIds: readonly string[]) => modelsField.handleChange([...nextIds]);
                  const toggle = (id: string, enabled: boolean) => {
                    if (discoveryMode) {
                      modelsField.handleChange(enabled ? stored.filter((current) => current !== id) : [...stored, id]);
                      return;
                    }
                    commit(enabled ? [id, ...selected] : selected.filter((current) => current !== id));
                  };
                  const remove = (id: string) => {
                    if (discoveryMode) return;
                    if (!whitelist.has(id)) return;
                    commit(selected.filter((current) => current !== id));
                    persistAlias(removeModelFromAliases(alias, id));
                  };
                  const hideAlias = (id: string) => {
                    const row = displayAlias.find((item) => item.id === id);
                    if (row === undefined) return;
                    if (row.origin === 'inherited') {
                      persistAlias([...alias, { ...row, id: mintAliasRowId(), origin: 'hidden' }]);
                      return;
                    }
                    persistAlias(hideAliasRow(alias, id));
                  };

                  return (
                    <>
                      <div className="space-y-3" data-testid="provider-editor-field-models">
                        <div>
                          <h3 className="text-sm font-medium">
                            {m['dashboard.providers.form.models_upstream_heading']()}
                          </h3>
                          <p className="text-xs text-muted-foreground">
                            {synced
                              ? m['dashboard.providers.form.models_sync_hint']()
                              : kind === ProviderKind.OAuth
                                ? m['dashboard.providers.form.models_upstream_hint_oauth']()
                                : m['dashboard.providers.form.models_upstream_hint']()}
                          </p>
                        </div>

                        {rowIds.length === 0 ? (
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
                                {visible.map((id) => (
                                  <ModelRowItem
                                    key={id}
                                    id={id}
                                    enabled={whitelist.has(id)}
                                    onToggle={(enabled) => toggle(id, enabled)}
                                    onRemove={discoveryMode ? undefined : () => remove(id)}
                                  />
                                ))}
                              </div>
                            </ScrollArea>
                          </>
                        )}

                        {discoveryMode ? null : (
                          <ModelsManualAdd onAdd={(ids) => commit(addManualModels(selected, ids))} />
                        )}
                      </div>

                      <ModelAliases
                        alias={displayAlias}
                        issues={aliasEditorIssues(displayAlias, aliasTargets)}
                        targetOptions={aliasTargets}
                        onAliasChange={persistAlias}
                        inheritPluginAliases={
                          kind === ProviderKind.OAuth ? inheritField.state.value !== false : undefined
                        }
                        onInheritPluginAliasesChange={
                          kind === ProviderKind.OAuth ? (inherit) => inheritField.handleChange(inherit) : undefined
                        }
                        pluginDefaultNames={
                          applicableAliases === undefined ? undefined : new Set(Object.keys(applicableAliases))
                        }
                        onHideAlias={kind === ProviderKind.OAuth ? hideAlias : undefined}
                        onRestoreAlias={
                          kind === ProviderKind.OAuth ? (id) => persistAlias(restoreAliasRow(alias, id)) : undefined
                        }
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
