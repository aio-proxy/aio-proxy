import { getLocale, m } from '@aio-proxy/i18n';
import type React from 'react';

import { formatCompactTokenCount } from '@/components/token-count';
import { formatDuration } from '@/lib/format-duration';

import type { ProviderHealth } from '../../services/provider-health-service';
import type { ProviderUsage } from '../../services/provider-usage-service';
import { ProviderCardStat } from './provider-card-stat';

interface ProviderCardStatsProps {
  readonly health: ProviderHealth | undefined;
  readonly usage: ProviderUsage | undefined;
  readonly usagePending: boolean;
}

const requestCountLabel = (usage: ProviderUsage | undefined, usagePending: boolean): string => {
  if (usagePending) return '…';
  return usage === undefined ? 'N/A' : formatCompactTokenCount(usage.requestCount);
};

export const ProviderCardStats: React.FC<ProviderCardStatsProps> = ({ health, usage, usagePending }) => (
  <div className="@container space-y-2">
    <p className="text-xs text-muted-foreground">{m['dashboard.usage.range_24h']()}</p>
    <div className="grid grid-cols-2 gap-2 @sm:grid-cols-4">
      <ProviderCardStat
        testId="provider-stat-requests"
        label={m['dashboard.usage.metric_requests']()}
        value={requestCountLabel(usage, usagePending)}
      />
      <ProviderCardStat
        testId="provider-stat-success-rate"
        label={m['dashboard.providers.card.stat_success_rate']()}
        value={health === undefined ? '—' : `${(health.successRate * 100).toFixed(1)}%`}
      />
      <ProviderCardStat
        testId="provider-stat-p95"
        label={m['dashboard.providers.card.stat_p95']()}
        value={health === undefined ? '—' : formatDuration(health.p95LatencyMs)}
      />
      <ProviderCardStat
        testId="provider-stat-throughput"
        label={m['dashboard.providers.card.stat_throughput']()}
        value={
          health?.outputTokensPerSecond == null
            ? '—'
            : `${new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(health.outputTokensPerSecond)} tok/s`
        }
      />
    </div>
  </div>
);
