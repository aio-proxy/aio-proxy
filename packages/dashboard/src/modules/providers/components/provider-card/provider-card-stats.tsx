import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import type React from 'react';

import type { ProviderHealth } from '../../services/provider-health-service';
import { ProviderCardStat } from './provider-card-stat';

interface ProviderCardStatsProps {
  readonly provider: DashboardProviderSummary;
  readonly health: ProviderHealth | undefined;
}

export const ProviderCardStats: React.FC<ProviderCardStatsProps> = ({ provider, health }) => (
  <div className="grid grid-cols-4 gap-2">
    <ProviderCardStat
      testId="provider-stat-priority"
      label={m['dashboard.providers.card.stat_priority']()}
      value={String(provider.priority ?? 0)}
    />
    <ProviderCardStat
      testId="provider-stat-weight"
      label={m['dashboard.providers.card.stat_weight']()}
      value={String(provider.weight ?? 1)}
    />
    <ProviderCardStat
      testId="provider-stat-success-rate"
      label={m['dashboard.providers.card.stat_success_rate']()}
      value={health === undefined ? '—' : `${(health.successRate * 100).toFixed(1)}%`}
    />
    <ProviderCardStat
      testId="provider-stat-p95"
      label={m['dashboard.providers.card.stat_p95']()}
      value={health === undefined ? '—' : `${Math.round(health.p95LatencyMs)} ms`}
    />
  </div>
);
