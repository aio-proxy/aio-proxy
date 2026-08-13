import type { AliasConfig, AliasTarget } from '../common';

export const EFFORT_SPELLING: Readonly<Record<string, string>> = {
  'x-high': 'xhigh',
  x_high: 'xhigh',
  extrahigh: 'xhigh',
};

export function foldEffortSpelling(lowercased: string): string {
  return EFFORT_SPELLING[lowercased] ?? lowercased;
}

export function canonicalEffort(value: string): string {
  return foldEffortSpelling(value.trim().toLowerCase());
}

export type AliasSpeed = 'flex' | 'standard' | 'fast';
export type AliasWhen = {
  readonly effort?: string;
  readonly thinking?: boolean;
  readonly speed?: AliasSpeed;
};
export type AliasSelectRow = {
  readonly when: AliasWhen;
  readonly model: string;
  readonly preserve: boolean;
};
export type AliasDimensions = {
  readonly effort?: string;
  readonly thinking?: boolean;
  readonly speed?: AliasSpeed;
};

const WHEN_KEYS = ['thinking', 'effort', 'speed'] as const;

export function isAliasVariantSelect(variants: unknown): variants is readonly AliasSelectRow[] {
  return Array.isArray(variants);
}

export function isAliasVariantsObject(variants: unknown): variants is Readonly<Record<string, AliasTarget>> {
  return variants !== undefined && variants !== null && typeof variants === 'object' && !Array.isArray(variants);
}

function canonicalizeSpeed(value: string): AliasSpeed | undefined {
  const speed = value.trim().toLowerCase();
  return speed === 'flex' || speed === 'standard' || speed === 'fast' ? speed : undefined;
}

function canonicalizeWhen(when: AliasWhen): AliasWhen {
  return {
    ...(when.thinking === undefined ? {} : { thinking: when.thinking }),
    ...(when.effort === undefined ? {} : { effort: canonicalEffort(when.effort) }),
    ...(when.speed === undefined
      ? {}
      : (() => {
          const speed = canonicalizeSpeed(when.speed);
          return speed === undefined ? {} : { speed };
        })()),
  };
}

function canonicalizeDimensions(dimensions: AliasDimensions): AliasDimensions {
  return canonicalizeWhen(dimensions);
}

export function flattenAliasVariants(
  variants: AliasConfig['variants'] | readonly AliasSelectRow[] | Readonly<Record<string, AliasTarget>> | undefined,
): readonly AliasSelectRow[] {
  if (variants === undefined) return [];
  if (Array.isArray(variants)) {
    return variants.map((row) => ({
      when: canonicalizeWhen(row.when),
      model: row.model,
      preserve: row.preserve ?? false,
    }));
  }
  return Object.entries(variants).map(([key, target]) => ({
    when: { effort: canonicalEffort(key) },
    model: target.model,
    preserve: target.preserve,
  }));
}

function specifiedKeys(when: AliasWhen): ReadonlySet<(typeof WHEN_KEYS)[number]> {
  const keys = new Set<(typeof WHEN_KEYS)[number]>();
  for (const key of WHEN_KEYS) {
    if (when[key] !== undefined) keys.add(key);
  }
  return keys;
}

function rowMatches(when: AliasWhen, bag: AliasDimensions): boolean {
  for (const key of WHEN_KEYS) {
    const expected = when[key];
    if (expected === undefined) continue;
    if (bag[key] !== expected) return false;
  }
  return true;
}

function isStrictSubset(inner: AliasWhen, outer: AliasWhen): boolean {
  const innerKeys = specifiedKeys(inner);
  const outerKeys = specifiedKeys(outer);
  if (innerKeys.size >= outerKeys.size) return false;
  for (const key of innerKeys) {
    if (!outerKeys.has(key)) return false;
  }
  return true;
}

function rank(when: AliasWhen): number {
  return (
    (when.thinking === undefined ? 0 : 4) + (when.effort === undefined ? 0 : 2) + (when.speed === undefined ? 0 : 1)
  );
}

export function matchAliasRows(
  rows: readonly AliasSelectRow[],
  dimensions: AliasDimensions,
  fallback: AliasTarget,
): AliasTarget {
  const bag = canonicalizeDimensions(dimensions);
  const matches = rows.filter((row) => rowMatches(row.when, bag));
  if (matches.length === 0) return fallback;
  const maximal = matches.filter(
    (row) => !matches.some((other) => other !== row && isStrictSubset(row.when, other.when)),
  );
  let winner = maximal[0]!;
  for (const row of maximal.slice(1)) {
    if (rank(row.when) > rank(winner.when)) winner = row;
  }
  return { model: winner.model, preserve: winner.preserve };
}

export function resolveAliasTargetFromConfig(config: AliasConfig, dimensions: AliasDimensions = {}): AliasTarget {
  return matchAliasRows(flattenAliasVariants(config.variants), dimensions, {
    model: config.model,
    preserve: config.preserve,
  });
}
