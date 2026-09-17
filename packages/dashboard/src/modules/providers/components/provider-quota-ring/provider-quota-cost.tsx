import { getLocale, m } from '@aio-proxy/i18n';
import type React from 'react';

import { compactNanoUsdDisplay } from '@/lib/nano-usd';

interface ProviderQuotaCostProps {
  readonly itemId: string;
  readonly estimate: { readonly usedNanoUsd: string };
}

export const ProviderQuotaCost: React.FC<ProviderQuotaCostProps> = ({ itemId, estimate }) => {
  const locale = getLocale();
  const display = compactNanoUsdDisplay(BigInt(estimate.usedNanoUsd), locale);
  const amount = display.subCent ? m['dashboard.providers.quota.cost_less_than']() : display.compact;
  if (amount === undefined) return null;
  const note = m['dashboard.providers.quota.cost_note']();
  return (
    <p
      className="text-xs text-muted-foreground"
      data-testid={`provider-quota-cost-${itemId}`}
      title={display.exact}
      aria-description={note}
    >
      {m['dashboard.providers.quota.cost_used']({ amount })}
    </p>
  );
};
