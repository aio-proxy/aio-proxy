import { getLocale, m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@aio-proxy/ui/components/dialog';
import { RotateCw } from 'lucide-react';
import type React from 'react';

import { resolveDashboardText } from '@/lib/localized-text';

import { providerDisplayName } from '../../lib/provider-list-view';
import type { ProviderQuotaResult } from '../../services/provider-quota-service';
import { ProviderAvatar } from '../provider-avatar';
import { ProviderQuotaItem } from './provider-quota-item';

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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={m['common.close']()} data-testid="provider-quota-dialog">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <ProviderAvatar
              name={providerDisplayName(provider)}
              icon={pluginIcon}
              size={32}
              className="mt-0.5 size-8"
            />
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate">{providerDisplayName(provider)}</DialogTitle>
              <DialogDescription className="truncate">
                {[source, resolvedPlan].filter((part) => part !== undefined).join(' · ')}
              </DialogDescription>
            </div>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-testid="provider-quota-refresh"
              disabled={refreshing}
              onClick={onRefresh}
            >
              <RotateCw className={refreshing ? 'animate-spin' : ''} />
              {m['dashboard.providers.quota.refresh']()}
            </Button>
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
            <ul className="space-y-3">
              {result.snapshot.items.map((item) => (
                <ProviderQuotaItem key={item.id} item={item} />
              ))}
            </ul>
            {result.snapshot.resetCredits === undefined ? null : (
              <p className="text-xs text-muted-foreground">
                {m['dashboard.providers.quota.reset_credits']({ count: result.snapshot.resetCredits.availableCount })}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {m['dashboard.providers.quota.sampled_at']({
                value: new Date(result.sampledAt).toLocaleString(getLocale()),
              })}
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
