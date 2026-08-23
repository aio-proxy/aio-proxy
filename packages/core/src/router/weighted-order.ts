export type WeightedCandidate = {
  readonly routing: {
    readonly priority: number;
    readonly weight: number;
    readonly configurationIndex: number;
  };
};

export function orderWeightedCandidates<T extends WeightedCandidate>(
  candidates: readonly T[],
  draw: (priority: number, drawIndex: number) => number,
): readonly T[] {
  const tiers = new Map<number, T[]>();
  for (const candidate of candidates) {
    const tier = tiers.get(candidate.routing.priority) ?? [];
    tier.push(candidate);
    tiers.set(candidate.routing.priority, tier);
  }

  const ordered: T[] = [];
  for (const priority of [...tiers.keys()].sort((left, right) => right - left)) {
    const remaining = [...tiers.get(priority)!];
    for (let drawIndex = 0; remaining.length > 0; drawIndex++) {
      const total = remaining.reduce((sum, candidate) => sum + candidate.routing.weight, 0);
      let target = Math.min(draw(priority, drawIndex), 1 - Number.EPSILON) * total;
      let selected = remaining.length - 1;
      for (const [index, candidate] of remaining.entries()) {
        if (target < candidate.routing.weight) {
          selected = index;
          break;
        }
        target -= candidate.routing.weight;
      }
      ordered.push(remaining.splice(selected, 1)[0]!);
    }
  }
  return ordered;
}
