import { getLocale, m } from '@aio-proxy/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import type { ReactNode } from 'react';

import { TokenCount } from '@/components/token-count';
import { formatNanoUsd } from '@/modules/usage/services/usage-value-formatter';

import type { OverviewData } from '../../services/overview-service';

interface OverviewKpiGridProps {
  readonly summary: OverviewData['summary'];
}

interface OverviewKpi {
  readonly label: string;
  readonly value: ReactNode;
}

export const OverviewKpiGrid: React.FC<OverviewKpiGridProps> = ({ summary }) => {
  const locale = getLocale();
  const numberFormatter = new Intl.NumberFormat(locale);
  const decimalFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const percentFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, style: 'percent' });
  const kpis: readonly OverviewKpi[] = [
    {
      label: m['dashboard.overview.summary_requests'](),
      value: numberFormatter.format(summary.requestCount),
    },
    {
      label: m['dashboard.overview.summary_tokens'](),
      value: <TokenCount value={summary.totalTokens} />,
    },
    {
      label: m['dashboard.overview.summary_cache_hit_rate'](),
      value: summary.cacheHitRate === null ? 'N/A' : percentFormatter.format(summary.cacheHitRate),
    },
    {
      label: m['dashboard.overview.summary_cost'](),
      value: formatNanoUsd(summary.estimatedCostNanoUsd, locale),
    },
    {
      label: m['dashboard.overview.summary_rpm'](),
      value: decimalFormatter.format(summary.averageRpm),
    },
    {
      label: m['dashboard.overview.summary_tpm'](),
      value: decimalFormatter.format(summary.averageTpm),
    },
  ];

  return (
    <div className="overview-kpi-grid gap-3" role="list" aria-label={m['dashboard.overview.summary_label']()}>
      {kpis.map((kpi) => (
        <Card key={kpi.label} size="sm" role="listitem">
          <CardHeader>
            <CardTitle role="heading" aria-level={2} className="text-sm text-muted-foreground">
              {kpi.label}
            </CardTitle>
          </CardHeader>
          <CardContent className="font-heading text-2xl font-semibold tabular-nums">{kpi.value}</CardContent>
        </Card>
      ))}
    </div>
  );
};
