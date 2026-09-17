export interface WaterfallTick {
  readonly ratio: number;
  readonly durationMs: number;
}

const ratios = [0, 0.25, 0.5, 0.75, 1] as const;

export const createWaterfallTicks = (totalDurationMs: number): readonly WaterfallTick[] => {
  const total = Math.max(0, totalDurationMs);
  return ratios.map((ratio) => ({ ratio, durationMs: total * ratio }));
};
