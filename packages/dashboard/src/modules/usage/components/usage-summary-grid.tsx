import type { ReactNode } from "react";

import { getLocale, m } from "@aio-proxy/i18n";
import { Activity, CircleCheckBig, CircleDollarSign, Cpu, Gauge, Zap } from "lucide-react";

import { formatCompactTokenCount, TokenCount } from "@/components/token-count";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import type { UsageOverviewSummary } from "../services/usage-service";

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
  const numberFormatter = new Intl.NumberFormat(getLocale());
  const decimalFormatter = new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 });
  const costFormatter = new Intl.NumberFormat(getLocale(), {
    currency: "USD",
    maximumFractionDigits: 6,
    style: "currency",
  });
  const percentFormatter = new Intl.NumberFormat(getLocale(), {
    maximumFractionDigits: 1,
    style: "percent",
  });
  const notAvailable = m["dashboard.usage.not_available"]();
  const cards: readonly UsageSummaryCard[] = [
    {
      icon: CircleDollarSign,
      label: m["dashboard.usage.summary_cost"](),
      value: costFormatter.format(summary.estimatedCostUsd),
      detail:
        summary.pricingCoverage === null
          ? m["dashboard.usage.pricing_coverage"]({ coverage: notAvailable })
          : m["dashboard.usage.pricing_coverage"]({ coverage: percentFormatter.format(summary.pricingCoverage) }),
    },
    {
      icon: Activity,
      label: m["dashboard.usage.summary_requests"](),
      value: numberFormatter.format(summary.requestCount),
      detail: m["dashboard.usage.requests_description"]({
        success: numberFormatter.format(summary.successCount),
        failure: numberFormatter.format(summary.failureCount),
        cancelled: numberFormatter.format(summary.cancelledCount),
      }),
    },
    {
      icon: Cpu,
      label: m["dashboard.usage.summary_tokens"](),
      value: <TokenCount value={summary.totalTokens} />,
      detail: m["dashboard.usage.tokens_description"]({
        input: formatCompactTokenCount(summary.inputTokens),
        output: formatCompactTokenCount(summary.outputTokens),
      }),
    },
    {
      icon: Gauge,
      label: m["dashboard.usage.summary_average_rpm"](),
      value: decimalFormatter.format(summary.averageRpm),
      detail: m["dashboard.usage.average_rpm_description"](),
    },
    {
      icon: Zap,
      label: m["dashboard.usage.summary_average_tpm"](),
      value: decimalFormatter.format(summary.averageTpm),
      detail: m["dashboard.usage.average_tpm_description"](),
    },
    {
      icon: CircleCheckBig,
      label: m["dashboard.usage.summary_success_rate"](),
      value: summary.successRate === null ? notAvailable : percentFormatter.format(summary.successRate),
      detail: m["dashboard.usage.success_rate_description"](),
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
