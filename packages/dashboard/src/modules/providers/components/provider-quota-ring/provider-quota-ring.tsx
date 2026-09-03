import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { cn } from '@aio-proxy/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import type React from 'react';
import { useState } from 'react';

import { useProviderQuotaRefresh } from '../../hooks/use-provider-quota-refresh';
import { remainingPercent, tightestQuotaItem } from '../../lib/quota-view';
import { providerQuotaQueryOptions } from '../../services/provider-quota-service';
import { ProviderQuotaDialog } from './provider-quota-dialog';

const SIZE = 28;
const STROKE = 3;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface ProviderQuotaRingProps {
  readonly provider: DashboardProviderSummary;
  readonly pluginLabel?: string;
  readonly pluginIcon?: string;
}

export const ProviderQuotaRing: React.FC<ProviderQuotaRingProps> = ({ provider, pluginLabel, pluginIcon }) => {
  const [open, setOpen] = useState(false);
  const query = useQuery(providerQuotaQueryOptions(provider.id));
  const refresh = useProviderQuotaRefresh(provider.id);
  const tightest = tightestQuotaItem(query.data?.snapshot);

  // Opening always asks upstream for a fresh reading; the ring itself is happy with the cached one.
  const openDialog = () => {
    setOpen(true);
    refresh.mutate();
  };

  if (query.isPending) {
    return (
      <span
        className="size-7 shrink-0 animate-pulse rounded-full border-2 border-muted"
        aria-label={m['dashboard.providers.quota.loading']()}
        data-testid="provider-quota-loading"
      />
    );
  }

  // `retry: false` means one failure is final for this query. An inert indicator would strand the
  // card, so the failure state is the same button: it opens the dialog and fires a refresh.
  if (query.isError || query.data === undefined) {
    return (
      <>
        <button
          type="button"
          data-testid="provider-quota-unavailable"
          aria-label={m['dashboard.providers.quota.load_failed']()}
          title={m['dashboard.providers.quota.load_failed']()}
          className="size-7 shrink-0 rounded-full border-2 border-dashed border-muted-foreground/40 focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={(event) => {
            event.stopPropagation();
            event.preventDefault();
            openDialog();
          }}
        />
        <ProviderQuotaDialog
          provider={provider}
          pluginLabel={pluginLabel}
          pluginIcon={pluginIcon}
          open={open}
          onOpenChange={setOpen}
          result={undefined}
          onRefresh={() => refresh.mutate()}
          refreshing={refresh.isPending}
        />
      </>
    );
  }

  const ratio = tightest?.remainingRatio;
  const percent = ratio === undefined ? undefined : remainingPercent(ratio);
  // Geometry uses the clamped raw ratio. `remainingPercent` floors a non-zero remainder at 1% for
  // the label; drawing that would show a visible arc for a nearly-exhausted quota.
  const clamped = ratio === undefined ? 0 : Math.min(Math.max(ratio, 0), 1);
  const offset = CIRCUMFERENCE * (1 - clamped);

  return (
    <>
      <button
        type="button"
        data-testid="provider-quota-ring"
        aria-label={m['dashboard.providers.quota.ring_label']({ id: provider.id })}
        className={cn('relative shrink-0 rounded-full focus-visible:ring-2 focus-visible:ring-ring/40')}
        onClick={(event) => {
          // The card body is one big link; the ring opens a modal instead of navigating.
          event.stopPropagation();
          event.preventDefault();
          openDialog();
        }}
      >
        <svg width={SIZE} height={SIZE} className="-rotate-90" aria-hidden="true">
          <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} className="stroke-muted" />
          <circle
            data-testid="provider-quota-arc"
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
            className="stroke-primary"
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[9px] font-medium tabular-nums">
          {percent === undefined ? '—' : percent}
        </span>
      </button>
      <ProviderQuotaDialog
        provider={provider}
        pluginLabel={pluginLabel}
        pluginIcon={pluginIcon}
        open={open}
        onOpenChange={setOpen}
        result={query.data}
        onRefresh={() => refresh.mutate()}
        refreshing={refresh.isPending}
      />
    </>
  );
};
