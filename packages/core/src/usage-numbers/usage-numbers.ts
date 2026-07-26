export const COST_SCALE = 1_000_000_000;

export function usdToNanoUsd(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError('USD cost must be finite and non-negative');
  const nanoUsd = Math.round(value * COST_SCALE);
  if (!Number.isSafeInteger(nanoUsd)) throw new RangeError('Nano-USD cost exceeds the safe integer range');
  return nanoUsd;
}

export function nanoUsdToUsd(value: number | bigint): number {
  return Number(value) / COST_SCALE;
}

export function parseSqliteInteger(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new TypeError('SQLite integer must be non-negative decimal text');
  return BigInt(value);
}
