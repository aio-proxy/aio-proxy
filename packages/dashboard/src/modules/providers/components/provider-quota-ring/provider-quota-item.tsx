import { getLocale, m } from '@aio-proxy/i18n';
import type React from 'react';

import { resolveDashboardText } from '@/lib/localized-text';

import { type ApplicableQuotaItem, remainingPercent } from '../../lib/quota-view';

interface ProviderQuotaItemProps {
  readonly item: ApplicableQuotaItem;
}

export const ProviderQuotaItem: React.FC<ProviderQuotaItemProps> = ({ item }) => {
  const percent = remainingPercent(item.remainingRatio);
  const tiny = item.remainingRatio > 0 && item.remainingRatio < 0.01;
  return (
    <li className="space-y-1" data-testid={`provider-quota-item-${item.id}`}>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="truncate">{resolveDashboardText(item.displayName)}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {tiny
            ? m['dashboard.providers.quota.less_than_one_percent']()
            : m['dashboard.providers.quota.remaining']({ percent })}
        </span>
      </div>
      {/* Bars never recolor by tightness: the ring already carries that signal. */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" data-testid={`provider-quota-bar-${item.id}`}>
        <div className="h-full rounded-full bg-primary" style={{ width: tiny ? '0%' : `${percent}%` }} />
      </div>
      {item.resetsAt === undefined ? null : (
        <p className="text-xs text-muted-foreground">
          {m['dashboard.providers.quota.resets_at']({ value: new Date(item.resetsAt).toLocaleString(getLocale()) })}
        </p>
      )}
    </li>
  );
};
