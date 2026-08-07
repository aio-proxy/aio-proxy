import { getLocale, m } from '@aio-proxy/i18n';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { cn } from '@aio-proxy/ui/lib/utils';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { formatCompactTokenCount, TokenCount } from '@/components/token-count';
import { formatNanoUsd } from '@/modules/usage/services/usage-value-formatter';

import type { OverviewData } from '../../services/overview-service';

interface OverviewKpiGridProps {
  readonly summary: OverviewData['summary'];
}

/**
 * A missing baseline and a flat period are different facts, so they render
 * differently instead of collapsing into one hidden badge.
 */
type KpiDelta = { readonly ratio: number } | { readonly reason: 'no-baseline' };

interface OverviewKpi {
  readonly label: string;
  readonly value: ReactNode;
  readonly delta: KpiDelta;
  readonly note: ReactNode;
}

const deltaRatio = (current: bigint | number, previous: bigint | number): KpiDelta => {
  const now = Number(current);
  const before = Number(previous);
  if (before === 0) return now === 0 ? { ratio: 0 } : { reason: 'no-baseline' };
  return { ratio: (now - before) / before };
};

export const OverviewKpiGrid: React.FC<OverviewKpiGridProps> = ({ summary }) => {
  const locale = getLocale();
  const numberFormatter = new Intl.NumberFormat(locale);
  const decimalFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const percentFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, style: 'percent' });
  const signedPercent = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
    style: 'percent',
  });
  const current = summary.current;
  const previous = summary.previous;
  const kpis: readonly OverviewKpi[] = [
    {
      label: m['dashboard.overview.summary_requests'](),
      value: numberFormatter.format(current.requestCount),
      delta: deltaRatio(current.requestCount, previous.requestCount),
      note: m['dashboard.overview.summary_peak']({ value: numberFormatter.format(Math.round(summary.peakRpm)) }),
    },
    {
      label: m['dashboard.overview.summary_tokens'](),
      value: <TokenCount value={current.totalTokens} />,
      delta: deltaRatio(current.totalTokens, previous.totalTokens),
      note: m['dashboard.overview.summary_tokens_note']({
        input: formatCompactTokenCount(current.inputTokens),
        output: formatCompactTokenCount(current.outputTokens),
      }),
    },
    {
      label: m['dashboard.overview.summary_cache_hit_rate'](),
      value: current.cacheHitRate === null ? 'N/A' : percentFormatter.format(current.cacheHitRate),
      delta:
        current.cacheHitRate === null || previous.cacheHitRate === null
          ? { reason: 'no-baseline' }
          : { ratio: current.cacheHitRate - previous.cacheHitRate },
      note: m['dashboard.overview.summary_cache_reused']({ tokens: formatCompactTokenCount(current.cacheReadTokens) }),
    },
    {
      label: m['dashboard.overview.summary_cost'](),
      value: formatNanoUsd(current.estimatedCostNanoUsd, locale, 'compact'),
      delta: deltaRatio(current.estimatedCostNanoUsd, previous.estimatedCostNanoUsd),
      note: m['dashboard.overview.summary_cost_note'](),
    },
    {
      label: m['dashboard.overview.summary_rpm'](),
      value: decimalFormatter.format(current.averageRpm),
      delta: deltaRatio(current.averageRpm, previous.averageRpm),
      note: m['dashboard.overview.summary_peak']({ value: decimalFormatter.format(summary.peakRpm) }),
    },
    {
      label: m['dashboard.overview.summary_tpm'](),
      value: decimalFormatter.format(current.averageTpm),
      delta: deltaRatio(current.averageTpm, previous.averageTpm),
      note: m['dashboard.overview.summary_peak']({ value: decimalFormatter.format(summary.peakTpm) }),
    },
  ];

  return (
    <div className="overview-kpi-grid gap-3" role="list" aria-label={m['dashboard.overview.summary_label']()}>
      {kpis.map((kpi) => (
        <Card key={kpi.label} size="sm" role="listitem">
          <CardHeader>
            <CardTitle role="heading" aria-level={2} className="text-sm font-normal text-muted-foreground">
              {kpi.label}
            </CardTitle>
            <CardAction>
              {'reason' in kpi.delta ? (
                <span className="text-xs font-medium text-muted-foreground">
                  {m['dashboard.overview.summary_delta_no_baseline']()}
                </span>
              ) : (
                <span
                  className={cn(
                    'inline-flex items-center gap-0.5 text-xs font-medium tabular-nums',
                    kpi.delta.ratio < 0 ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400',
                  )}
                  aria-label={m['dashboard.overview.summary_delta_period']()}
                >
                  {kpi.delta.ratio < 0 ? <ArrowDownRight className="size-3" /> : <ArrowUpRight className="size-3" />}
                  {signedPercent.format(kpi.delta.ratio)}
                </span>
              )}
            </CardAction>
            <CardDescription className="truncate text-xs">{kpi.note}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-heading text-2xl font-semibold tabular-nums">{kpi.value}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
};
