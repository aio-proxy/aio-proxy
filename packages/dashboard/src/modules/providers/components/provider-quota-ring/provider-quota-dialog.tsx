import { getLocale, m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@aio-proxy/ui/components/dialog';
import { RotateCw } from 'lucide-react';
import type React from 'react';

import { resolveDashboardText } from '@/lib/localized-text';

import { PROVIDER_DIALOG_FRAME_SIZE } from '../../lib/constants';
import { providerDisplayName } from '../../lib/provider-list-view';
import { applicableQuotaItems } from '../../lib/quota-view';
import type { ProviderQuotaResult } from '../../services/provider-quota-service';
import { ProviderAvatar } from '../provider-avatar';
import { ProviderQuotaItem } from './provider-quota-item';
import { ProviderQuotaResetButton } from './provider-quota-reset-button';

interface ProviderQuotaDialogProps {
  readonly provider: DashboardProviderSummary;
  readonly pluginLabel: string | undefined;
  readonly pluginIcon: string | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly result: ProviderQuotaResult | undefined;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
}

export const ProviderQuotaDialog: React.FC<ProviderQuotaDialogProps> = ({
  provider,
  pluginLabel,
  pluginIcon,
  open,
  onOpenChange,
  result,
  onRefresh,
  refreshing,
}) => {
  const plan = result?.snapshot.plan;
  const source = pluginLabel ?? provider.plugin;
  const resolvedPlan = plan === undefined ? undefined : resolveDashboardText(plan);
  const items = applicableQuotaItems(result?.snapshot);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={m['common.close']()}
        // The refresh control now lives in the footer, so a Provider with many quota windows could
        // push it past a short viewport with nothing to scroll: the popup is an unbounded grid.
        className="max-h-[85dvh] overflow-y-auto"
        data-testid="provider-quota-dialog"
      >
        {/* `DialogContent` puts its own close button at `absolute top-4 right-4`, `size-7`, so it
            covers 16..44px in from the popup edge while `p-6` ends this row at 24px. The title
            truncates at the container edge, so without the reservation a long name runs under it. */}
        <DialogHeader className="pr-8">
          <div className="flex items-start gap-3">
            <ProviderAvatar
              name={providerDisplayName(provider)}
              icon={pluginIcon}
              size={PROVIDER_DIALOG_FRAME_SIZE}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate">{providerDisplayName(provider)}</DialogTitle>
              <DialogDescription className="truncate">
                {[source, resolvedPlan].filter((part) => part !== undefined).join(' · ')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {result === undefined ? (
          <p role="status" data-testid="provider-quota-dialog-unavailable" className="text-sm text-muted-foreground">
            {m['dashboard.providers.quota.load_failed']()}
          </p>
        ) : (
          <>
            {result.stale ? (
              <p
                role="status"
                data-testid="provider-quota-stale"
                className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs"
              >
                {m['dashboard.providers.quota.stale_notice']()}
              </p>
            ) : null}
            {/* Windows the upstream reported no remaining amount for are dropped, so a snapshot can
                carry items and still have nothing to show. Say that rather than render an empty list. */}
            {items.length === 0 ? (
              <p role="status" data-testid="provider-quota-empty" className="text-sm text-muted-foreground">
                {m['dashboard.providers.quota.no_windows']()}
              </p>
            ) : (
              <ul className="space-y-3">
                {items.map((item) => (
                  <ProviderQuotaItem key={item.id} item={item} />
                ))}
              </ul>
            )}
            {result.snapshot.resetCredits === undefined ? null : (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-xs text-muted-foreground">
                  {m['dashboard.providers.quota.reset_credits']({ count: result.snapshot.resetCredits.availableCount })}
                </p>
                {/* Reporting an inventory obliges the plugin to implement redemption, so the count is
                    the whole gate: nothing to spend means no control rather than one that always fails. */}
                {result.snapshot.resetCredits.availableCount > 0 ? (
                  <ProviderQuotaResetButton
                    providerId={provider.id}
                    availableCount={result.snapshot.resetCredits.availableCount}
                  />
                ) : null}
              </div>
            )}
          </>
        )}

        {/* Outside the ternary on purpose: a failed first read is only recoverable by refreshing, so
            the control cannot live in a branch. The timestamp is the fact refresh acts on, which is
            why the two share a row. `flex-col` overrides `DialogFooter`'s `flex-col-reverse`, which
            would stack the button above the timestamp it annotates; `mr-auto` rather than
            `justify-between` so the button still right-aligns when there is no timestamp. */}
        <DialogFooter className="flex-col items-start gap-3 sm:flex-row sm:items-center">
          {result === undefined ? null : (
            <p className="mr-auto min-w-0 text-xs text-muted-foreground">
              {m['dashboard.providers.quota.sampled_at']({
                value: new Date(result.sampledAt).toLocaleString(getLocale()),
              })}
            </p>
          )}
          {/* `focusableWhenDisabled` because the button disables itself while refreshing: inside a
              focus-trapped modal that would otherwise drop a keyboard user's focus mid-request. */}
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="provider-quota-refresh"
            disabled={refreshing}
            focusableWhenDisabled
            onClick={onRefresh}
          >
            <RotateCw data-icon="inline-start" className={refreshing ? 'animate-spin' : ''} />
            {m['dashboard.providers.quota.refresh']()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
