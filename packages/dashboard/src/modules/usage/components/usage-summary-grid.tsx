import { getLocale, m } from '@aio-proxy/i18n';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Activity, CircleCheckBig, CircleDollarSign, Cpu, Gauge, Zap } from 'lucide-react';
import type { ReactNode } from 'react';

import { formatCompactTokenCount, TokenCount } from '@/components/token-count';

import type { UsageOverviewSummary } from '../services/usage-service';
import { formatNanoUsd } from '../services/usage-value-formatter';

interface UsageSummaryGridProps {
  readonly summary: UsageOverviewSummary;
}

interface UsageSummaryCard {
  readonly icon: typeof CircleDollarSign;
  readonly label: string;
  readonly value: ReactNode;
  readonly detail: ReactNode;
}

export const UsageSummaryGrid: React.FC<UsageSummaryGridProps> = ({ summary }) => {
  const locale = getLocale();
  const numberFormatter = new Intl.NumberFormat(locale);
  const decimalFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const percentFormatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: 'percent',
  });
  const notAvailable = 'N/A';
  const cards: readonly UsageSummaryCard[] = [
    {
      icon: CircleDollarSign,
      label: m['dashboard.usage.summary_cost'](),
      value: formatNanoUsd(summary.estimatedCostNanoUsd, locale),
      detail:
        summary.pricingCoverage === null
          ? m['dashboard.usage.pricing_coverage']({ coverage: notAvailable })
          : m['dashboard.usage.pricing_coverage']({ coverage: percentFormatter.format(summary.pricingCoverage) }),
    },
    {
      icon: Activity,
      label: m['dashboard.usage.summary_requests'](),
      value: numberFormatter.format(summary.requestCount),
      detail: m['dashboard.usage.requests_description']({
        success: numberFormatter.format(summary.successCount),
        failure: numberFormatter.format(summary.failureCount),
        cancelled: numberFormatter.format(summary.cancelledCount),
      }),
    },
    {
      icon: Cpu,
      label: m['dashboard.usage.summary_tokens'](),
      value: <TokenCount value={summary.totalTokens} />,
      detail: m['dashboard.usage.tokens_description']({
        input: formatCompactTokenCount(summary.inputTokens),
        output: formatCompactTokenCount(summary.outputTokens),
      }),
    },
    {
      icon: Gauge,
      label: m['dashboard.usage.summary_average_rpm'](),
      value: decimalFormatter.format(summary.averageRpm),
      detail: m['dashboard.usage.average_rpm_description'](),
    },
    {
      icon: Zap,
      label: m['dashboard.usage.summary_average_tpm'](),
      value: decimalFormatter.format(summary.averageTpm),
      detail: m['dashboard.usage.average_tpm_description'](),
    },
    {
      icon: CircleCheckBig,
      label: m['dashboard.usage.summary_success_rate'](),
      value: summary.successRate === null ? notAvailable : percentFormatter.format(summary.successRate),
      detail: m['dashboard.usage.success_rate_description'](),
    },
  ];

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {cards.map((card) => (
        <Card key={card.label} size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <card.icon className="size-4 text-muted-foreground" />
              {card.label}
            </CardTitle>
            <CardDescription>{card.detail}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-heading text-2xl font-semibold tabular-nums">{card.value}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
};
