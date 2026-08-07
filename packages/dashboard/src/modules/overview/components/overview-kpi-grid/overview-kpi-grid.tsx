import { getLocale, m } from '@aio-proxy/i18n';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { cn } from '@aio-proxy/ui/lib/utils';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { COMPACT_TOKEN_LOCALE, formatCompactTokenCount, formatExactTokenCount } from '@/components/token-count';
import { formatNanoUsd, nanoUsdFormatOptions, nanoUsdToDecimal } from '@/lib/nano-usd';

import type { OverviewData } from '../../services/overview-service';
import { KpiNumber } from './kpi-number';

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

const COMPACT_TOKEN_FORMAT = { maximumFractionDigits: 1, notation: 'compact' } as const;
const DECIMAL_FORMAT = { maximumFractionDigits: 1 } as const;
const PERCENT_FORMAT = { maximumFractionDigits: 1, style: 'percent' } as const;

export const OverviewKpiGrid: React.FC<OverviewKpiGridProps> = ({ summary }) => {
  const locale = getLocale();
  const numberFormatter = new Intl.NumberFormat(locale);
  const decimalFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
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
      value: <KpiNumber value={Number(current.requestCount)} format={{}} locales={locale} />,
      delta: deltaRatio(current.requestCount, previous.requestCount),
      note: m['dashboard.overview.summary_peak']({ value: numberFormatter.format(Math.round(summary.peakRpm)) }),
    },
    {
      label: m['dashboard.overview.summary_tokens'](),
      value: (
        <KpiNumber
          value={Number(current.totalTokens)}
          format={COMPACT_TOKEN_FORMAT}
          locales={COMPACT_TOKEN_LOCALE}
          tooltip={formatExactTokenCount(current.totalTokens, locale)}
        />
      ),
      delta: deltaRatio(current.totalTokens, previous.totalTokens),
      note: m['dashboard.overview.summary_tokens_note']({
        input: formatCompactTokenCount(current.inputTokens),
        output: formatCompactTokenCount(current.outputTokens),
      }),
    },
    {
      label: m['dashboard.overview.summary_cache_hit_rate'](),
      value:
        current.cacheHitRate === null ? (
          'N/A'
        ) : (
          <KpiNumber value={current.cacheHitRate} format={PERCENT_FORMAT} locales={locale} />
        ),
      delta:
        current.cacheHitRate === null || previous.cacheHitRate === null
          ? { reason: 'no-baseline' }
          : { ratio: current.cacheHitRate - previous.cacheHitRate },
      note: m['dashboard.overview.summary_cache_reused']({ tokens: formatCompactTokenCount(current.cacheReadTokens) }),
    },
    {
      label: m['dashboard.overview.summary_cost'](),
      value: (
        <KpiNumber
          value={nanoUsdToDecimal(current.estimatedCostNanoUsd)}
          format={nanoUsdFormatOptions('compact')}
          locales={locale}
          tooltip={formatNanoUsd(current.estimatedCostNanoUsd, locale)}
        />
      ),
      delta: deltaRatio(current.estimatedCostNanoUsd, previous.estimatedCostNanoUsd),
      note: m['dashboard.overview.summary_cost_note'](),
    },
    {
      label: m['dashboard.overview.summary_rpm'](),
      value: <KpiNumber value={current.averageRpm} format={DECIMAL_FORMAT} locales={locale} />,
      delta: deltaRatio(current.averageRpm, previous.averageRpm),
      note: m['dashboard.overview.summary_peak']({ value: decimalFormatter.format(summary.peakRpm) }),
    },
    {
      label: m['dashboard.overview.summary_tpm'](),
      value: (
        <KpiNumber
          value={current.averageTpm}
          format={COMPACT_TOKEN_FORMAT}
          locales={COMPACT_TOKEN_LOCALE}
          tooltip={formatExactTokenCount(Math.round(current.averageTpm), locale)}
        />
      ),
      delta: deltaRatio(current.averageTpm, previous.averageTpm),
      note: m['dashboard.overview.summary_peak']({ value: formatCompactTokenCount(summary.peakTpm) }),
    },
  ];

  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6"
      role="list"
      aria-label={m['dashboard.overview.summary_label']()}
    >
      {kpis.map((kpi) => (
        <Card key={kpi.label} size="sm" role="listitem">
          <CardHeader>
            <CardTitle role="heading" aria-level={2} className="flex items-center justify-between gap-2">
              <span data-testid="kpi-label">{kpi.label}</span>
              {'reason' in kpi.delta ? (
                <span className="text-sm font-normal text-muted-foreground">
                  {m['dashboard.overview.summary_delta_no_baseline']()}
                </span>
              ) : (
                <span
                  className={cn(
                    'inline-flex items-center gap-0.5 text-sm font-normal tabular-nums',
                    kpi.delta.ratio < 0 ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400',
                  )}
                  aria-label={m['dashboard.overview.summary_delta_period']()}
                >
                  {kpi.delta.ratio < 0 ? <ArrowDownRight className="size-3" /> : <ArrowUpRight className="size-3" />}
                  {signedPercent.format(kpi.delta.ratio)}
                </span>
              )}
            </CardTitle>
            <CardDescription className="truncate">{kpi.note}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-heading text-2xl font-semibold tabular-nums">{kpi.value}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
};
