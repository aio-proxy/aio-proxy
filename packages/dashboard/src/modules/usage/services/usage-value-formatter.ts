import type { UsageOverviewMetric } from "@aio-proxy/types";

import { formatCompactTokenCount } from "@/components/token-count";

export const createUsageValueFormatter = (metric: UsageOverviewMetric, locale: string) => {
  if (metric === "tokens") return formatCompactTokenCount;

  const formatter =
    metric === "cost"
      ? new Intl.NumberFormat(locale, {
          currency: "USD",
          maximumFractionDigits: 6,
          minimumFractionDigits: 0,
          style: "currency",
        })
      : new Intl.NumberFormat(locale, {
          maximumFractionDigits: 0,
          notation: "compact",
        });

  return (value: number) => formatter.format(value);
};
