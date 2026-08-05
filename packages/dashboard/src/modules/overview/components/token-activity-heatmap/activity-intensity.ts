const quantile = (values: readonly bigint[], percentile: number) => {
  const index = Math.floor((values.length - 1) * percentile);
  return values[index] ?? 0n;
};

export const activityIntensityLevels = (totals: readonly bigint[]) => {
  const positives = totals
    .filter((total) => total > 0n)
    .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (positives.length === 0) return totals.map(() => 0);

  const p50 = quantile(positives, 0.5);
  const p75 = quantile(positives, 0.75);
  const p90 = quantile(positives, 0.9);
  return totals.map((total) => {
    if (total === 0n) return 0;
    if (total >= p90) return 4;
    if (total >= p75) return 3;
    if (total >= p50) return 2;
    return 1;
  });
};
