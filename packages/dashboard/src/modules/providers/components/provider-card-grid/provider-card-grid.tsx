import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Empty } from '@aio-proxy/ui/components/empty';
import { useQuery } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { resolveDashboardText } from '@/lib/localized-text';

import { useProviderRoutingMutation } from '../../hooks/use-provider-routing-mutation';
import { emptyProviderListFilters, visibleProviders } from '../../lib/provider-list-view';
import { buildProviderRoutingBoard, providerRoutingMutation } from '../../lib/provider-routing-board';
import { providerHealthQueryOptions } from '../../services/provider-health-service';
import { providerPluginPresentationsQueryOptions } from '../../services/provider-plugin-labels';
import { providerUsageQueryOptions, zeroProviderUsage } from '../../services/provider-usage-service';
import { DeleteProviderDialog, type DeleteProviderDialogRef } from '../delete-provider-dialog';
import { ProviderCard } from '../provider-card';
import { ProviderRoutingBoard } from '../provider-routing-board';
import { ProviderFilterChips } from './provider-filter-chips';
import { ProviderSearchField } from './provider-search-field';

interface ProviderCardGridProps {
  readonly providers: readonly DashboardProviderSummary[];
  readonly routingRevision: string;
  readonly focusProviderId?: string;
  readonly routingEditing?: boolean;
  readonly onRoutingEditingChange?: (editing: boolean) => void;
}

export const ProviderCardGrid: React.FC<ProviderCardGridProps> = ({
  providers,
  routingRevision,
  focusProviderId,
  routingEditing = false,
  onRoutingEditingChange,
}) => {
  const [filters, setFilters] = useState(emptyProviderListFilters);
  const [draft, setDraft] = useState<{
    readonly board: ReturnType<typeof buildProviderRoutingBoard>;
    readonly savedBoard: ReturnType<typeof buildProviderRoutingBoard>;
    readonly revision: string;
  } | null>(null);
  const deleteDialogRef = useRef<DeleteProviderDialogRef>(null);
  const routingMutation = useProviderRoutingMutation();
  const usageQuery = useQuery(providerUsageQueryOptions());
  const healthQuery = useQuery(providerHealthQueryOptions());
  const pluginsQuery = useQuery(providerPluginPresentationsQueryOptions());

  const pluginPresentations = useMemo(
    () =>
      new Map(
        (pluginsQuery.data?.plugins ?? []).map((plugin) => [
          plugin.packageName,
          {
            ...plugin,
            displayName: plugin.displayName === undefined ? undefined : resolveDashboardText(plugin.displayName),
          },
        ]),
      ),
    [pluginsQuery.data],
  );
  const visible = useMemo(() => visibleProviders(providers, filters), [providers, filters]);
  const currentBoard = draft?.board ?? buildProviderRoutingBoard(providers);
  const savedBoard = draft?.savedBoard ?? currentBoard;
  const dirty =
    JSON.stringify(providerRoutingMutation(currentBoard, routingRevision).providers) !==
    JSON.stringify(providerRoutingMutation(savedBoard, routingRevision).providers);

  // Deep-linking focuses the target card once it is actually on screen. Keyed on the Provider ID and
  // on whether the *visible* grid holds it: a cached list may not yet contain a freshly created
  // Provider (the background refetch adds it), and a filter may hide one that is already there. In
  // both cases the card is absent from the document, so an effect keyed on the ID alone would run
  // once against nothing and never retry. Re-running on filter changes is safe because `focused`
  // latches after the first successful focus, so nothing can steal the cursor back mid-word.
  const focused = useRef<string | undefined>(undefined);
  const present = focusProviderId !== undefined && visible.some((provider) => provider.id === focusProviderId);
  useEffect(() => {
    if (focusProviderId === undefined || !present || focused.current === focusProviderId) return;
    let inner = 0;
    // Two frames: the first lets React commit the grid, the second lets layout settle before scrolling.
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const card = document.getElementById(`provider-row-${focusProviderId}`);
        // Filtered back out between frames; leave the latch open so the focus still lands when the
        // card returns rather than being silently dropped.
        if (card === null) return;
        focused.current = focusProviderId;
        card.scrollIntoView?.({ block: 'center' });
        // The identity link is the card's only focusable anchor; an uneditable card falls back to
        // its own container, which carries `tabIndex={-1}` so `.focus()` still lands.
        (document.getElementById(`provider-link-${focusProviderId}`) ?? card).focus();
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [focusProviderId, present]);

  if (providers.length === 0) return <Empty>{m['dashboard.providers.empty_state']()}</Empty>;

  return (
    <div className="space-y-4">
      {routingEditing ? (
        <div className="flex flex-col gap-3 rounded-xl border border-primary/25 bg-primary/5 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm font-medium">{m['dashboard.providers.routing.manage']()}</div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="provider-routing-cancel"
              disabled={routingMutation.isPending}
              onClick={() => {
                setDraft(null);
                onRoutingEditingChange?.(false);
              }}
            >
              <X />
              {m['common.cancel']()}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="provider-routing-save"
              disabled={!dirty || routingMutation.isPending}
              onClick={() =>
                routingMutation.mutate(providerRoutingMutation(currentBoard, draft?.revision ?? routingRevision), {
                  onSuccess: () => {
                    setDraft(null);
                    onRoutingEditingChange?.(false);
                  },
                  onError: (error) => {
                    if (
                      error instanceof Error &&
                      (error.message === 'stale_revision' || error.message === 'provider_set_changed')
                    ) {
                      setDraft(null);
                      onRoutingEditingChange?.(false);
                    }
                  },
                })
              }
            >
              <Check />
              {m['common.save']()}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          {/* `Field` is `w-full`, so the search box needs a bounded box of its own to share the row. */}
          <div className="md:w-64 md:shrink-0">
            <ProviderSearchField value={filters.search} onChange={(search) => setFilters({ ...filters, search })} />
          </div>
          <ProviderFilterChips filters={filters} onChange={setFilters} />
        </div>
      )}

      {routingEditing ? (
        <ProviderRoutingBoard
          board={currentBoard}
          providers={providers}
          onChange={(board) =>
            setDraft((current) =>
              current === null ? { board, savedBoard: currentBoard, revision: routingRevision } : { ...current, board },
            )
          }
        />
      ) : visible.length === 0 ? (
        <p role="status" data-testid="providers-no-matches" className="p-6 text-center text-sm text-muted-foreground">
          {m['dashboard.providers.card.no_matches']()}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {visible.map((provider) => {
            const presentation = provider.plugin === undefined ? undefined : pluginPresentations.get(provider.plugin);
            return (
              <ProviderCard
                key={provider.id}
                provider={provider}
                health={healthQuery.data?.get(provider.id)}
                usage={
                  usageQuery.data === undefined ? undefined : (usageQuery.data.get(provider.id) ?? zeroProviderUsage)
                }
                usagePending={usageQuery.isPending}
                pluginLabel={presentation?.displayName}
                pluginIcon={presentation?.icon}
                focused={provider.id === focusProviderId}
                onDelete={(target) => deleteDialogRef.current?.open(target)}
              />
            );
          })}
        </div>
      )}

      <DeleteProviderDialog
        ref={deleteDialogRef}
        onDeleted={() => {
          setDraft(null);
          onRoutingEditingChange?.(false);
        }}
      />
    </div>
  );
};
