import { getLocale } from '@aio-proxy/i18n';

const durationUnits = [
  [1, 'millisecond'],
  [1_000, 'second'],
  [60_000, 'minute'],
  [3_600_000, 'hour'],
  [86_400_000, 'day'],
] as const;

export const formatDuration = (milliseconds: number, locale: string = getLocale()) => {
  let selected: (typeof durationUnits)[number] = durationUnits[0];
  for (const next of durationUnits.slice(1)) {
    const roundingStep = selected[0] / (selected[0] === 1 ? 1_000 : 100);
    // Promote before rounding would overflow the current unit (for example, 59.995 seconds).
    if (milliseconds < next[0] - roundingStep / 2) break;
    selected = next;
  }
  const [scale, unit] = selected;
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: scale === 1 ? 3 : 2,
  }).format(milliseconds / scale);
};
