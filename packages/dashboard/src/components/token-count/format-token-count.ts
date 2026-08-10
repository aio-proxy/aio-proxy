export const COMPACT_TOKEN_LOCALE = 'en';

export const formatCompactTokenCount = (value: number | bigint) =>
  new Intl.NumberFormat(COMPACT_TOKEN_LOCALE, {
    maximumFractionDigits: 1,
    notation: 'compact',
  }).format(value);

export const formatExactTokenCount = (value: number | bigint, locale: string) =>
  new Intl.NumberFormat(locale).format(value);
