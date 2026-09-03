import { getLocale, m } from '@aio-proxy/i18n';
import { Progress, ProgressLabel, ProgressValue } from '@aio-proxy/ui/components/progress';
import type React from 'react';

import { resolveDashboardText } from '@/lib/localized-text';

import { type ApplicableQuotaItem, remainingPercent } from '../../lib/quota-view';

interface ProviderQuotaItemProps {
  readonly item: ApplicableQuotaItem;
}

export const ProviderQuotaItem: React.FC<ProviderQuotaItemProps> = ({ item }) => {
  const percent = remainingPercent(item.remainingRatio);
  const tiny = item.remainingRatio > 0 && item.remainingRatio < 0.01;
  const remaining = tiny
    ? m['dashboard.providers.quota.less_than_one_percent']()
    : m['dashboard.providers.quota.remaining']({ percent });
  return (
    <li className="space-y-1" data-testid={`provider-quota-item-${item.id}`}>
      {/* The text floors a non-empty quota up to 1% so it never reads "0%", but the track has no such
          rounding to justify: it takes the raw ratio and stays honestly near-empty. `ProgressValue`
          renders `aria-hidden`, so `getAriaValueText` is what a screen reader gets — without it the
          near-empty window would be announced as the bare "0%" the visible text exists to avoid. */}
      <Progress value={tiny ? 0 : percent} getAriaValueText={() => remaining} className="gap-x-2 gap-y-1">
        <ProgressLabel className="min-w-0 truncate font-normal">{resolveDashboardText(item.displayName)}</ProgressLabel>
        <ProgressValue>{() => remaining}</ProgressValue>
      </Progress>
      {item.resetsAt === undefined ? null : (
        <p className="text-xs text-muted-foreground">
          {m['dashboard.providers.quota.resets_at']({ value: new Date(item.resetsAt).toLocaleString(getLocale()) })}
        </p>
      )}
    </li>
  );
};
