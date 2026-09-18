import { getLocale, m } from '@aio-proxy/i18n';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@aio-proxy/ui/components/hover-card';
import type React from 'react';

import { compactNanoUsdDisplay } from '@/lib/nano-usd';

import { estimateQuotaPeriodNanoUsd, quotaPeriodEstimateIsApproximate } from '../../lib/quota-period-estimate';

interface ProviderQuotaCostProps {
  readonly itemId: string;
  readonly remainingRatio: number;
  readonly estimate: { readonly usedNanoUsd: string };
}

const compactAmount = (value: bigint, locale: string) => {
  const display = compactNanoUsdDisplay(value, locale);
  return display.subCent ? m['dashboard.providers.quota.cost_less_than']() : display.compact;
};

export const ProviderQuotaCost: React.FC<ProviderQuotaCostProps> = ({ itemId, remainingRatio, estimate }) => {
  const locale = getLocale();
  const usedNanoUsd = BigInt(estimate.usedNanoUsd);
  const usedDisplay = compactNanoUsdDisplay(usedNanoUsd, locale);
  const used = usedDisplay.subCent ? m['dashboard.providers.quota.cost_less_than']() : usedDisplay.compact;
  if (used === undefined) return null;
  const periodNanoUsd = estimateQuotaPeriodNanoUsd(usedNanoUsd, remainingRatio);
  const period = periodNanoUsd === undefined ? undefined : compactAmount(periodNanoUsd, locale);
  const periodLabel =
    period === undefined
      ? undefined
      : quotaPeriodEstimateIsApproximate(remainingRatio)
        ? m['dashboard.providers.quota.cost_period_approx']({ amount: period })
        : m['dashboard.providers.quota.cost_period']({ amount: period });
  const usedLabel = m['dashboard.providers.quota.cost_used']({ amount: used });
  const usedExactLabel = m['dashboard.providers.quota.cost_used']({ amount: usedDisplay.exact });
  const hint = m['dashboard.providers.quota.cost_period_hint']();
  const ariaDescription = [usedExactLabel, periodLabel, hint].filter((part) => part !== undefined).join('. ');
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={0}
        closeDelay={0}
        render={
          <span
            className="shrink-0 text-xs text-muted-foreground"
            data-testid={`provider-quota-cost-${itemId}`}
            aria-description={ariaDescription}
            tabIndex={0}
          />
        }
      >
        {usedLabel}
      </HoverCardTrigger>
      <HoverCardContent align="end" side="top" className="w-64 space-y-1 p-3 text-sm">
        <p data-testid={`provider-quota-cost-used-${itemId}`}>{usedExactLabel}</p>
        {periodLabel === undefined ? null : <p data-testid={`provider-quota-cost-period-${itemId}`}>{periodLabel}</p>}
        <p className="text-xs text-muted-foreground">{hint}</p>
      </HoverCardContent>
    </HoverCard>
  );
};
