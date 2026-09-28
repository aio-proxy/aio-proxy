import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel } from '@aio-proxy/types';
import { Card, CardContent } from '@aio-proxy/ui/components/card';
import type React from 'react';

import { modelTrafficSummary } from '../lib/routing-traffic';
import type { RoutingTrafficProviderTotals } from '../services/routing-traffic-service';

const numberFormatter = new Intl.NumberFormat();
const percentFormatter = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });

interface RoutingModelSummaryProps {
  readonly model: DashboardRoutingModel;
  /** `undefined` while traffic is unknown: every figure then reads as unknown, never as zero. */
  readonly totals: readonly RoutingTrafficProviderTotals[] | undefined;
  readonly known: boolean;
}

/** The selected range at a glance: how much the model served, how reliably, and how often T1 fell through. */
export const RoutingModelSummary: React.FC<RoutingModelSummaryProps> = ({ model, totals, known }) => {
  const summary = modelTrafficSummary(totals);
  const primary = new Set(model.tiers[0]?.providers.map((entry) => entry.providerId) ?? []);
  const fallback = totals?.reduce((sum, row) => (primary.has(row.providerId) ? sum : sum + row.finalCount), 0n);
  const unknown = '—';
  const stats = [
    {
      label: m['dashboard.routing.detail.stat_requests'](),
      value: !known ? unknown : numberFormatter.format(summary?.finalCount ?? 0n),
    },
    {
      label: m['dashboard.overview.success_rate'](),
      value: summary?.successRate == null ? unknown : percentFormatter.format(summary.successRate),
    },
    {
      label: m['dashboard.routing.detail.stat_fallback'](),
      value: !known ? unknown : numberFormatter.format(fallback ?? 0n),
    },
    {
      label: m['dashboard.routing.detail.stat_providers'](),
      value: `${model.eligibleProviderCount} / ${model.providerCount}`,
    },
  ];

  return (
    <Card size="sm" data-testid="routing-model-summary">
      <CardContent className="flex flex-wrap gap-x-8 gap-y-3">
        {stats.map((stat) => (
          <div key={stat.label} className="flex flex-col">
            <span className="text-xs text-muted-foreground">{stat.label}</span>
            <span className="font-heading text-lg font-medium tabular-nums">{stat.value}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
};
