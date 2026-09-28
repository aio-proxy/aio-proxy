/** The chart key of the `index`th Provider series. Never an authored ID, so it cannot collide with `bucket`. */
export const routingTrafficSeriesKey = (index: number): string => `s${index}`;

/**
 * One chart row per time bucket: the bucket key under `bucket`, and each Provider's count under its
 * series key. Keying counts by Provider ID instead would let a Provider named `bucket` overwrite the
 * timestamp the axis and tooltip format.
 */
export const routingTrafficChartRows = (
  providerIds: readonly string[],
  buckets: readonly { readonly key: string; readonly values: Readonly<Record<string, bigint>> }[],
): Record<string, string | number>[] =>
  buckets.map((bucket) => ({
    bucket: bucket.key,
    // Display-only: bucket counts stay well below MAX_SAFE_INTEGER, so Number() is exact for the chart.
    ...Object.fromEntries(
      providerIds.map((providerId, index) => [routingTrafficSeriesKey(index), Number(bucket.values[providerId] ?? 0n)]),
    ),
  }));
