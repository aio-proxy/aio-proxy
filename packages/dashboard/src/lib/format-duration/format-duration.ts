import { getLocale } from '@aio-proxy/i18n';

const durationUnits = [
  [86_400_000, 'd'],
  [3_600_000, 'h'],
  [60_000, 'min'],
  [1_000, 's'],
] as const;

export const formatDuration = (milliseconds: number, locale: string = getLocale()) => {
  const [scale, unit] = durationUnits.find(([threshold]) => milliseconds >= threshold) ?? [1, 'ms'];
  const value = new Intl.NumberFormat(locale, { maximumFractionDigits: scale === 1 ? 3 : 2 }).format(
    milliseconds / scale,
  );
  return `${value} ${unit}`;
};
