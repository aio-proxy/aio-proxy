import { getLocale, m } from "@aio-proxy/i18n";
import { Activity, CircleCheckBig, CircleDollarSign, Cpu, Gauge, Zap } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { UsageOverviewSummary } from "../services/usage-service";

type Props = {
  readonly summary: UsageOverviewSummary;
};

export const UsageSummaryGrid: React.FC<Props> = ({ summary }) => {
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
  const cards = [
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
      value: numberFormatter.format(summary.totalTokens),
      detail: m["dashboard.usage.tokens_description"]({
        input: numberFormatter.format(summary.inputTokens),
        output: numberFormatter.format(summary.outputTokens),
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
  ] as const;

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
            <div className="font-heading font-semibold text-2xl tabular-nums">{card.value}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
};
