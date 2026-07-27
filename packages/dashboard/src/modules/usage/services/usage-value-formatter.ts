import type { UsageOverviewMetric } from '@aio-proxy/types';

import { formatCompactTokenCount } from '@/components/token-count';

const NANO_USD_SCALE = 1_000_000_000n;

export const formatNanoUsd = (value: bigint, locale: string) => {
  const whole = value / NANO_USD_SCALE;
  const fraction = (value % NANO_USD_SCALE).toString().padStart(9, '0').replace(/0+$/u, '');
  const decimal = fraction === '' ? whole.toString() : `${whole}.${fraction}`;
  const formatter = new Intl.NumberFormat(locale, {
    currency: 'USD',
    maximumFractionDigits: 9,
    style: 'currency',
  });
  return (formatter.format as unknown as (value: string) => string)(decimal);
};

export const createUsageValueFormatter = (metric: UsageOverviewMetric, locale: string) => {
  if (metric === 'tokens') return formatCompactTokenCount;

  const formatter =
    metric === 'cost'
      ? new Intl.NumberFormat(locale, {
          currency: 'USD',
          maximumFractionDigits: 6,
          minimumFractionDigits: 0,
          style: 'currency',
        })
      : new Intl.NumberFormat(locale, {
          maximumFractionDigits: 0,
          notation: 'compact',
        });

  return (value: number) => formatter.format(value);
};
