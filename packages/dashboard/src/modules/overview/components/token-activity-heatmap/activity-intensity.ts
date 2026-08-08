import { percentile } from 'es-toolkit/bigint';

export type ActivityIntensity = 0 | 1 | 2 | 3 | 4;

export const activityIntensityLevels = (totals: readonly bigint[]) => {
  const positives = totals.filter((total) => total > 0n);
  if (positives.length === 0) return totals.map((): ActivityIntensity => 0);

  const p50 = percentile(positives, 50);
  const p75 = percentile(positives, 75);
  const p90 = percentile(positives, 90);
  return totals.map((total): ActivityIntensity => {
    if (total === 0n) return 0;
    if (total >= p90) return 4;
    if (total >= p75) return 3;
    if (total >= p50) return 2;
    return 1;
  });
};
