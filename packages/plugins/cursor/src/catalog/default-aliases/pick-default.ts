import { isEmptyWhen, type PeeledWhen } from './peel';

export type PeeledVariant = {
  readonly slug: string;
  readonly isDefaultNonMax?: boolean;
  readonly when: PeeledWhen;
};

const EFFORT_RANK: Readonly<Record<string, number>> = {
  medium: 0,
  high: 1,
  low: 2,
  max: 3,
  xhigh: 4,
  none: 5,
  minimal: 6,
};

const MISSING_EFFORT_RANK = 99;

// Compared component-by-component rather than summed so a neutral slug always
// outranks a thinking or fast one: the empty-`when` default must still be
// reachable from an explicit `thinking: false` / `speed: "standard"` request.
function score(variant: PeeledVariant): readonly [number, number, number, string] {
  return [
    variant.when.thinking === true ? 1 : 0,
    variant.when.speed === 'fast' ? 1 : 0,
    variant.when.effort === undefined ? MISSING_EFFORT_RANK : (EFFORT_RANK[variant.when.effort] ?? MISSING_EFFORT_RANK),
    variant.slug,
  ];
}

function leastExtreme(variants: readonly PeeledVariant[]): PeeledVariant | undefined {
  let winner: PeeledVariant | undefined;
  let winning: readonly [number, number, number, string] | undefined;
  for (const variant of variants) {
    const candidate = score(variant);
    if (winning === undefined || compareScores(candidate, winning) < 0) {
      winner = variant;
      winning = candidate;
    }
  }
  return winner;
}

function compareScores(
  left: readonly [number, number, number, string],
  right: readonly [number, number, number, string],
): number {
  if (left[0] !== right[0]) return left[0] - right[0];
  if (left[1] !== right[1]) return left[1] - right[1];
  if (left[2] !== right[2]) return left[2] - right[2];
  return left[3].localeCompare(right[3]);
}

function isNeutral(when: PeeledWhen): boolean {
  return when.thinking !== true && when.speed !== 'fast';
}

export function pickDefaultModel(familyName: string, variants: readonly PeeledVariant[], pinDefault?: string): string {
  if (pinDefault !== undefined && variants.some((variant) => variant.slug === pinDefault)) return pinDefault;
  const bare = variants.find((variant) => variant.slug === familyName && isEmptyWhen(variant.when));
  if (bare !== undefined) return bare.slug;
  const flagged = leastExtreme(
    variants.filter((variant) => variant.isDefaultNonMax === true && isNeutral(variant.when)),
  );
  if (flagged !== undefined) return flagged.slug;
  return leastExtreme(variants)!.slug;
}
