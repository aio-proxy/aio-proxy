import { clamp } from 'es-toolkit/math';

export type LiveMetrics = {
  readonly requestStarted: () => void;
  readonly requestFinished: () => void;
  readonly recordContent: (modelKey: string, chars: number) => void;
  readonly calibrate: (modelKey: string, chars: number, outputTokens: number) => void;
  readonly snapshot: () => { readonly inFlight: number; readonly outputTokensPerSecond: number };
};

const WINDOW_SECONDS = 3;
const DEFAULT_CHARS_PER_TOKEN = 4;
const CALIBRATION_ALPHA = 0.3;
const MAX_CALIBRATED_MODELS = 256;

export function codePointLength(text: string): number {
  let length = 0;
  for (const _codePoint of text) length += 1;
  return length;
}

export const liveModelKey = (providerId: string, modelId: string) => `${providerId}/${modelId}`;

export function createLiveMetrics(options?: { readonly now?: () => number }): LiveMetrics {
  const now = options?.now ?? Date.now;
  const buckets = new Map<number, Map<string, number>>();
  const ratios = new Map<string, number>();
  let inFlight = 0;

  const currentSecond = (): number => {
    const second = Math.floor(now() / 1_000);
    for (const bucketSecond of buckets.keys()) {
      if (bucketSecond < second - WINDOW_SECONDS) buckets.delete(bucketSecond);
    }
    return second;
  };

  return {
    requestStarted: () => {
      inFlight += 1;
    },
    requestFinished: () => {
      inFlight = Math.max(0, inFlight - 1);
    },
    recordContent: (modelKey, chars) => {
      const second = currentSecond();
      let bucket = buckets.get(second);
      if (bucket === undefined) {
        bucket = new Map();
        buckets.set(second, bucket);
      }
      bucket.set(modelKey, (bucket.get(modelKey) ?? 0) + chars);
    },
    calibrate: (modelKey, chars, outputTokens) => {
      if (chars === 0 || outputTokens === 0) return;
      const previous = ratios.get(modelKey) ?? DEFAULT_CHARS_PER_TOKEN;
      const ratio = clamp(previous + CALIBRATION_ALPHA * (chars / outputTokens - previous), 0.5, 10);
      // Eviction follows the last calibration update, rather than throughput reads.
      ratios.delete(modelKey);
      ratios.set(modelKey, ratio);
      if (ratios.size > MAX_CALIBRATED_MODELS) ratios.delete(ratios.keys().next().value!);
    },
    snapshot: () => {
      const second = currentSecond();
      let outputTokens = 0;
      for (const [bucketSecond, bucket] of buckets) {
        // Only completed seconds contribute, so polling within a second stays stable.
        if (bucketSecond >= second) continue;
        for (const [modelKey, chars] of bucket) {
          outputTokens += chars / (ratios.get(modelKey) ?? DEFAULT_CHARS_PER_TOKEN);
        }
      }
      return { inFlight, outputTokensPerSecond: outputTokens / WINDOW_SECONDS };
    },
  };
}
