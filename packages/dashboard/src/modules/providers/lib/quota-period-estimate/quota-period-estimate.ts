const CONSUMED_SCALE = 1_000_000n;
const APPROXIMATE_CONSUMED = 0.1;

const consumedScale = (remainingRatio: number): bigint | undefined => {
  if (!Number.isFinite(remainingRatio)) return undefined;
  const scaled = BigInt(Math.round((1 - remainingRatio) * Number(CONSUMED_SCALE)));
  return scaled > 0n ? scaled : undefined;
};

/** Inverse of remaining ratio: used / consumed. Missing when the window has not been spent. */
export const estimateQuotaPeriodNanoUsd = (usedNanoUsd: bigint, remainingRatio: number): bigint | undefined => {
  const consumed = consumedScale(remainingRatio);
  if (consumed === undefined) return undefined;
  return (usedNanoUsd * CONSUMED_SCALE + consumed / 2n) / consumed;
};

export const quotaPeriodEstimateIsApproximate = (remainingRatio: number): boolean => {
  const consumed = consumedScale(remainingRatio);
  return consumed !== undefined && Number(consumed) / Number(CONSUMED_SCALE) < APPROXIMATE_CONSUMED;
};
