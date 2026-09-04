import { m } from '@aio-proxy/i18n';
import type React from 'react';

import type { ProviderHealth } from '../../services/provider-health-service';
import { ProviderCardStat } from './provider-card-stat';

interface ProviderCardStatsProps {
  readonly health: ProviderHealth | undefined;
  readonly share: number;
}

export const ProviderCardStats: React.FC<ProviderCardStatsProps> = ({ health, share }) => (
  <div className="grid grid-cols-3 gap-2">
    <ProviderCardStat
      testId="provider-stat-share"
      label={m['dashboard.providers.routing.share']()}
      value={`${share}%`}
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
